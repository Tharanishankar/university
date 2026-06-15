import { getNextQueueItem, markQueueDone, markQueueFailed, markQueueNeedsRetry,
  upsertUniversity, upsertTuitionFee,
  upsertAdmissionRequirement, upsertEntranceTest, supabase } from '../supabase.js';
import { enrichUniversity } from '../perplexity.js';
import { fetchAndExtractPrograms } from '../utils/regexCrawler.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { requeueStuckItems } from '../utils/queue.js';

const GENERIC_NAMES = new Set([
  'engineering', 'science', 'arts', 'commerce', 'management',
  'ug courses', 'pg courses', 'under graduate', 'post graduate',
  'ug programs', 'pg programs', 'various', 'multiple',
  'undergraduate', 'postgraduate', 'programs', 'courses',
  'studies', 'sciences', 'humanities',
]);

const DEFAULT_CURRENCY = { Germany: 'EUR', UK: 'GBP' };

function isValidProgramName(name) {
  if (!name || name.length < 8) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  if (name.split(' ').length < 2) return false;
  return true;
}

async function insertFailedUniversity(name, state, country, reason) {
  try {
    await upsertUniversity({
      name,
      country,
      state,
      is_active: false,
      crawl_status: 'failed',
      notes: reason,
      last_verified: new Date().toISOString(),
    });
  } catch (e) {
    logger.warn('Could not insert failed university record', { name, error: e.message });
  }
}

export async function runEnricher() {
  const country = config.crawler.country;
  const defaultCurrency = DEFAULT_CURRENCY[country] || 'EUR';

  logger.info('Enricher v2 started', { country });
  await requeueStuckItems();

  let processedCount = 0;

  while (true) {
    if (config.crawler.testMode && processedCount >= config.crawler.testLimit) {
      logger.info('Test mode limit reached', { processed: processedCount });
      break;
    }

    const item = await getNextQueueItem('enricher');

    if (!item) {
      logger.info('Queue empty — waiting 60 seconds');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    // Prefer country from queue metadata, fall back to config
    const itemCountry = JSON.parse(item.metadata || '{}').country || country;

    logger.info('Enriching university', { name: item.university_name, state: item.state, country: itemCountry });

    try {
      // Step 1 — Perplexity enrichment
      const enriched = await enrichUniversity(item.university_name, item.state, itemCountry);

      if (!enriched) {
        const reason = 'No response from Perplexity';
        await markQueueFailed(item.id, reason);
        await insertFailedUniversity(item.university_name, item.state, itemCountry, reason);
        logger.warn('Perplexity returned null', { name: item.university_name });
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      if (!enriched.is_active) {
        const reason = 'Institution not found or no longer active';
        await markQueueFailed(item.id, reason);
        await insertFailedUniversity(item.university_name, item.state, itemCountry, reason);
        logger.warn('Institution marked not active', { name: item.university_name });
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      if (!enriched.official_website) {
        const reason = 'No official website found';
        await markQueueFailed(item.id, reason);
        await insertFailedUniversity(item.university_name, item.state, itemCountry, reason);
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      // Step 2 — Insert university
      const university = await upsertUniversity({
        name: item.university_name,
        country: itemCountry,
        state: item.state,
        city: enriched.city,
        type: enriched.university_type,
        website: enriched.official_website,
        accreditation_body: enriched.accreditation_body,
        naac_grade: enriched.accreditation_status || enriched.tef_rating || enriched.naac_grade || null,
        institution_type: enriched.institution_type,
        affiliated_to: enriched.affiliated_to,
        apply_through: enriched.apply_through,
        can_apply_directly: enriched.can_apply_directly,
        is_active: true,
        crawl_status: 'done',
        notes: null,
        last_verified: new Date().toISOString(),
      });

      // Step 3 — Insert campuses
      const campusMap = new Map();
      if (enriched.campuses && enriched.campuses.length > 0) {
        for (const campus of enriched.campuses) {
          try {
            const { data: campusData } = await supabase
              .from('campuses')
              .upsert({
                university_id: university.id,
                name: `${item.university_name} - ${campus.city}`,
                city: campus.city,
                state: campus.state || item.state,
                country: itemCountry,
                is_main_campus: campus.is_main_campus,
                website: campus.website,
              }, { onConflict: 'university_id,city,country' })
              .select()
              .single();
            if (campusData) campusMap.set(campus.city, campusData.id);
          } catch (e) {
            logger.warn('Campus insert failed', { campus: campus.city, error: e.message });
          }
        }
      }

      // Step 4 — Insert programs from Perplexity
      const programMap = new Map();
      const perplexityPrograms = (enriched.programs || []).filter(p => isValidProgramName(p.name));

      for (const program of perplexityPrograms) {
        try {
          const campusId = program.campus_city ? campusMap.get(program.campus_city) : null;
          const { data: progData } = await supabase
            .from('programs')
            .upsert({
              university_id: university.id,
              campus_id: campusId,
              name: program.name,
              degree_level: program.degree_level,
              field_of_study: program.field_of_study,
              duration_years: program.duration_years,
              delivery_mode: 'campus',
              language_of_instruction: program.language || enriched.language_of_instruction || 'English',
              is_active: true,
            }, { onConflict: 'university_id,name,degree_level' })
            .select()
            .single();
          if (progData) programMap.set(program.name, progData.id);
        } catch (e) {
          continue;
        }
      }

      // Step 5 — Regex crawl for additional programs
      const regexPrograms = await fetchAndExtractPrograms(enriched.official_website, itemCountry);
      let regexAdded = 0;

      for (const program of regexPrograms) {
        if (!isValidProgramName(program.name)) continue;
        if (programMap.has(program.name)) continue;

        try {
          const { data: progData } = await supabase
            .from('programs')
            .upsert({
              university_id: university.id,
              name: program.name,
              degree_level: program.degree_level,
              field_of_study: program.field_of_study,
              duration_years: null,
              delivery_mode: 'campus',
              is_active: true,
            }, { onConflict: 'university_id,name,degree_level' })
            .select()
            .single();
          if (progData) {
            programMap.set(program.name, progData.id);
            regexAdded++;
          }
        } catch (e) {
          continue;
        }
      }

      // Step 6 — Insert fees
      for (const fee of enriched.tuition_fees || []) {
        const targetPrograms = fee.program_name === 'ALL'
          ? Array.from(programMap.values())
          : [programMap.get(fee.program_name)].filter(Boolean);

        for (const programId of targetPrograms) {
          try {
            await upsertTuitionFee({
              program_id: programId,
              student_category: fee.student_category,
              annual_fee: fee.annual_fee,
              currency: fee.currency || defaultCurrency,
              academic_year: fee.academic_year || '2024-25',
            });
          } catch (e) { continue; }
        }
      }

      // Step 7 — Insert entrance tests
      for (const test of enriched.entrance_tests || []) {
        const targetPrograms = test.applicable_programs === 'ALL'
          ? Array.from(programMap.values())
          : [programMap.get(test.applicable_programs)].filter(Boolean);

        for (const programId of targetPrograms) {
          try {
            await upsertEntranceTest({
              program_id: programId,
              test_name: test.test_name,
              test_region: 'national',
              min_score: test.min_score,
              is_mandatory: test.is_mandatory,
              notes: test.notes,
            });
          } catch (e) { continue; }
        }
      }

      // Step 8 — Insert admission requirements
      for (const req of enriched.admission_requirements || []) {
        const targetPrograms = req.program_name === 'ALL'
          ? Array.from(programMap.values())
          : [programMap.get(req.program_name)].filter(Boolean);

        for (const programId of targetPrograms) {
          try {
            await upsertAdmissionRequirement({
              program_id: programId,
              requirement_type: 'subject_group',
              subject_group: req.subject_group,
              min_percentage: req.min_percentage,
              notes: req.notes,
            });
          } catch (e) { continue; }
        }
      }

      // Step 9 — Insert intake stats
      if (enriched.intake_stats?.total_seats) {
        for (const programId of programMap.values()) {
          try {
            await supabase.from('intake_stats').upsert({
              program_id: programId,
              academic_year: enriched.intake_stats.academic_year || '2024-25',
              total_seats: enriched.intake_stats.total_seats,
            }, { onConflict: 'program_id,academic_year' });
          } catch (e) { continue; }
        }
      }

      await markQueueDone(item.id);
      processedCount++;

      logger.success('University enriched', {
        name: item.university_name,
        country: itemCountry,
        programs: programMap.size,
        regexAdded,
        campuses: campusMap.size,
        fees: enriched.tuition_fees?.length || 0,
      });

    } catch (error) {
      logger.error('Enrichment failed', { name: item.university_name, error: error.message });
      await markQueueNeedsRetry(item.id, (item.retry_count || 0) + 1);
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }
}

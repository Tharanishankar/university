// src/workers/enricher_v3.js
import { getNextQueueItem, markQueueDone, markQueueFailed, markQueueNeedsRetry,
  upsertUniversity, upsertTuitionFee,
  upsertAdmissionRequirement, upsertEntranceTest, supabase } from '../supabase.js';
import { enrichUniversity } from '../perplexity_v3.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { requeueStuckItems } from '../utils/queue.js';
import { isNonUniversity } from '../utils/nonUniversityPatterns.js';
import { isVague, findPeerFee, findPeerAdmissionRequirement } from '../utils/peerFallback.js';

const GENERIC_NAMES = new Set([
  'engineering', 'science', 'arts', 'commerce', 'management',
  'ug courses', 'pg courses', 'under graduate', 'post graduate',
  'undergraduate', 'postgraduate', 'programs', 'courses',
  'studies', 'sciences', 'humanities',
]);

const DEFAULT_CURRENCY = { Germany: 'EUR', 'United Kingdom': 'GBP', USA: 'USD', India: 'INR', Canada: 'CAD', Australia: 'AUD' };

function isValidProgramName(name) {
  if (!name || name.length < 8) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  if (name.split(' ').length < 2) return false;
  return true;
}

async function markUniversityRejected(name, country, state, reason, validationStatus) {
  try {
    await upsertUniversity({
      name,
      country,
      state,
      is_active: false,
      crawl_status: 'rejected',
      validation_status: validationStatus,
      notes: reason,
      last_verified: new Date().toISOString(),
    });
  } catch (e) {
    logger.warn('Could not record rejected university', { name, error: e.message });
  }
}

export async function runEnricherV3() {
  const country = config.crawler.country;
  const defaultCurrency = DEFAULT_CURRENCY[country] || 'EUR';

  logger.info('Enricher v3 started', { country });
  await requeueStuckItems();

  let processedCount = 0;

  while (true) {
    if (config.crawler.testMode && processedCount >= config.crawler.testLimit) {
      logger.info('Test mode limit reached', { processed: processedCount });
      break;
    }

    const item = await getNextQueueItem('enricher_v3');

    if (!item) {
      logger.info('Queue empty — waiting 60 seconds');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const metadata = JSON.parse(item.metadata || '{}');
    const itemCountry = metadata.country || country;
    const seedCity = metadata.city || null;

    logger.info('Enriching', { name: item.university_name, state: item.state, country: itemCountry });

    // Belt-and-suspenders: re-check noise filter at enricher time
    if (isNonUniversity(item.university_name)) {
      const reason = 'Matched non-university pattern at enricher stage';
      await markQueueFailed(item.id, reason);
      await markUniversityRejected(item.university_name, itemCountry, item.state, reason, 'rejected_pattern');
      continue;
    }

    try {
      const enriched = await enrichUniversity(item.university_name, item.state, itemCountry);

      // Handle missing response
      if (!enriched) {
        await markQueueFailed(item.id, 'No response from Perplexity');
        await markUniversityRejected(
          item.university_name, itemCountry, item.state,
          'No response from Perplexity', 'rejected_perplexity'
        );
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      // Stage 2 validation — Perplexity says it's not a real uni
      if (enriched.is_valid_university === false) {
        const reason = `Perplexity validation: ${enriched.reason || 'not a degree-awarding institution'}`;
        await markQueueFailed(item.id, reason);
        await markUniversityRejected(
          item.university_name, itemCountry, item.state,
          reason, 'rejected_perplexity'
        );
        logger.warn('Rejected by Perplexity validation', { name: item.university_name, reason: enriched.reason });
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      if (!enriched.official_website) {
        const reason = 'No official website found';
        await markQueueFailed(item.id, reason);
        await markUniversityRejected(item.university_name, itemCountry, item.state, reason, 'rejected_perplexity');
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      // Insert university with tier
      const universityData = {
        name: item.university_name,
        country: itemCountry,
        state: item.state,
        city: enriched.city || seedCity,
        type: enriched.university_type,
        website: enriched.official_website,
        accreditation_body: enriched.accreditation_body,
        naac_grade: enriched.accreditation_status || enriched.tef_rating || null,
        institution_type: enriched.institution_type,
        global_tier: enriched.global_tier || null,
        affiliated_to: enriched.affiliated_to,
        apply_through: enriched.apply_through,
        can_apply_directly: enriched.can_apply_directly,
        is_active: true,
        crawl_status: 'done',
        validation_status: 'validated',
        wikipedia_summary: metadata.wikipedia_summary || null,
        notes: enriched.tier_reasoning || null,
        last_verified: new Date().toISOString(),
      };

      const university = await upsertUniversity(universityData);

      // Insert campuses
      const campusMap = new Map();
      if (enriched.campuses?.length > 0) {
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

      // Insert programs
      const programMap = new Map();
      const validPrograms = (enriched.programs || []).filter(p => isValidProgramName(p.name));

      for (const program of validPrograms) {
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
              program_url: program.program_url || null,
              is_active: true,
            }, { onConflict: 'university_id,name,degree_level' })
            .select()
            .single();
          if (progData) programMap.set(program.name, progData.id);
        } catch (e) { continue; }
      }

      // Insert fees (with vague filter + peer fallback)
      let feesInserted = 0;
      let feesFromPeer = 0;
      for (const fee of enriched.tuition_fees || []) {
        // Skip vague fees, try peer fallback
        if (fee.annual_fee === null || isVague(fee.annual_fee)) {
          const peer = await findPeerFee(
            itemCountry,
            enriched.global_tier,
            validPrograms[0]?.field_of_study,
            fee.student_category
          );
          if (peer) {
            const targetPrograms = fee.program_name === 'ALL'
              ? Array.from(programMap.values())
              : [programMap.get(fee.program_name)].filter(Boolean);
            for (const programId of targetPrograms) {
              try {
                await upsertTuitionFee({
                  program_id: programId,
                  student_category: fee.student_category,
                  annual_fee: peer.annual_fee,
                  currency: peer.currency,
                  academic_year: peer.academic_year,
                  is_estimated: true,
                  source: 'peer_fallback',
                });
                feesFromPeer++;
              } catch (e) { continue; }
            }
          }
          continue;
        }

        // Real fee data
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
              is_estimated: false,
              source: 'perplexity',
            });
            feesInserted++;
          } catch (e) { continue; }
        }
      }

      // Insert entrance tests
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

      // Insert admission requirements (with vague filter + peer fallback)
      let admissionsFromPeer = 0;
      for (const req of enriched.admission_requirements || []) {
        if (req.min_percentage === null) {
          const peer = await findPeerAdmissionRequirement(
            itemCountry,
            enriched.global_tier,
            validPrograms[0]?.field_of_study
          );
          if (peer) {
            const targetPrograms = req.program_name === 'ALL'
              ? Array.from(programMap.values())
              : [programMap.get(req.program_name)].filter(Boolean);
            for (const programId of targetPrograms) {
              try {
                await upsertAdmissionRequirement({
                  program_id: programId,
                  requirement_type: 'subject_group',
                  subject_group: peer.subject_group,
                  min_percentage: peer.min_percentage,
                  notes: peer.notes,
                });
                admissionsFromPeer++;
              } catch (e) { continue; }
            }
          }
          continue;
        }

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

      // Insert intake stats
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

      logger.success('Enriched', {
        name: item.university_name,
        country: itemCountry,
        tier: enriched.global_tier,
        programs: programMap.size,
        feesReal: feesInserted,
        feesFromPeer,
        admissionsFromPeer,
      });

    } catch (error) {
      logger.error('Enrichment failed', { name: item.university_name, error: error.message });
      await markQueueNeedsRetry(item.id, (item.retry_count || 0) + 1);
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }
}

// src/workers/programBackfill_v3.js
//
// Re-enriches universities that have 0 programs in the programs table.
// Calls enrichUniversity() and inserts only programs — does NOT touch
// any other fields on the university record.

import { supabase, upsertTuitionFee, upsertEntranceTest, upsertAdmissionRequirement } from '../supabase.js';
import { enrichUniversity } from '../perplexity_v3.js';
import { isVague } from '../utils/peerFallback.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const DEFAULT_CURRENCY = { Germany: 'EUR', 'United Kingdom': 'GBP', USA: 'USD', India: 'INR', Canada: 'CAD', Australia: 'AUD' };

const GENERIC_NAMES = new Set([
  'engineering', 'science', 'arts', 'commerce', 'management',
  'ug courses', 'pg courses', 'under graduate', 'post graduate',
  'undergraduate', 'postgraduate', 'programs', 'courses',
  'studies', 'sciences', 'humanities',
]);

function isValidProgramName(name) {
  if (!name || name.length < 8) return false;
  if (GENERIC_NAMES.has(name.toLowerCase().trim())) return false;
  if (name.split(' ').length < 2) return false;
  return true;
}

/**
 * Fetch universities for the country that have zero programs.
 * Uses an embedded left join on programs, then filters client-side
 * to those with no related program rows.
 */
async function getUniversitiesWithNoPrograms(country) {
  const { data, error } = await supabase
    .from('universities')
    .select('id, name, state, global_tier, programs!left(id)')
    .eq('country', country)
    .eq('is_active', true);

  if (error) {
    logger.error('Failed to fetch universities', { error: error.message });
    return [];
  }

  // Keep only those with empty programs array, sort by tier asc nulls last, then name asc
  const filtered = (data || [])
    .filter(u => !u.programs || u.programs.length === 0)
    .sort((a, b) => {
      const ta = a.global_tier ?? 999;
      const tb = b.global_tier ?? 999;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });

  return filtered;
}

export async function runProgramBackfillV3() {
  const country = config.crawler.country;
  logger.info('Program backfill v3 starting', { country });

  const targets = await getUniversitiesWithNoPrograms(country);

  if (targets.length === 0) {
    logger.info('No universities with zero programs — nothing to backfill', { country });
    return;
  }

  logger.info('Universities needing program backfill', {
    country,
    count: targets.length,
    testMode: config.crawler.testMode,
  });

  const toProcess = config.crawler.testMode ? targets.slice(0, config.crawler.testLimit) : targets;
  let processed = 0;
  let skipped = 0;
  let totalProgramsAdded = 0;

  for (const uni of toProcess) {
    try {
      const enriched = await enrichUniversity(uni.name, uni.state, country);

      if (!enriched) {
        logger.warn('Skipped — no Perplexity response', { name: uni.name });
        skipped++;
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      if (enriched.is_valid_university === false) {
        logger.warn('Skipped — Perplexity says not a valid university', {
          name: uni.name,
          reason: enriched.reason,
        });
        skipped++;
        await new Promise(r => setTimeout(r, config.crawler.delayMs));
        continue;
      }

      const validPrograms = (enriched.programs || []).filter(p => isValidProgramName(p.name));
      const programMap = new Map();
      let inserted = 0;

      for (const program of validPrograms) {
        try {
          const { data: progData } = await supabase
            .from('programs')
            .upsert({
              university_id: uni.id,
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
          if (progData) {
            programMap.set(program.name, progData.id);
            inserted++;
          }
        } catch (e) {
          continue;
        }
      }

      // Insert fees — direct only, skip vague, mark as real Perplexity source
      const defaultCurrency = DEFAULT_CURRENCY[country] || 'EUR';
      let feesInserted = 0;
      for (const fee of enriched.tuition_fees || []) {
        if (fee.annual_fee === null || isVague(fee.annual_fee)) continue;

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
      let testsInserted = 0;
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
            testsInserted++;
          } catch (e) { continue; }
        }
      }

      // Insert admission requirements
      let admissionsInserted = 0;
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
            admissionsInserted++;
          } catch (e) { continue; }
        }
      }

      processed++;
      totalProgramsAdded += inserted;

      logger.success('Programs backfilled', {
        name: uni.name,
        tier: uni.global_tier,
        programs_added: inserted,
        fees_added: feesInserted,
        tests_added: testsInserted,
        admissions_added: admissionsInserted,
      });
    } catch (error) {
      logger.error('Backfill failed for university', { name: uni.name, error: error.message });
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }

  logger.success('Program backfill v3 complete', {
    country,
    processed,
    skipped,
    totalProgramsAdded,
  });
}

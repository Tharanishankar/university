// src/workers/admissionBackfill_v3.js
//
// Re-enriches programs that have zero rows in the admission_requirements
// table. For each program, asks Perplexity for the minimum entry
// requirements for international students. If Perplexity returns null
// or invalid data, falls back to a peer-tier average from other
// universities in the same country / tier / institution_type and
// matching degree-level group (UG vs PG).

import axios from 'axios';
import { supabase, upsertAdmissionRequirement } from '../supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

// Degree level groups for peer matching
const UG_DEGREES = [
  'BA', 'BSc', 'BEng', 'LLB', 'BMus', 'BEd', 'BDS',
  'MBBS', 'MBChB', 'BVM&S', 'BArch', 'BFA', 'BBA',
  'BN', 'BSN', 'Foundation Degree', 'FD', 'FdA', 'FdSc',
];

const PG_DEGREES = [
  'MSc', 'MA', 'MBA', 'PhD', 'MPhil', 'MRes', 'LLM',
  'MEng', 'MEd', 'MArch', 'MFA', 'MMus', 'MTh',
  'MPharm', 'PGDip', 'PGCE', 'MComp', 'MDes', 'MSt',
];

const VOCATIONAL_DEGREES = [
  'HNC', 'HND', 'BTEC', 'T Level', 'T-Level',
  'Access to HE', 'Access', 'Certificate', 'Diploma',
  'Foundation', 'Higher', 'NVQ', 'CertHE', 'Cert HE',
  'Higher Certificate', 'Higher Diploma', 'NC', 'FDip',
];

/**
 * Normalize a degree_level string before matching:
 *  - trim whitespace
 *  - if comma/slash-separated (e.g. "BSc, BA" or "HND/HNC"), take first value
 *  - return null for null/empty input (caller defaults to tier_only match)
 */
function normalizeDegreeLevel(degreeLevel) {
  if (!degreeLevel || typeof degreeLevel !== 'string') return null;
  const first = degreeLevel.split(/[,\/]/)[0].trim();
  return first || null;
}

function getDegreeGroup(degreeLevel) {
  const normalized = normalizeDegreeLevel(degreeLevel);
  if (!normalized) return null;
  if (UG_DEGREES.includes(normalized)) return { key: 'UG', members: UG_DEGREES };
  if (PG_DEGREES.includes(normalized)) return { key: 'PG', members: PG_DEGREES };
  if (VOCATIONAL_DEGREES.includes(normalized)) {
    return { key: 'vocational', members: VOCATIONAL_DEGREES };
  }
  return null;
}

/**
 * Fetch programs for the country whose admission_requirements table is empty.
 * Uses the SQL RPC get_programs_needing_admission for filtering + sorting,
 * which avoids client-side pagination limits and is faster than embedded joins.
 */
async function getProgramsWithNoAdmissions(country) {
  const { data, error } = await supabase
    .rpc('get_programs_needing_admission', { p_country: country });

  if (error) {
    logger.error('RPC get_programs_needing_admission failed', { error: error.message });
    return [];
  }

  // RPC returns flat columns — reshape to the nested form the loop expects
  return (data || []).map(row => ({
    id: row.id,
    name: row.name,
    degree_level: row.degree_level,
    field_of_study: row.field_of_study,
    university: {
      name: row.university_name,
      global_tier: row.global_tier,
      country: row.country,
      institution_type: row.institution_type,
    },
  }));
}

// Cache peer averages by `${country}|${tier}|${institutionType}|${groupKey}`
const peerCache = new Map();

/**
 * Run one peer query with the given filters. Returns array of numeric
 * min_percentage values, or null on query error.
 */
async function queryPeerValues({ country, tier, institutionType, group }) {
  let q = supabase
    .from('admission_requirements')
    .select(`
      min_percentage,
      program:program_id!inner (
        degree_level,
        university:university_id!inner (country, global_tier, institution_type)
      )
    `)
    .eq('is_estimated', false)
    .not('min_percentage', 'is', null)
    .eq('program.university.country', country)
    .eq('program.university.global_tier', tier)
    .limit(500);

  if (institutionType) q = q.eq('program.university.institution_type', institutionType);
  if (group) q = q.in('program.degree_level', group.members);

  const { data, error } = await q;
  if (error) {
    logger.warn('Peer lookup failed', { error: error.message });
    return null;
  }

  return (data || [])
    .map(r => Number(r.min_percentage))
    .filter(n => Number.isFinite(n));
}

function summarize(values, matchLevel) {
  if (!values || values.length === 0) return null;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const rounded = Math.round(avg / 5) * 5;
  return { peer_avg: rounded, sample_size: values.length, match_level: matchLevel };
}

async function findPeerAdmissionAverage(country, tier, institutionType, degreeLevel) {
  if (tier == null) return null;
  const group = getDegreeGroup(degreeLevel);

  const cacheKey = `${country}|${tier}|${institutionType || ''}|${group?.key || ''}`;
  if (peerCache.has(cacheKey)) return peerCache.get(cacheKey);

  // Tier 1: country + global_tier + institution_type + degree_group
  if (institutionType && group) {
    const values = await queryPeerValues({ country, tier, institutionType, group });
    const result = summarize(values, 'tier_inst_group');
    if (result) { peerCache.set(cacheKey, result); return result; }
  }

  // Tier 2: country + global_tier + degree_group (drop institution_type)
  if (group) {
    const values = await queryPeerValues({ country, tier, institutionType: null, group });
    const result = summarize(values, 'tier_group');
    if (result) { peerCache.set(cacheKey, result); return result; }
  }

  // Tier 3: country + global_tier (drop both)
  {
    const values = await queryPeerValues({ country, tier, institutionType: null, group: null });
    const result = summarize(values, 'tier_only');
    if (result) { peerCache.set(cacheKey, result); return result; }
  }

  peerCache.set(cacheKey, null);
  return null;
}

function buildPrompt(programName, degreeLevel, universityName, country) {
  return `For the program '${programName}' (${degreeLevel}) at ${universityName} in ${country}, what are the minimum entry requirements for international students?
Return JSON only:
{
  requirement_type: 'percentage',
  min_percentage: number between 0-100 only.
    If requirements are in UCAS points convert as follows:
    144pts=85%, 128pts=75%, 112pts=65%, 96pts=55%, 80pts=45%
    Never return values above 100.
  subject_group: 'Sciences|Humanities|Engineering|Business|Medicine|Arts|Any',
  notes: 'brief description of actual requirements'
}
Return null if requirements cannot be found.`;
}

async function askPerplexity(prompt) {
  try {
    const response = await axios.post(
      PERPLEXITY_URL,
      {
        model: config.perplexity.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      },
      {
        headers: {
          'Authorization': `Bearer ${config.perplexity.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 45000,
      }
    );

    const content = response.data.choices[0].message.content;
    const clean = content.replace(/```json|```/g, '').trim();

    if (clean.toLowerCase() === 'null') return null;

    try {
      return JSON.parse(clean);
    } catch {
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return null;
    }
  } catch (error) {
    logger.error('Perplexity API error', {
      error: error.message,
      status: error.response?.status,
    });
    return null;
  }
}

/**
 * Attempt peer augmentation for a program. Returns true on success.
 */
async function tryPeerAugmentation(prog, country) {
  const tier = prog.university?.global_tier;
  const institutionType = prog.university?.institution_type;
  const peer = await findPeerAdmissionAverage(country, tier, institutionType, prog.degree_level);

  if (!peer) return false;

  const notes = `Estimated — based on average of similar Tier ${tier} ${country} universities. Actual entry requirements not publicly available. Verify directly with the institution.`;

  await upsertAdmissionRequirement({
    program_id: prog.id,
    requirement_type: 'percentage',
    subject_group: 'Any',
    min_percentage: peer.peer_avg,
    is_estimated: true,
    notes,
  });

  logger.success('Admission requirement backfilled', {
    source: 'peer_augmented',
    match_level: peer.match_level,
    university: prog.university?.name,
    program: prog.name,
    tier,
    min_percentage: peer.peer_avg,
    peer_sample: peer.sample_size,
  });
  return true;
}

export async function runAdmissionBackfillV3() {
  const country = config.crawler.country;
  const peerOnly = process.argv.includes('--peer-only');
  logger.info('Admission backfill v3 starting', { country, peerOnly });

  const targets = await getProgramsWithNoAdmissions(country);

  if (targets.length === 0) {
    logger.info('No programs with zero admission requirements', { country });
    return;
  }

  logger.info('Programs needing admission backfill', {
    country,
    count: targets.length,
    testMode: config.crawler.testMode,
  });

  const toProcess = config.crawler.testMode
    ? targets.slice(0, config.crawler.testLimit)
    : targets;

  let inserted_perplexity = 0;
  let inserted_peer = 0;
  let skipped = 0;

  for (const prog of toProcess) {
    try {
      let result = null;
      let perplexityValid = false;
      let minPct = NaN;

      if (!peerOnly) {
        const prompt = buildPrompt(
          prog.name,
          prog.degree_level,
          prog.university?.name || 'Unknown',
          country
        );
        result = await askPerplexity(prompt);
        minPct = result ? Number(result.min_percentage) : NaN;
        perplexityValid =
          result &&
          Number.isFinite(minPct) &&
          minPct >= 0 &&
          minPct <= 100;
      }

      if (perplexityValid) {
        try {
          await upsertAdmissionRequirement({
            program_id: prog.id,
            requirement_type: result.requirement_type || 'percentage',
            subject_group: result.subject_group || 'Any',
            min_percentage: minPct,
            is_estimated: false,
            notes: result.notes || null,
          });
          inserted_perplexity++;
          logger.success('Admission requirement backfilled', {
            source: 'perplexity',
            university: prog.university?.name,
            program: prog.name,
            tier: prog.university?.global_tier,
            min_percentage: minPct,
          });
        } catch (e) {
          logger.warn('Insert failed (perplexity)', {
            program: prog.name,
            error: e.message,
          });
        }
      } else {
        // Perplexity returned null or invalid — try peer augmentation
        if (result && !perplexityValid) {
          logger.debug('Perplexity returned invalid min_percentage', {
            program: prog.name,
            min_percentage: result.min_percentage,
          });
        }
        const augmented = await tryPeerAugmentation(prog, country);
        if (augmented) {
          inserted_peer++;
        } else {
          logger.warn('Admission requirement backfilled', {
            source: 'skipped',
            program: prog.name,
            university: prog.university?.name,
            reason: 'no perplexity result and no peer match',
          });
          skipped++;
        }
      }
    } catch (error) {
      logger.error('Backfill failed for program', {
        program: prog.name,
        error: error.message,
      });
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }

  logger.success('Admission backfill v3 complete', {
    inserted_perplexity,
    inserted_peer,
    skipped,
    country,
  });
}

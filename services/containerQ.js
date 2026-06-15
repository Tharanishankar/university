'use strict';

const { compareRank } = require('../utils/rankScore');
const supabase        = require('./supabase');

/**
 * Container Q — Candidate Validation, Deduplication, Trimming
 *
 * Three-stage post-scoring pipeline:
 *   1. validateCandidates  — Perplexity ACTIVE/INACTIVE/UNKNOWN per program
 *   2. dedupByUniversity   — max 3 programs per uni, no duplicate program names
 *   3. trimToFinal         — REACH/MATCH split, reachMax cap, UNDERDOG cap
 *
 * Critical rules:
 *   - UNKNOWN is never dropped — treated as ACTIVE
 *   - Retry on timeout/network error only (max 2 retries)
 *   - Soft fail throughout — pipeline never fails here
 *   - Promise.allSettled for parallel validation
 *
 * Caching (program_validation_cache table, 7-day TTL):
 *   - ACTIVE / INACTIVE / STREAM_MISMATCH are cached — confident Perplexity answers
 *   - UNKNOWN is never cached — means Perplexity couldn't determine; retry next time
 *   - Any cache error is treated as a miss — Perplexity called as normal (fail-open)
 */

const PERPLEXITY_KEY    = process.env.PERPLEXITY_API_KEY;
const CACHEABLE_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'STREAM_MISMATCH']);

// ── Cache helpers ────────────────────────────────────────────────────────────

function buildValidationCacheKey(programId, stream) {
  return `${programId}::${String(stream || 'general').toLowerCase().trim()}`;
}

async function getCachedValidation(programId, stream) {
  try {
    const cacheKey = buildValidationCacheKey(programId, stream);
    const { data, error } = await supabase()
      .from('program_validation_cache')
      .select('validation_status')
      .eq('cache_key', cacheKey)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !data?.validation_status) return null;
    return data.validation_status;
  } catch {
    return null; // fail-open — treat as cache miss
  }
}

async function setCachedValidation(programId, universityId, stream, status) {
  try {
    if (!CACHEABLE_STATUSES.has(status)) return; // never cache UNKNOWN
    const cacheKey = buildValidationCacheKey(programId, stream);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days — programs rarely go inactive mid-year

    const { error } = await supabase()
      .from('program_validation_cache')
      .upsert({
        cache_key:         cacheKey,
        program_id:        programId,
        university_id:     universityId || null,
        stream:            String(stream || 'general').toLowerCase().trim(),
        validation_status: status,
        fetched_at:        new Date().toISOString(),
        expires_at:        expiresAt.toISOString(),
      }, { onConflict: 'cache_key' });

    if (error) {
      console.warn(`[containerQ] cache write failed: ${error.message}`);
    }
  } catch {
    // fail-open — cache write failure never affects the result
  }
}

// ── Perplexity single attempt ─────────────────────────────
async function callValidationOnce(universityName, programName, stream) {
  if (!PERPLEXITY_KEY) return 'UNKNOWN';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          messages: [{
            role: 'user',
            content:
              `Answer two questions about the "${programName}" program at "${universityName}":\n` +
              `1. Is this program currently active and accepting new student applications?\n` +
              `   Reply with exactly one word: ACTIVE, INACTIVE, or UNKNOWN.\n` +
              `2. Does this program belong to the "${stream}" field of study or a closely related field?\n` +
              `   Reply with exactly one word: YES, NO, or UNCLEAR.\n` +
              `Format your entire answer as exactly two words separated by a space: [status] [match]\n` +
              `Example: ACTIVE YES`,
          }],
          temperature: 0.0,
        }),
        signal: controller.signal,
      }
    );

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Perplexity HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = (data.choices?.[0]?.message?.content || '')
      .trim().toUpperCase();
    const parts = text.split(/\s+/);
    const status = parts[0] || 'UNKNOWN';
    const match  = parts[1] || 'UNCLEAR';

    if (status === 'INACTIVE') return 'INACTIVE';
    if (match === 'NO') return 'STREAM_MISMATCH';
    if (status === 'ACTIVE') return 'ACTIVE';
    return 'UNKNOWN';

  } catch (err) {
    clearTimeout(timer);
    throw err; // propagate so retry logic fires
  }
}

// ── Per-program validate with retry ─────────────────────
// Retries on network/timeout errors only. Max 2 retries (3 total attempts).
// Returns UNKNOWN on all failures — never drops silently.
async function validateProgram(universityName, programName, stream) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await callValidationOnce(universityName, programName, stream);
    } catch (err) {
      if (attempt === 2) {
        console.warn(
          `[containerQ] validation failed after 3 attempts:` +
          ` ${universityName} — ${programName}. Defaulting UNKNOWN.`
        );
        return 'UNKNOWN';
      }
    }
  }
  return 'UNKNOWN';
}

/**
 * validateCandidates
 * Parallel Perplexity check on all candidates.
 * INACTIVE confirmed → dropped. UNKNOWN → kept.
 *
 * @param {Array} candidates — scored programs to validate
 * @returns {Promise<Array>} validated (non-INACTIVE) candidates
 */
async function validateCandidates(candidates) {
  console.log(`[containerQ] validating ${candidates.length} candidates via Perplexity...`);

  const results = await Promise.allSettled(
    candidates.map(async c => {
      const stream = c.stream || 'general';

      // ── Cache check ──────────────────────────────────────
      const cached = await getCachedValidation(c.programId, stream);
      if (cached) {
        console.log(
          `[containerQ] cache HIT — ${c.universityName} / ${c.programName} (${cached})`
        );
        return { candidate: c, status: cached };
      }

      // ── Cache miss → call Perplexity ─────────────────────
      const status = await validateProgram(c.universityName, c.programName, stream);

      // ── Write to cache (fire-and-forget, fail-open) ──────
      setCachedValidation(c.programId, c.universityId, stream, status);

      return { candidate: c, status };
    })
  );

  const validated = [];
  let droppedCount = 0;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { candidate, status } = r.value;
      if (status === 'INACTIVE' || status === 'STREAM_MISMATCH') {
        droppedCount++;
        console.log(
          `[containerQ] DROPPED — ${candidate.universityName}` +
          ` / ${candidate.programName} (${status})`
        );
      } else {
        candidate._validationStatus = status;
        validated.push(candidate);
      }
    } else {
      // Promise itself rejected — validateProgram should not let this happen
      // but if it does, keep the candidate (fail safe)
      console.warn(
        '[containerQ] unexpected promise rejection — keeping candidate.',
        r.reason
      );
    }
  }

  console.log(
    `[containerQ] validation complete:` +
    ` ${validated.length} kept, ${droppedCount} dropped`
  );
  return validated;
}

/**
 * dedupByUniversity
 * Groups by universityId. Per university:
 *   - Keep top 3 by fitScore
 *   - Remove entries with duplicate program names (case-insensitive)
 *
 * @param {Array} candidates
 * @returns {Array} deduplicated candidates
 */
function dedupByUniversity(candidates) {
  const byUni = new Map();

  for (const c of candidates) {
    const key = c.universityId || c.universityName;
    if (!byUni.has(key)) byUni.set(key, []);
    byUni.get(key).push(c);
  }

  const result = [];

  for (const [, programs] of byUni) {
    const top3 = programs
      .sort((a, b) =>
        b.fitScore - a.fitScore ||
        compareRank(a, b) ||
        (a.universityName || '').localeCompare(b.universityName || '') ||
        (a.programName    || '').localeCompare(b.programName    || ''))
      .slice(0, 3);

    const seenNames = new Set();
    for (const p of top3) {
      const norm = (p.programName || '').trim().toLowerCase();
      if (!seenNames.has(norm)) {
        seenNames.add(norm);
        result.push(p);
      }
    }
  }

  console.log(
    `[containerQ] dedupByUniversity: ${candidates.length} → ${result.length}`
  );
  return result;
}

/**
 * trimToFinal
 * REACH/MATCH split → cap at reachMax → fill remaining with MATCH.
 * Then apply UNDERDOG cap (max 2 per slot).
 *
 * @param {Array}  candidates  — post-dedup pool
 * @param {number} slots       — target count for this country
 * @param {number} reachMax    — max REACH programs allowed
 * @param {number} reachTier   — globalTier value for REACH
 * @param {number} matchTier   — globalTier value for MATCH
 * @returns {Array} final trimmed list
 */
function trimToFinal(candidates, slots, reachMax, reachTier, matchTier) {
  const reachPool = candidates
    .filter(r => r.globalTier === reachTier)
    .sort((a, b) =>
      b.fitScore - a.fitScore ||
      compareRank(a, b) ||
      (a.universityName || '').localeCompare(b.universityName || '') ||
      (a.programName    || '').localeCompare(b.programName    || ''));

  const matchPool = candidates
    .filter(r => r.globalTier === matchTier)
    .sort((a, b) =>
      b.fitScore - a.fitScore ||
      compareRank(a, b) ||
      (a.universityName || '').localeCompare(b.universityName || '') ||
      (a.programName    || '').localeCompare(b.programName    || ''));

  const seenReach = new Set();
  const finalReach = [];
  for (const c of reachPool) {
    if (finalReach.length >= reachMax) break;
    const uid = c.universityId
                || c.universityName;
    if (seenReach.has(uid)) continue;
    seenReach.add(uid);
    finalReach.push(c);
  }

  const remainingSlots =
    slots - finalReach.length;
  const seenMatch = new Set(seenReach);
  const finalMatch = [];
  for (const c of matchPool) {
    if (finalMatch.length >= remainingSlots)
      break;
    const uid = c.universityId
                || c.universityName;
    if (seenMatch.has(uid)) continue;
    seenMatch.add(uid);
    finalMatch.push(c);
  }

  finalReach.forEach(r => { r.tag = 'REACH'; });
  finalMatch.forEach(r => { r.tag = 'MATCH'; });

  console.log(
    `[containerQ] trimToFinal: REACH=${finalReach.length}` +
    ` MATCH=${finalMatch.length} (slots=${slots}, reachMax=${reachMax})`
  );

  let finalList = [...finalReach, ...finalMatch];

  // UNDERDOG cap — max 2 per country slot
  const underdogs = finalList.filter(r => r.budgetZone === 'UNDERDOG');
  if (underdogs.length > 2) {
    const removed = underdogs.length - 2;
    let seen = 0;
    finalList = finalList.filter(r => {
      if (r.budgetZone !== 'UNDERDOG') return true;
      seen++;
      return seen <= 2;
    });
    const includedIds = new Set(finalList.map(r => r.programId));
    const replacements = candidates
      .filter(r =>
        r.budgetZone !== 'UNDERDOG' &&
        !includedIds.has(r.programId)
      )
      .sort((a, b) =>
        b.fitScore - a.fitScore ||
        compareRank(a, b) ||
        (a.universityName || '').localeCompare(b.universityName || '') ||
        (a.programName    || '').localeCompare(b.programName    || ''))
      .slice(0, removed);
    finalList = [...finalList, ...replacements];
    console.log(
      `[containerQ] underdog capped at 2,` +
      ` removed ${removed}, added ${replacements.length} replacements`
    );
  }

  return finalList;
}

module.exports = { validateCandidates, dedupByUniversity, trimToFinal };

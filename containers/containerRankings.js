'use strict';

const supabase = require('../services/supabase');

// ── Single Perplexity ranking call ─────────────────────────
async function callRankingOnce(universityName, country) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'sonar-pro',
          temperature: 0.0,
          messages: [{
            role: 'user',
            content:
              `What are the current university rankings for "${universityName}" ` +
              `in ${country}?\n\n` +
              `Return a JSON object only (no markdown, no explanation):\n` +
              `{\n` +
              `  "qs_rank": number or null,\n` +
              `  "qs_rank_year": number or null,\n` +
              `  "the_rank": number or null,\n` +
              `  "the_rank_year": number or null,\n` +
              `  "nirf_rank": number or null,\n` +
              `  "nirf_rank_year": number or null,\n` +
              `  "regional_rank": number or null,\n` +
              `  "regional_rank_source": string or null,\n` +
              `  "country_rank": number or null,\n` +
              `  "country_rank_source": string or null,\n` +
              `  "arwu_rank": number or null,\n` +
              `  "arwu_rank_year": number or null\n` +
              `}\n\n` +
              `Rules:\n` +
              `- Return actual numbers only — never estimates\n` +
              `- null if genuinely unknown or not ranked\n` +
              `- qs_rank: QS World University Rankings (global, ~1500 universities)\n` +
              `- the_rank: Times Higher Education World University Rankings (global, ~2000)\n` +
              `- arwu_rank: Academic Ranking of World Universities / Shanghai Ranking (global, ~1000)\n` +
              `- nirf_rank: NIRF India ranking — Indian universities only\n` +
              `- regional_rank: ranking within a geographic region (QS Asia, QS Arab, QS BRICS, THE Asia, etc.)\n` +
              `- regional_rank_source: exact name of regional ranking system used\n` +
              `- country_rank: authoritative national ranking (NIRF for India, US News for USA, Guardian/CUG for UK, Maclean's for Canada, QS Australia for Australia, CHE for Germany)\n` +
              `- country_rank_source: exact name of national ranking system used`,
          }],
        }),
        signal: controller.signal,
      }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Perplexity ranking API error: ${res.status}`);
    }

    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    // Strip markdown fences if present
    const clean = raw
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();

    return JSON.parse(clean);
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Retry wrapper ───────────────────────────────────────────
// Max 3 attempts. Returns null on all failures — never throws.
async function fetchRankingForUni(universityName, country) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await callRankingOnce(universityName, country);
      if (result) return result;
    } catch (err) {
      if (attempt === 2) {
        console.warn(
          `[rankings] failed for ${universityName}:`, err.message
        );
      }
    }
  }
  return null;
}

// ── Save rankings to DB ─────────────────────────────────────
// Soft-fail — never throws.
async function saveRankings(universityId, rankData) {
  if (!rankData) return;
  try {
    const db = supabase();
    const { error } = await db
      .from('universities')
      .update({
        qs_rank:              rankData.qs_rank              ?? null,
        qs_rank_year:         rankData.qs_rank_year         ?? null,
        the_rank:             rankData.the_rank              ?? null,
        the_rank_year:        rankData.the_rank_year        ?? null,
        nirf_rank:            rankData.nirf_rank            ?? null,
        nirf_rank_year:       rankData.nirf_rank_year       ?? null,
        regional_rank:        rankData.regional_rank        ?? null,
        regional_rank_source: rankData.regional_rank_source ?? null,
        country_rank:         rankData.country_rank         ?? null,
        country_rank_source:  rankData.country_rank_source  ?? null,
        arwu_rank:            rankData.arwu_rank            ?? null,
        arwu_rank_year:       rankData.arwu_rank_year       ?? null,
        ranking_last_updated: new Date().toISOString(),
      })
      .eq('id', universityId);

    if (error) {
      console.warn('[rankings] DB save failed:', error.message);
    }
  } catch (err) {
    console.warn('[rankings] DB save error:', err.message);
  }
}

// ── Main export ─────────────────────────────────────────────
// Fetches rankings for unique universities in candidate pool.
// Runs in parallel with validateCandidates (Promise.all).
// Always returns full rankMap — no candidates dropped.
// Saves to DB as side effect (non-blocking).
//
// @param {Array}  candidates   — scored program objects
// @param {string} country      — destination country string
// @returns {Map}  universityId → rankData object
async function fetchRankings(candidates, country) {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.warn('[rankings] no PERPLEXITY_API_KEY — skipping');
    return new Map();
  }

  // Deduplicate by universityId — one Perplexity call per university
  const seen = new Set();
  const uniqueUnis = candidates.filter(c => {
    if (seen.has(c.universityId)) return false;
    seen.add(c.universityId);
    return true;
  });

  console.log(
    `[rankings] fetching for ${uniqueUnis.length} unique universities` +
    ` (${candidates.length} candidates) in ${country}...`
  );

  const results = await Promise.allSettled(
    uniqueUnis.map(async uni => {
      const rankData = await fetchRankingForUni(
        uni.universityName, country
      );

      // Save to DB — non-blocking, errors swallowed
      saveRankings(uni.universityId, rankData).catch(err =>
        console.warn('[rankings] save error:', err.message)
      );

      return { universityId: uni.universityId, rankData };
    })
  );

  // Build universityId → rankData map
  const rankMap = new Map();
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value?.rankData) {
      rankMap.set(r.value.universityId, r.value.rankData);
    }
  });

  console.log(
    `[rankings] done — ${rankMap.size}/${uniqueUnis.length} universities ranked`
  );

  return rankMap;
}

module.exports = { fetchRankings };

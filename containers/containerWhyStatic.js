// backend/containers/containerWhyStatic.js
// Container WS — Why This Uni Static Block (Gemini 2.5 Flash + Google Search)
//
// Generates factual, student-agnostic program highlights and caches them
// by program_id (90-day TTL). These facts are fed as context into the
// Sonnet personalization prompt in claude.js — never shown directly.
//
// Caching rule:
//   - Cache key: program_id only — no student data
//   - Empty / failed results are never cached
//   - Fail-open throughout — if this errors, Sonnet personalizes without facts

'use strict';

const supabase = require('../services/supabase');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CACHE_TTL_DAYS = 90;

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function getCachedStaticBlock(programId) {
  try {
    const { data, error } = await supabase()
      .from('why_this_uni_static_cache')
      .select('static_block')
      .eq('program_id', programId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !data?.static_block) return null;
    return data.static_block;
  } catch {
    return null; // fail-open
  }
}

async function setCachedStaticBlock(programId, universityId, staticBlock) {
  try {
    if (!staticBlock || staticBlock.length < 30) return; // never cache empty

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    const { error } = await supabase()
      .from('why_this_uni_static_cache')
      .upsert({
        program_id:    programId,
        university_id: universityId || null,
        static_block:  staticBlock,
        fetched_at:    new Date().toISOString(),
        expires_at:    expiresAt.toISOString(),
      }, { onConflict: 'program_id' });

    if (error) {
      console.warn(`[ContainerWS] cache write failed: ${error.message}`);
    }
  } catch {
    // fail-open
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch factual program highlights for Sonnet context.
 * Cached 90 days by program_id. Falls back gracefully — never throws.
 *
 * @param {string} programId       - UUID (cache key)
 * @param {string} universityId    - UUID (informational)
 * @param {string} universityName
 * @param {string} programName
 * @param {string} destinationCountry
 * @param {string} level           - 'undergraduate' | 'postgraduate' | 'phd'
 * @returns {Promise<string|null>} - 3-4 sentence factual block, or null on failure
 */
async function getStaticBlock(
  programId,
  universityId,
  universityName,
  programName,
  destinationCountry,
  level = 'undergraduate'
) {
  if (!GEMINI_KEY || !programId) return null;

  // ── Cache check ──────────────────────────────────────────────────────────
  const cached = await getCachedStaticBlock(programId);
  if (cached) {
    console.log(`[ContainerWS] cache HIT — ${universityName} / ${programName}`);
    return cached;
  }
  console.log(`[ContainerWS] cache MISS — ${universityName} / ${programName} → calling Gemini`);

  // ── Call Gemini ──────────────────────────────────────────────────────────
  const levelLabel = level === 'phd'
    ? 'doctoral/PhD'
    : level === 'postgraduate' ? 'postgraduate/Masters' : 'undergraduate';

  const prompt = `You are a university research assistant. Provide factual highlights about this specific programme.

PROGRAMME: ${programName} (${levelLabel}) at ${universityName}, ${destinationCountry}

Using Google Search, find and summarise in 3-4 concise sentences:
1. What makes this specific programme academically strong (research areas, teaching approach, accreditations)
2. One notable outcome or opportunity graduates of this programme have (industry links, placement, further study)
3. One distinctive aspect of the campus or location relevant to students

Rules:
- Be factual only — cite what you find, not what you assume
- Do NOT mention rankings, acceptance rates, tuition fees, or accommodation
- Do NOT invent faculty names, lab names, or specific statistics you cannot verify
- If you cannot find specific programme facts, describe general known strengths of the university in this field
- Keep it concise — 3-4 sentences maximum`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[ContainerWS] Gemini HTTP ${response.status} for ${universityName}`);
      return null;
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const staticBlock = parts.map(p => p.text || '').join('').trim();

    if (!staticBlock || staticBlock.length < 30) return null;

    // ── Write to cache (fire-and-forget) ────────────────────────────────
    setCachedStaticBlock(programId, universityId, staticBlock);

    return staticBlock;

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[ContainerWS] Gemini timeout for ${universityName}`);
    } else {
      console.warn(`[ContainerWS] Gemini error for ${universityName}:`, err.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getStaticBlock };

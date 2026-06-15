// backend/containers/containerScholarships.js
// Container S — Gemini 2.5 Flash with Google Search grounding.
// Runs in parallel with Container M (Perplexity) — separate API quota, zero rate limit conflict.
// Failure always returns [] gracefully — never crashes Container M.
//
// Caching strategy (scholarship_cache table, 60-day TTL):
//   - Cache key: program_id only — NOT nationality or student profile
//   - Cached content: ALL scholarships/aid available at the program for international students
//   - What stays live: which scholarships apply to THIS student (done by Sonnet counsellor note)
//   - Golden rule: cache what EXISTS, not what applies to who
//   - UNKNOWN / empty results are never cached — always retried

'use strict';

const supabase = require('../services/supabase');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CACHE_TTL_DAYS = 60;

// ── Cache helpers ─────────────────────────────────────────────────────────────

async function getCachedScholarships(programId) {
  try {
    const { data, error } = await supabase()
      .from('scholarship_cache')
      .select('content')
      .eq('program_id', programId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !data?.content) return null;
    return data.content; // { summary, sources, items }
  } catch {
    return null; // fail-open — treat as cache miss
  }
}

async function setCachedScholarships(programId, universityId, content) {
  try {
    // Never cache empty results — always retry on miss
    if (!content || (!content.summary && (!content.items || content.items.length === 0))) return;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    const { error } = await supabase()
      .from('scholarship_cache')
      .upsert({
        program_id:   programId,
        university_id: universityId || null,
        content,
        fetched_at:   new Date().toISOString(),
        expires_at:   expiresAt.toISOString(),
      }, { onConflict: 'program_id' });

    if (error) {
      console.warn(`[ContainerS] cache write failed: ${error.message}`);
    }
  } catch {
    // fail-open — cache write failure never affects the result
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetch scholarship options via Gemini with live Google Search grounding.
 * Results cached 60 days by program_id — nationality-agnostic.
 * Returns ALL scholarships available; student-specific filtering done downstream.
 *
 * @param {string} universityName
 * @param {string} programName
 * @param {string} destinationCountry
 * @param {string} passportCountry     - informational only (not used as cache key)
 * @param {string} level               - 'undergraduate' | 'postgraduate' | 'phd'
 * @param {string} scholarshipGuide    - pathway guidance text from loadScholarshipChunks
 * @param {string} [programId]         - UUID for cache key (optional — skip cache if not provided)
 * @param {string} [universityId]      - UUID for cache record (optional, informational)
 * @returns {Promise<{ summary: string, sources: Array, items: Array }>}
 */
async function fetchUniversityScholarships(
  universityName,
  programName,
  destinationCountry,
  passportCountry,
  level = 'undergraduate',
  scholarshipGuide = '',
  programId = null,
  universityId = null
) {
  if (!GEMINI_KEY) {
    console.warn('[ContainerS] GEMINI_API_KEY not set — skipping scholarship search');
    return { summary: '', sources: [], items: [] };
  }

  // ── Cache check ──────────────────────────────────────────────────────────
  if (programId) {
    const cached = await getCachedScholarships(programId);
    if (cached) {
      console.log(`[ContainerS] cache HIT — ${universityName} / ${programName}`);
      return cached;
    }
    console.log(`[ContainerS] cache MISS — ${universityName} / ${programName} → calling Gemini`);
  }

  // ── Call Gemini ──────────────────────────────────────────────────────────
  const levelLabel = level === 'phd'
    ? 'doctoral/PhD'
    : level === 'postgraduate' ? 'postgraduate/Masters' : 'undergraduate';

  const prompt = buildPrompt(universityName, programName, destinationCountry, levelLabel, scholarshipGuide);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28000);

  try {
    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2500 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[ContainerS] Gemini HTTP ${response.status} for ${universityName}`);
      return { summary: '', sources: [], items: [] };
    }

    const data = await response.json();
    const result = parseGeminiResponse(data, universityName);

    // ── Write to cache (fire-and-forget) ────────────────────────────────
    if (programId) {
      setCachedScholarships(programId, universityId, result);
    }

    return result;

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[ContainerS] Gemini timeout for ${universityName}`);
    } else {
      console.warn(`[ContainerS] Gemini error for ${universityName}:`, err.message);
    }
    return { summary: '', sources: [], items: [] };
  } finally {
    clearTimeout(timer);
  }
}

// ── Prompt — nationality-agnostic ────────────────────────────────────────────
// Asks for ALL scholarships available to international students.
// Nationality eligibility is noted per item so downstream logic can filter.
// This keeps the cache universal (program_id only — no nationality in key).

function buildPrompt(universityName, programName, destinationCountry, levelLabel, scholarshipGuide) {
  return `You are a scholarship research assistant. Find current scholarship and financial aid options available at this university.

PROGRAMME:
- University: ${universityName}, ${destinationCountry}
- Programme: ${programName} (${levelLabel})

SEARCH GUIDANCE:
${scholarshipGuide || `Search for scholarships at ${universityName} for international ${levelLabel} students in ${destinationCountry}.`}

TASK:
Using Google Search, find ALL currently available scholarships, bursaries, grants, and financial aid options at ${universityName} for ${levelLabel} students in ${programName} or related fields.

For each scholarship include:
1. Name of the scholarship
2. Amount (in local currency, per year if recurring)
3. Who is eligible — nationalities, academic criteria, income requirements
4. Application deadline (month/year or annual pattern)
5. Official URL

Format as a numbered list. Be factual and cite real current sources.
Note eligibility clearly so students can assess if they qualify.
If amount or deadline is uncertain, say "verify on official website".
Do not invent scholarships.`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseGeminiResponse(data, universityName) {
  const candidate = data?.candidates?.[0];
  if (!candidate) return { summary: '', sources: [], items: [] };

  const parts = candidate.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();

  const groundingChunks = candidate.groundingMetadata?.groundingChunks || [];
  const sources = groundingChunks
    .filter(c => c.web?.uri)
    .map(c => ({ title: c.web.title || '', url: c.web.uri }))
    .slice(0, 6);

  const items = parseItemsFromText(text, universityName);
  return { summary: text, sources, items };
}

function parseItemsFromText(text, universityName) {
  if (!text || text.length < 40) return [];

  const blocks = text
    .split(/\n(?=\d+[\.\)]\s|\*\*\d+[\.\)]\*\*)/)
    .map(b => b.trim())
    .filter(b => b.length > 30 && /^\d+/.test(b.replace(/\*+/g, '')));

  const items = [];

  for (const block of blocks) {
    const urlMatch = block.match(/https?:\/\/[^\s\)\]>]+/);

    const amountMatch = block.match(
      /(?:[£€$¥₹]\s?[\d,]+(?:\s?(?:per year|\/year|annually|per month|\/month|one.?time|lump sum))?|[\d,]+\s?(?:EUR|GBP|USD|AUD|CAD|SEK|SGD|KRW|JPY)(?:\s?\/?\s?year)?)/
    );

    const firstLine = block.split('\n')[0]
      .replace(/^\d+[\.\)]\s*/, '')
      .replace(/\*+/g, '')
      .trim();

    if (!firstLine || firstLine.length < 5) continue;

    const name = firstLine.split(':')[0].trim().slice(0, 120);
    if (!name) continue;

    const detailsRaw = block
      .replace(/https?:\/\/[^\s\)\]>]+/g, '')
      .replace(/^\d+[\.\)]\s*\**/, '')
      .replace(/\*+/g, '')
      .trim();

    const detailsBody = detailsRaw.startsWith(name)
      ? detailsRaw.slice(name.length).replace(/^[\s:\-–—]+/, '').trim()
      : detailsRaw;

    items.push({
      name,
      amount:  amountMatch ? amountMatch[0].trim() : null,
      details: detailsBody.slice(0, 500),
      url:     urlMatch ? urlMatch[0].replace(/[.,;)]+$/, '') : null,
    });

    if (items.length >= 5) break;
  }

  return items;
}

module.exports = { fetchUniversityScholarships };

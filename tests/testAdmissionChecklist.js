'use strict';

/**
 * testAdmissionChecklist.js
 *
 * Standalone test: load the Germany admission_checklist chunk,
 * inject it into a Perplexity prompt, ask Perplexity to validate
 * and augment it for a specific student + program, and print the result.
 *
 * Run from backend directory:
 *   node tests/testAdmissionChecklist.js
 */

require('dotenv').config();

const { loadChunkContent } = require('../utils/loadChunkContent');

const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;

// ── Hardcoded test profile ───────────────────────────────
const TEST_PROFILE = {
  studentName:       'Suhaan',
  passportCountry:   'India',
  stream:            'engineering',
  university:        'Karlsruhe Institute of Technology',
  program:           'B.Sc. Informatics',
  board:             'CBSE',
  overall:           88,
  destinationCountry: 'Germany',
};

// ── Perplexity call (same pattern as requirements.js) ────
async function callPerplexity(prompt) {
  if (!PERPLEXITY_KEY) {
    throw new Error('PERPLEXITY_API_KEY not set in environment');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);

  try {
    console.log('[perplexity] sending request...');
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
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Perplexity HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;
    console.log('[perplexity] raw response length:', text.length, 'chars');

    // Two-level JSON parse — same as requirements.js
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
      // Return raw text if not JSON
      console.warn('[perplexity] response is not JSON — returning raw text');
      return text;
    }

  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const p = TEST_PROFILE;

  // ── Step 1: Load chunk ─────────────────────────────────
  console.log('\n=== STEP 1: Load admission_checklist chunk ===');
  const chunkText = loadChunkContent(['admission_checklist'], 'Germany');

  if (!chunkText) {
    console.error('ERROR: chunk returned null — check JSON file');
    process.exit(1);
  }

  console.log(`chunk loaded: ${chunkText.length} chars`);
  console.log('preview:', chunkText.substring(0, 200));

  // ── Step 2: Build prompt ───────────────────────────────
  console.log('\n=== STEP 2: Build Perplexity prompt ===');

  const prompt = `
You are a university admissions expert with access to current official web sources.
Search official university admissions pages and German government websites to answer.
Do not use blog posts, student forums, or unofficial aggregators.

STUDENT PROFILE:
  Name: ${p.studentName}
  Passport country: ${p.passportCountry}
  School board: ${p.board}
  Overall score: ${p.overall}% in ${p.board}
  Target stream: ${p.stream}
  Destination country: ${p.destinationCountry}

PROGRAM BEING EVALUATED:
  University: ${p.university}
  Program: ${p.program}

BASELINE FACTS — PRE-VERIFIED FROM OFFICIAL SOURCES:
The following checklist items are sourced from DAAD, uni-assist, and German Embassy
guidelines for 2025-2026. Use these as ground truth. Do not contradict them unless
you find a more recent official source (dated within 6 months).

${chunkText}

YOUR TASK:
1. Review each baseline fact above. Flag any item that has changed in 2025-2026
   (e.g. fee amounts, deadlines, or policy changes) by adding a note.
2. Add any program-specific or university-specific checklist items for
   ${p.program} at ${p.university} that are NOT covered in the baseline.
   Examples: specific application portal used by ${p.university}, NC cutoff
   for this program, any specific document requirements.
3. Return a JSON array of checklist items ordered chronologically by when
   the student should complete each action.

Return ONLY a valid JSON array. No preamble, no markdown, no explanation.
Each item must have exactly these fields:
[
  {
    "item": "Short action the student must take",
    "mandatory": true or false,
    "deadline": "date string or null",
    "notes": "additional context or null",
    "source": "official URL used to verify this or null"
  }
]
`;

  console.log('prompt length:', prompt.length, 'chars');

  // ── Step 3: Call Perplexity ────────────────────────────
  console.log('\n=== STEP 3: Call Perplexity sonar-pro ===');

  console.log('prompt length with chunk:', prompt.length);
  let result;
  try {
    result = await callPerplexity(prompt);
  } catch (err) {
    console.error('Perplexity call failed:', err.message);
    process.exit(1);
  }

  // ── Step 4: Print result ───────────────────────────────
  console.log('\n=== STEP 4: Result ===');

  if (Array.isArray(result)) {
    console.log(`\nReturned ${result.length} checklist items:\n`);
    result.forEach((item, i) => {
      console.log(`[${i + 1}] ${item.mandatory ? '■' : '□'} ${item.item}`);
      if (item.deadline) console.log(`     deadline: ${item.deadline}`);
      if (item.notes)    console.log(`     notes:    ${item.notes}`);
      if (item.source)   console.log(`     source:   ${item.source}`);
      console.log();
    });
    console.log('\nFull JSON:\n', JSON.stringify(result, null, 2));
  } else {
    console.log('\nRaw response (not a JSON array):\n', result);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

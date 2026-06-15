// backend/tests/runTest20.js
// Test 20 — Multi-destination: same student, UK + Germany
// Mirrors the per-country loop in analyze.js
// Run: node backend/tests/runTest20.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { analyzeStudent }   = require('../services/claude');
const { loadChunkContent } = require('../utils/loadChunkContent');

// ─────────────────────────────────────────────────────
// TEST 20 PROFILE
// ─────────────────────────────────────────────────────

const TEST_20_PROFILE = {
  name: 'Test Student',
  grade: 'Grade 12',
  board: 'CBSE',
  passportCountry: 'India',
  countryOfResidence: 'Oman',
  budgetUSD: 25000
};

const TEST_20_MARKS = [{
  grade: 'Grade 12',
  overall: 84,
  subjectsText: 'Physics: 86, Chemistry: 83, Mathematics: 85, English: 81, Computer Science: 87'
}];

const TEST_20_ASPIRATION = 'I am not completely sure what I want to do. I have always been curious about how things work — machines, computers, maybe even how businesses run. My friends say I am good at problem solving. Some people say engineering, some say computer science. I just know I want a career that pays well and has good opportunities abroad.';

const TEST_20_EXTRACURRICULAR = 'Coding club, participated in a regional robotics competition, played cricket for school team.';

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────

function mentions(text, keyword) {
  return (text || '').toLowerCase().includes(keyword.toLowerCase());
}

function printDestination(country, chunkId, chunkContent, result) {
  const sp = result.subject_profile || {};
  const el = result.eligibility    || {};
  const sr = result.search_strategy || {};
  const combinedText = (el.eligibility_reasoning || '') + ' ' + (result.counsellor_note || '');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`=== DESTINATION: ${country} ===`);
  console.log('='.repeat(50));
  console.log(`Chunk loaded: ${chunkId} | ${chunkContent ? chunkContent.length + ' chars' : 'NULL'}`);
  console.log(`Stream: ${result.stream} | Clarity: ${result.aspiration_clarity} | Confidence: ${result.confidence}`);
  console.log(`foundation_year_required: ${sp.foundation_year_required} | language_test_required: ${sp.language_test_required} | equivalency_required: ${sp.equivalency_required}`);
  console.log(`language_test_note: ${sp.language_test_note || 'null'}`);
  console.log(`equivalency_note: ${sp.equivalency_note || 'null'}`);
  console.log(`normalized_score: ${sp.normalized_score}`);
  console.log(`eligible_global_tiers: ${JSON.stringify(el.eligible_global_tiers)} | tier1_tag: ${el.tier1_tag} | tier2_tag: ${el.tier2_tag}`);
  console.log(`eligibility_reasoning: ${(el.eligibility_reasoning || '').slice(0, 250)}`);
  console.log(`counsellor_note: ${(result.counsellor_note || '').slice(0, 250)}`);
  console.log(`mustMatch: ${JSON.stringify(sr.must_match || [])}`);
}

// ─────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────

async function runTest20() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 20 — MULTI-DESTINATION: UK + GERMANY');
  console.log('Same student profile, analyzeStudent called twice');
  console.log('='.repeat(60));

  // ── Pass 1: United Kingdom ──────────────────────────
  const ukChunkId = 'qualification_recognition';
  const ukChunk   = loadChunkContent([ukChunkId], 'United Kingdom');

  console.log('\nPass 1 — United Kingdom...');
  const ukResult = await analyzeStudent(
    TEST_20_ASPIRATION,
    TEST_20_EXTRACURRICULAR,
    TEST_20_MARKS,
    {},
    {
      ...TEST_20_PROFILE,
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to United Kingdom'
    },
    'United Kingdom',
    ukChunk,
    null
  );

  if (!ukResult) {
    console.log('✗ UK analyzeStudent returned null');
    process.exit(1);
  }

  // ── Pass 2: Germany ─────────────────────────────────
  const deChunkId = 'qualification_recognition';
  const deChunk   = loadChunkContent([deChunkId], 'Germany');

  console.log('Pass 2 — Germany...');
  const deResult = await analyzeStudent(
    TEST_20_ASPIRATION,
    TEST_20_EXTRACURRICULAR,
    TEST_20_MARKS,
    {},
    {
      ...TEST_20_PROFILE,
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to Germany'
    },
    'Germany',
    deChunk,
    null
  );

  if (!deResult) {
    console.log('✗ Germany analyzeStudent returned null');
    process.exit(1);
  }

  // ── Print per-destination output ────────────────────
  printDestination('United Kingdom', ukChunkId, ukChunk, ukResult);
  printDestination('Germany',        deChunkId, deChunk, deResult);

  // ── Comparison block ────────────────────────────────
  const ukSp  = ukResult.subject_profile || {};
  const deSp  = deResult.subject_profile || {};
  const ukEl  = ukResult.eligibility    || {};
  const deEl  = deResult.eligibility    || {};
  const ukSr  = ukResult.search_strategy || {};
  const deSr  = deResult.search_strategy || {};

  const ukCombined = (ukEl.eligibility_reasoning || '') + ' ' + (ukResult.counsellor_note || '');
  const deCombined = (deEl.eligibility_reasoning || '') + ' ' + (deResult.counsellor_note || '');

  const streamConsistent = ukResult.stream === deResult.stream;
  const ukMust = JSON.stringify(ukSr.must_match || []);
  const deMust = JSON.stringify(deSr.must_match || []);
  const mustConsistent = ukMust === deMust;

  const ukAPS      = mentions(ukCombined, 'APS');
  const deAPS      = mentions(deCombined, 'APS');
  const ukIELTS    = mentions(ukCombined, 'IELTS') || mentions(ukSp.language_test_note, 'IELTS');
  const deTestDaF  = mentions(deCombined, 'TestDaF') || mentions(deSp.language_test_note, 'TestDaF');

  console.log('\n' + '='.repeat(50));
  console.log('=== COMPARISON ===');
  console.log('='.repeat(50));
  console.log(`Stream consistent across destinations: ${streamConsistent ? 'yes' : 'no'} (UK=${ukResult.stream}, DE=${deResult.stream})`);
  console.log(`mustMatch consistent: ${mustConsistent ? 'yes' : 'no'}`);
  console.log(`  UK:      ${ukMust}`);
  console.log(`  Germany: ${deMust}`);
  console.log(`UK language_test_required: ${ukSp.language_test_required} | Germany language_test_required: ${deSp.language_test_required}`);
  console.log(`UK foundation_year: ${ukSp.foundation_year_required} | Germany foundation_year: ${deSp.foundation_year_required}`);
  console.log(`UK APS mentioned: ${ukAPS ? 'yes' : 'no'} | Germany APS mentioned: ${deAPS ? 'yes' : 'no'}`);
  console.log(`UK IELTS mentioned: ${ukIELTS ? 'yes' : 'no'} | Germany TestDaF mentioned: ${deTestDaF ? 'yes' : 'no'}`);

  // ── Validation ──────────────────────────────────────
  const errors = [];

  if (!streamConsistent)
    errors.push(`stream mismatch: UK=${ukResult.stream}, Germany=${deResult.stream}`);

  if (ukSp.language_test_required !== true)
    errors.push(`UK language_test_required=${ukSp.language_test_required} expected true`);

  if (deSp.language_test_required !== true)
    errors.push(`Germany language_test_required=${deSp.language_test_required} expected true`);

  if (!deAPS)
    errors.push('Germany: APS not mentioned in counsellor_note or eligibility_reasoning');

  if (!ukIELTS)
    errors.push('UK: IELTS not mentioned in counsellor_note, eligibility_reasoning, or language_test_note');

  if (!deTestDaF)
    errors.push('Germany: TestDaF not mentioned in counsellor_note, eligibility_reasoning, or language_test_note');

  if (ukSp.foundation_year_required !== false)
    errors.push(`UK foundation_year_required=${ukSp.foundation_year_required} expected false`);

  if (deSp.foundation_year_required !== false)
    errors.push(`Germany foundation_year_required=${deSp.foundation_year_required} expected false`);

  console.log('\n' + '='.repeat(50));
  if (errors.length) {
    console.log(`✗ FAILED (${errors.length} error/s):`);
    errors.forEach(e => console.log(`  ! ${e}`));
  } else {
    console.log('✓ TEST 20 PASSED — all validation checks passed');
  }
  console.log('='.repeat(50) + '\n');
}

runTest20().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});

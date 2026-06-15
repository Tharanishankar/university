// backend/tests/runTest10.js
// Runs Test 10 only — full profile with marks + chunk as admissionGuide
// Run: node backend/tests/runTest10.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { analyzeStudent }   = require('../services/claude');
const { loadChunkContent } = require('../utils/loadChunkContent');

const tc = {
  label: 'Test 10 — Full profile with marks, NRI Gulf, CBSE → UK',
  destinationCountry: 'United Kingdom',
  board: 'CBSE',
  studentProfile: {
    name: 'Test Student',
    grade: 'Grade 12',
    board: 'CBSE',
    passportCountry: 'India',
    countryOfResidence: 'Oman',
    studentCategoryLabel: 'International student applying to UK',
    budgetUSD: 35000
  },
  aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
  extracurricularText: 'Robotics club.',
  marksData: [
    {
      grade: 'Grade 12',
      overall: 85,
      subjectsText: 'Physics: 87, Chemistry: 84, Mathematics: 86, English: 82, Computer Science: 88'
    }
  ]
};

async function run() {
  console.log('\n' + '='.repeat(60));
  console.log(tc.label);
  console.log('='.repeat(60));

  // Load chunk as admissionGuide
  const admissionGuide = loadChunkContent(
    ['qualification_recognition'],
    tc.destinationCountry
  );
  console.log(`\nAdmission guide loaded: ${admissionGuide ? admissionGuide.length + ' chars' : 'NULL'}`);

  console.log('\nCalling analyzeStudent...\n');

  const result = await analyzeStudent(
    tc.aspirationText,
    tc.extracurricularText,
    tc.marksData,
    {},                      // lrpResponses — empty
    tc.studentProfile,
    tc.destinationCountry,
    admissionGuide,          // chunk content as guide
    null                     // normalizedMarks — null
  );

  if (!result) {
    console.log('✗ analyzeStudent returned null');
    process.exit(1);
  }

  const sp = result.subject_profile || {};
  const el = result.eligibility    || {};

  console.log('─'.repeat(60));
  console.log('stream:                      ', result.stream);
  console.log('aspiration_clarity:          ', result.aspiration_clarity);
  console.log('─'.repeat(60));
  console.log('foundation_year_required:    ', sp.foundation_year_required);
  console.log('language_test_required:      ', sp.language_test_required);
  console.log('language_test_note:          ', sp.language_test_note || 'null');
  console.log('equivalency_required:        ', sp.equivalency_required);
  console.log('equivalency_note:            ', sp.equivalency_note || 'null');
  console.log('normalized_score:            ', sp.normalized_score);
  console.log('normalization_basis:         ', sp.normalization_basis || 'null');
  console.log('─'.repeat(60));
  console.log('eligible_global_tiers:       ', JSON.stringify(el.eligible_global_tiers));
  console.log('tier1_tag:                   ', el.tier1_tag);
  console.log('tier2_tag:                   ', el.tier2_tag);
  console.log('eligibility_reasoning (200): ', (el.eligibility_reasoning || '').slice(0, 200));
  console.log('─'.repeat(60));
  console.log('counsellor_note (200):       ', (result.counsellor_note || '').slice(0, 200));
  console.log('─'.repeat(60));
  console.log('must_match:                  ', JSON.stringify(result.search_strategy?.must_match));
  console.log('confidence:                  ', result.confidence);
  console.log('='.repeat(60) + '\n');
}

run().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});

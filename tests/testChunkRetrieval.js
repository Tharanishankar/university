// backend/tests/testChunkRetrieval.js
// Tests chunk retrieval connected to real Container A output
// Run: node backend/tests/testChunkRetrieval.js
// No DB required. Uses real Claude API.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { analyzeStudent }  = require('../services/claude');
const { loadChunkContent } = require('../utils/loadChunkContent');

// ─────────────────────────────────────────────────────
// CHUNK RETRIEVAL ROUTING FUNCTION
// Pure logic — no DB, no API calls
// ─────────────────────────────────────────────────────

function getRelevantChunks({
  stream,
  studentCategory,
  board,
  passportCountry,
  countryOfResidence,
  destinationCountry
}) {
  const chunks  = new Set();
  const reasons = {};

  const add = (id, reason) => {
    chunks.add(id);
    reasons[id] = reason;
  };

  if (destinationCountry === 'India') {

    add('qualification_recognition',
      'Always — which certificates accepted, 75% rule, AIU, IGCSE warning');

    const cat = (studentCategory || '').toLowerCase();
    const res = (countryOfResidence || '').toLowerCase();

    const isNRI = cat.includes('nri') || cat.includes('oci')
               || cat.includes('gulf') || cat.includes('abroad');

    const isGulf = ['oman','uae','saudi arabia','kuwait',
                    'bahrain','qatar','iraq','iran'].includes(res);

    const isForeign = passportCountry !== 'India'
                   && !cat.includes('oci');

    const isIBorALevel = /ib|a.level|cambridge/i.test(board || '');
    const isIGCSE      = /igcse/i.test(board || '');

    if (isForeign) {
      add('qualification_recognition',
        'Foreign national — routing note at top of chunk flags different pathway');
    } else {
      // qualification_recognition already added above
      // it contains NRI/OCI/Gulf classification rules
    }

    if (stream === 'engineering' || stream === 'science') {
      if (isNRI || isGulf) {
        add('qualification_recognition',
          'NRI/Gulf engineering — DASA/CIWG rules in qualification chunk');
      }
      if (isIBorALevel || isIGCSE) {
        add('qualification_recognition',
          'IB/A-Level/IGCSE — 75% rule detail and curriculum gap warning in chunk');
      }
    }

    if (stream === 'medicine') {
      if (isIBorALevel) {
        add('qualification_recognition',
          'IB/A-Level — 3-science NEET problem covered in chunk');
      }
    }

  } else if (destinationCountry === 'United Kingdom'
          || destinationCountry === 'Germany') {

    add('qualification_recognition',
      'Always — which certificates accepted, language requirements, visa basics');
  }

  return {
    chunks:  Array.from(chunks),
    reasons
  };
}

// ─────────────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────────────

const TEST_CASES = [
  {
    label: 'Test 1 — Vague science/engineering, NRI Gulf, CBSE → India',
    destinationCountry: 'India',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
      passportCountry: 'India', countryOfResidence: 'Oman',
      studentCategoryLabel: 'NRI/Gulf student applying to India',
      budgetUSD: 20000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'I like building things. I joined robotics club at school.'
  },
  {
    label: 'Test 2 — Same aspiration, NRI Gulf, IB Diploma → India',
    destinationCountry: 'India',
    board: 'IB Diploma',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'IB Diploma',
      passportCountry: 'India', countryOfResidence: 'Oman',
      studentCategoryLabel: 'NRI/Gulf student applying to India',
      budgetUSD: 20000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'Robotics club, coding competition.'
  },
  {
    label: 'Test 3 — Same aspiration, OCI card (UAE passport) → India',
    destinationCountry: 'India',
    board: 'IB Diploma',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'IB Diploma',
      passportCountry: 'UAE', countryOfResidence: 'UAE',
      studentCategoryLabel: 'OCI student applying to India',
      budgetUSD: 20000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'Robotics club.'
  },
  {
    label: 'Test 4 — Same aspiration, NRI USA, A-Levels → India',
    destinationCountry: 'India',
    board: 'Cambridge A-Levels',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'Cambridge A-Levels',
      passportCountry: 'India', countryOfResidence: 'USA',
      studentCategoryLabel: 'NRI student applying to India',
      budgetUSD: 30000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'Science fair, robotics.'
  },
  {
    label: 'Test 5 — Same aspiration, Resident Indian, CBSE → India',
    destinationCountry: 'India',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
      passportCountry: 'India', countryOfResidence: 'India',
      studentCategoryLabel: 'Indian student applying to India',
      budgetUSD: 10000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'Robotics club, coding.'
  },
  {
    label: 'Test 6 — Law aspiration, NRI Gulf, CBSE → India',
    destinationCountry: 'India',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
      passportCountry: 'India', countryOfResidence: 'Oman',
      studentCategoryLabel: 'NRI/Gulf student applying to India',
      budgetUSD: 15000
    },
    aspirationText: 'I like law. I want to become a famous lawyer helping the poor. I care about justice and human rights.',
    extracurricularText: 'Debate club, Model UN.'
  },
  {
    label: 'Test 7 — Engineering aspiration, IGCSE Grade 10, NRI Gulf → India',
    destinationCountry: 'India',
    board: 'Cambridge IGCSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 10', board: 'Cambridge IGCSE',
      passportCountry: 'India', countryOfResidence: 'Oman',
      studentCategoryLabel: 'NRI/Gulf student applying to India',
      budgetUSD: 20000
    },
    aspirationText: 'I love robots and rockets. I want to build spaceships one day.',
    extracurricularText: 'Science projects.'
  },
  {
    label: 'Test 8 — Engineering aspiration, NRI Gulf, CBSE → United Kingdom',
    destinationCountry: 'United Kingdom',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
      passportCountry: 'India', countryOfResidence: 'Oman',
      studentCategoryLabel: 'International student applying to UK',
      budgetUSD: 35000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'Robotics club.'
  },
  {
    label: 'Test 9 — Engineering aspiration, NRI Gulf, CBSE → Germany',
    destinationCountry: 'Germany',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
      passportCountry: 'India', countryOfResidence: 'Oman',
      studentCategoryLabel: 'International student applying to Germany',
      budgetUSD: 15000
    },
    aspirationText: 'I am not that sure. I like science and machines. People are saying AI is future, so learn AI or Data Science. However, I love robots and rockets.',
    extracurricularText: 'Robotics club.'
  },
  {
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
    ],
    useChunkAsGuide: true   // pass loadChunkContent result as admissionGuide
  }
];

// ─────────────────────────────────────────────────────
// VALIDATION CHECKS
// ─────────────────────────────────────────────────────

function validateResult(tc, stream, chunkIds, chunkContent) {
  const errors = [];

  // Stream should not be null
  if (!stream) errors.push('stream is null or undefined');

  // Engineering aspiration should not return law stream
  if (tc.aspirationText.includes('robots') && stream === 'law')
    errors.push(`stream=${stream} unexpected for robots/engineering aspiration`);

  // Law aspiration should return law stream
  if (tc.aspirationText.includes('lawyer') && stream !== 'law')
    errors.push(`stream=${stream} but aspiration is clearly law`);

  // Chunk must be loaded
  if (!chunkContent)
    errors.push('chunkContent is null — loadChunkContent returned nothing');

  // UK chunk must mention IELTS
  if (tc.destinationCountry === 'United Kingdom' && chunkContent
      && !chunkContent.includes('IELTS'))
    errors.push('UK chunk missing IELTS reference');

  // Germany chunk must mention APS
  if (tc.destinationCountry === 'Germany' && chunkContent
      && !chunkContent.includes('APS'))
    errors.push('Germany chunk missing APS reference');

  // India chunk must mention IGCSE warning
  if (tc.destinationCountry === 'India' && chunkContent
      && !chunkContent.includes('IGCSE'))
    errors.push('India chunk missing IGCSE reference');

  // India IB/A-Level must mention 75% rule
  if (tc.destinationCountry === 'India'
      && /ib|a.level/i.test(tc.board)
      && chunkContent && !chunkContent.includes('75%'))
    errors.push('India IB/A-Level chunk missing 75% rule');

  return errors;
}

// ─────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────

async function runTests() {
  console.log('\n' + '='.repeat(60));
  console.log('CHUNK RETRIEVAL + CONTAINER A TEST');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n── ${tc.label}`);
    console.log('   Calling Container A...');

    try {
      const result = await analyzeStudent(
        tc.aspirationText,
        tc.extracurricularText,
        [],   // marksData — empty
        {},   // lrpResponses — empty
        tc.studentProfile,
        tc.destinationCountry,
        null, // admissionGuide — null for this test
        null  // normalizedMarks — null
      );

      if (!result) {
        console.log('   ✗ Container A returned null');
        failed++;
        continue;
      }

      const stream  = result.stream;
      const clarity = result.aspiration_clarity;
      const must    = (result.search_strategy?.must_match || []).join(', ');

      console.log(`   Stream:    ${stream}`);
      console.log(`   Clarity:   ${clarity}`);
      console.log(`   MustMatch: ${must || 'none'}`);

      // Get chunk IDs from routing function
      const { chunks: chunkIds, reasons } = getRelevantChunks({
        stream,
        studentCategory: tc.studentProfile.studentCategoryLabel,
        board:           tc.board,
        passportCountry: tc.studentProfile.passportCountry,
        countryOfResidence: tc.studentProfile.countryOfResidence,
        destinationCountry: tc.destinationCountry
      });

      // Load actual chunk content
      const chunkContent = loadChunkContent(chunkIds, tc.destinationCountry);

      console.log(`   Chunks:    [${chunkIds.join(', ')}]`);
      console.log(`   Content:   ${chunkContent ? chunkContent.length + ' chars' : 'NULL'}`);

      // Validate
      const errors = validateResult(tc, stream, chunkIds, chunkContent);

      if (errors.length) {
        console.log(`   ✗ FAILED (${errors.length} error/s):`);
        errors.forEach(e => console.log(`     ! ${e}`));
        failed++;
      } else {
        console.log(`   ✓ PASSED`);
        passed++;
      }

    } catch (err) {
      console.log(`   ✗ ERROR: ${err.message}`);
      failed++;
    }

    // Delay between API calls
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60) + '\n');
}

// ─────────────────────────────────────────────────────
// EXTENDED TEST CASES — Tests 11-19
// ─────────────────────────────────────────────────────

const EXTENDED_TEST_CASES = [

  // ── UK NATIONAL, RESIDENT UAE, APPLYING UK ────────────────

  {
    label: 'Test 11 — UK passport, UAE resident → UK, Law',
    destinationCountry: 'United Kingdom',
    board: 'Cambridge A-Levels',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'Cambridge A-Levels',
      passportCountry: 'United Kingdom',
      countryOfResidence: 'UAE',
      studentCategoryLabel: 'UK national returning home for university',
      budgetUSD: 30000
    },
    marksData: [{
      grade: 'Grade 12', overall: 82,
      subjectsText: 'English Literature: 85, History: 80, Politics: 83, Mathematics: 78'
    }],
    aspirationText: 'I want to study law. I am passionate about human rights and want to help people who cannot afford lawyers. I want to make a difference in society.',
    extracurricularText: 'Debate club, Model UN, school newspaper editor.'
  },

  {
    label: 'Test 12 — UK passport, UAE resident → UK, Medicine',
    destinationCountry: 'United Kingdom',
    board: 'Cambridge A-Levels',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'Cambridge A-Levels',
      passportCountry: 'United Kingdom',
      countryOfResidence: 'UAE',
      studentCategoryLabel: 'UK national returning home for university',
      budgetUSD: 40000
    },
    marksData: [{
      grade: 'Grade 12', overall: 91,
      subjectsText: 'Chemistry: 93, Biology: 92, Mathematics: 89, Physics: 90'
    }],
    aspirationText: 'I am not fully sure what I want yet. People tell me I am good at science and I should become a doctor. My parents are both doctors. I like helping people and I am interested in how the human body works.',
    extracurricularText: 'Hospital volunteering, St John Ambulance, science olympiad.'
  },

  {
    label: 'Test 13 — UK passport, UAE resident → UK, Business',
    destinationCountry: 'United Kingdom',
    board: 'Cambridge A-Levels',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'Cambridge A-Levels',
      passportCountry: 'United Kingdom',
      countryOfResidence: 'UAE',
      studentCategoryLabel: 'UK national returning home for university',
      budgetUSD: 28000
    },
    marksData: [{
      grade: 'Grade 12', overall: 78,
      subjectsText: 'Economics: 82, Mathematics: 76, Business Studies: 80, English: 75'
    }],
    aspirationText: 'I am not that sure. Everyone says business is a safe choice and I like the idea of running my own company one day. I enjoy economics and find markets interesting. Maybe finance or entrepreneurship.',
    extracurricularText: 'School business club, organised a charity fundraiser, part-time at family business.'
  },

  // ── INDIAN PASSPORT, OMAN RESIDENT, APPLYING GERMANY ─────

  {
    label: 'Test 14 — Indian passport, Oman resident → Germany, Law',
    destinationCountry: 'Germany',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'CBSE',
      passportCountry: 'India',
      countryOfResidence: 'Oman',
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to Germany',
      budgetUSD: 15000
    },
    marksData: [{
      grade: 'Grade 12', overall: 82,
      subjectsText: 'English: 85, History: 80, Political Science: 83, Mathematics: 78, Economics: 80'
    }],
    aspirationText: 'I want to study law. I am passionate about human rights and want to help people who cannot afford lawyers. I want to make a difference in society.',
    extracurricularText: 'Debate club, Model UN.'
  },

  {
    label: 'Test 15 — Indian passport, Oman resident → Germany, Medicine',
    destinationCountry: 'Germany',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'CBSE',
      passportCountry: 'India',
      countryOfResidence: 'Oman',
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to Germany',
      budgetUSD: 15000
    },
    marksData: [{
      grade: 'Grade 12', overall: 91,
      subjectsText: 'Chemistry: 93, Biology: 92, Mathematics: 89, Physics: 90'
    }],
    aspirationText: 'I am not fully sure what I want yet. People tell me I am good at science and I should become a doctor. My parents are both doctors. I like helping people and I am interested in how the human body works.',
    extracurricularText: 'Hospital volunteering, science olympiad.'
  },

  {
    label: 'Test 16 — Indian passport, Oman resident → Germany, Business',
    destinationCountry: 'Germany',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'CBSE',
      passportCountry: 'India',
      countryOfResidence: 'Oman',
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to Germany',
      budgetUSD: 15000
    },
    marksData: [{
      grade: 'Grade 12', overall: 78,
      subjectsText: 'Economics: 82, Mathematics: 76, Business Studies: 80, English: 75, Accountancy: 79'
    }],
    aspirationText: 'I am not that sure. Everyone says business is a safe choice and I like the idea of running my own company one day. I enjoy economics and find markets interesting. Maybe finance or entrepreneurship.',
    extracurricularText: 'School business club, charity fundraiser.'
  },

  // ── INDIAN PASSPORT, OMAN RESIDENT, APPLYING INDIA ───────

  {
    label: 'Test 17 — Indian passport, Oman resident → India, Law',
    destinationCountry: 'India',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'CBSE',
      passportCountry: 'India',
      countryOfResidence: 'Oman',
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to India — NRI Gulf',
      budgetUSD: 15000
    },
    marksData: [{
      grade: 'Grade 12', overall: 82,
      subjectsText: 'English: 85, History: 80, Political Science: 83, Mathematics: 78, Economics: 80'
    }],
    aspirationText: 'I want to study law. I am passionate about human rights and want to help people who cannot afford lawyers. I want to make a difference in society.',
    extracurricularText: 'Debate club, Model UN.'
  },

  {
    label: 'Test 18 — Indian passport, Oman resident → India, Medicine',
    destinationCountry: 'India',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'CBSE',
      passportCountry: 'India',
      countryOfResidence: 'Oman',
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to India — NRI Gulf',
      budgetUSD: 15000
    },
    marksData: [{
      grade: 'Grade 12', overall: 91,
      subjectsText: 'Chemistry: 93, Biology: 92, Mathematics: 89, Physics: 90'
    }],
    aspirationText: 'I am not fully sure what I want yet. People tell me I am good at science and I should become a doctor. My parents are both doctors. I like helping people and I am interested in how the human body works.',
    extracurricularText: 'Hospital volunteering, science olympiad.'
  },

  {
    label: 'Test 19 — Indian passport, Oman resident → India, Business',
    destinationCountry: 'India',
    board: 'CBSE',
    studentProfile: {
      name: 'Test Student', grade: 'Grade 12',
      board: 'CBSE',
      passportCountry: 'India',
      countryOfResidence: 'Oman',
      studentCategoryLabel: 'Indian passport holder resident in Oman applying to India — NRI Gulf',
      budgetUSD: 15000
    },
    marksData: [{
      grade: 'Grade 12', overall: 78,
      subjectsText: 'Economics: 82, Mathematics: 76, Business Studies: 80, English: 75, Accountancy: 79'
    }],
    aspirationText: 'I am not that sure. Everyone says business is a safe choice and I like the idea of running my own company one day. I enjoy economics and find markets interesting. Maybe finance or entrepreneurship.',
    extracurricularText: 'School business club, charity fundraiser.'
  }

];

// ─────────────────────────────────────────────────────
// EXTENDED RUNNER — Tests 11-19
// ─────────────────────────────────────────────────────

function validateExtended(tc, result, chunkContent) {
  const errors = [];
  const sp = result.subject_profile || {};
  const el = result.eligibility    || {};
  const num = parseInt(tc.label.match(/Test (\d+)/)[1]);

  // Stream validation per test number
  const expectedStream = {
    11: 'law', 12: 'medicine', 13: 'business',
    14: 'law', 15: 'medicine', 16: 'business',
    17: 'law', 18: 'medicine', 19: 'business',
  };
  if (expectedStream[num] && result.stream !== expectedStream[num])
    errors.push(`stream="${result.stream}" expected "${expectedStream[num]}"`);

  // Test 11: UK passport → UK, language_test_required must be false
  if (num === 11 && sp.language_test_required !== false)
    errors.push(`language_test_required=${sp.language_test_required} expected false (UK national)`);

  // Tests 14-16: India → Germany, must mention APS
  if ([14, 15, 16].includes(num)) {
    const combinedText = (el.eligibility_reasoning || '') + ' ' + (result.counsellor_note || '');
    if (!combinedText.includes('APS'))
      errors.push('eligibility_reasoning/counsellor_note missing APS mention (CBSE→Germany)');
  }

  // Test 15: CBSE 91% medicine → Germany, foundation_year_required must be false
  if (num === 15 && sp.foundation_year_required !== false)
    errors.push(`foundation_year_required=${sp.foundation_year_required} expected false`);

  // Test 18: CBSE 91% medicine → India, foundation_year_required must be false
  if (num === 18 && sp.foundation_year_required !== false)
    errors.push(`foundation_year_required=${sp.foundation_year_required} expected false`);

  // Test 12: A-Levels 91% medicine → UK, foundation_year_required must be false
  if (num === 12 && sp.foundation_year_required !== false)
    errors.push(`foundation_year_required=${sp.foundation_year_required} expected false`);

  return errors;
}

async function runExtendedTests() {
  console.log('\n' + '='.repeat(60));
  console.log('EXTENDED CHUNK RETRIEVAL TEST — Tests 11-19');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const tc of EXTENDED_TEST_CASES) {
    console.log(`\n── ${tc.label}`);

    try {
      // Load chunk as admissionGuide
      const { chunks: chunkIds } = getRelevantChunks({
        stream:            null,   // not known yet — routing uses country only at this stage
        studentCategory:   tc.studentProfile.studentCategoryLabel,
        board:             tc.board,
        passportCountry:   tc.studentProfile.passportCountry,
        countryOfResidence: tc.studentProfile.countryOfResidence,
        destinationCountry: tc.destinationCountry
      });
      const chunkContent = loadChunkContent(chunkIds, tc.destinationCountry);

      const result = await analyzeStudent(
        tc.aspirationText,
        tc.extracurricularText,
        tc.marksData || [],
        {},
        tc.studentProfile,
        tc.destinationCountry,
        chunkContent,   // chunk as admissionGuide
        null
      );

      if (!result) {
        console.log('   ✗ analyzeStudent returned null');
        failed++;
        continue;
      }

      const sp = result.subject_profile || {};
      const el = result.eligibility    || {};

      console.log(`   stream: ${result.stream} | clarity: ${result.aspiration_clarity} | confidence: ${result.confidence}`);
      console.log(`   foundation_year_required: ${sp.foundation_year_required} | language_test_required: ${sp.language_test_required} | equivalency_required: ${sp.equivalency_required}`);
      console.log(`   eligible_global_tiers: ${JSON.stringify(el.eligible_global_tiers)} | tier1_tag: ${el.tier1_tag} | tier2_tag: ${el.tier2_tag}`);
      console.log(`   eligibility_reasoning: ${(el.eligibility_reasoning || '').slice(0, 200)}`);
      console.log(`   counsellor_note:       ${(result.counsellor_note || '').slice(0, 200)}`);
      console.log(`   chunk loaded: ${tc.destinationCountry} | ${chunkIds.join(', ')} | ${chunkContent ? chunkContent.length + ' chars' : 'NULL'}`);

      const errors = validateExtended(tc, result, chunkContent);

      if (errors.length) {
        console.log(`   ✗ FAILED (${errors.length} error/s):`);
        errors.forEach(e => console.log(`     ! ${e}`));
        failed++;
      } else {
        console.log(`   ✓ PASSED`);
        passed++;
      }

    } catch (err) {
      console.log(`   ✗ ERROR: ${err.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60) + '\n');
}

runExtendedTests();

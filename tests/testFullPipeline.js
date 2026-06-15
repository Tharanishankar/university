// backend/tests/testFullPipeline.js
// Full pipeline ATP — 18 test cases
// Run: node backend/tests/testFullPipeline.js
// Requires backend server running on localhost:3001

const https = require('https');
const http = require('http');

const BASE_URL = 'http://localhost:3001';

async function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const start = Date.now();
    const req = http.request(
      `${BASE_URL}/api/analyze`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data), elapsed });
          } catch {
            resolve({ status: res.statusCode, body: null, elapsed, raw: data.slice(0, 200) });
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(300000); // 5 min timeout
    req.write(body);
    req.end();
  });
}

function assess(tc, result) {
  const issues = [];
  const { status, body, elapsed } = result;

  if (status !== 200) {
    issues.push(`HTTP ${status}`);
    return { issues, recs: 0, elapsed };
  }
  if (!body) {
    issues.push('No response body');
    return { issues, recs: 0, elapsed };
  }

  const recs = body.recommendations || [];
  const count = recs.length;

  // Expected rec count
  if (tc.expectNoRecs && count > 0)
    issues.push(`Expected 0 recs but got ${count}`);
  if (!tc.expectNoRecs && count === 0)
    issues.push('Got 0 recommendations — pipeline may have failed');
  if (!tc.expectNoRecs && count < 5 && !tc.expectFewRecs)
    issues.push(`Only ${count} recs — thin pool?`);

  // Country distribution
  if (!tc.expectNoRecs && count > 0) {
    const countries = [...new Set(recs.map(r => r.destinationCountry))];
    const expected = tc.destinations.map(d => d.country);
    expected.forEach(c => {
      if (!countries.includes(c))
        issues.push(`No recs for ${c}`);
    });
  }

  // Consistency check
  if (tc.consistencyRun && tc.previousRecs) {
    const currentNames = recs.map(r => r.universityName).sort();
    const prevNames = tc.previousRecs.sort();
    const overlap = currentNames.filter(n => prevNames.includes(n)).length;
    const pct = Math.round((overlap / Math.max(currentNames.length, 1)) * 100);
    if (pct < 70) issues.push(`Low consistency — only ${pct}% overlap with previous run`);
    else issues.push(`Consistency: ${pct}% overlap ✓`);
  }

  // Tag check
  if (!tc.expectNoRecs && count > 0) {
    const hasValidTag = recs.every(r => ['REACH','MATCH','SAFE'].includes(r.tag));
    if (!hasValidTag) issues.push('Invalid tag found');
    const reachCount = recs.filter(r => r.tag === 'REACH').length;
    const matchCount = recs.filter(r => r.tag === 'MATCH').length;
    issues.push(`Tags: ${reachCount} REACH, ${matchCount} MATCH`);
  }

  // Duplicate university check
  if (count > 0) {
    const uniNames = recs.map(r => r.universityName);
    const dupes = uniNames.filter((n, i) => uniNames.indexOf(n) !== i);
    if (dupes.length > 0) issues.push(`Duplicate universities: ${[...new Set(dupes)].join(', ')}`);
  }

  // liveRequirements check
  if (!tc.expectNoRecs && count > 0) {
    const nullLive = recs.filter(r => !r.liveRequirements).length;
    if (nullLive > 0) issues.push(`${nullLive} recs have null liveRequirements`);
  }

  return { issues, recs: count, elapsed, recNames: recs.map(r => r.universityName) };
}

const TEST_CASES = [

  // ── CONSISTENCY TESTS (same profile run 3 times) ──────────────────────────
  {
    id: 'C1',
    label: 'Consistency Run 1 — Indian NRI Gulf, CBSE 85%, Engineering, UK+India',
    consistencyGroup: 'baseline',
    destinations: [
      { country: 'United Kingdom', priority: 1 },
      { country: 'India', priority: 2 }
    ],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 85, subjectsText: 'Physics: 87, Chemistry: 84, Mathematics: 86, English: 82, Computer Science: 88' }],
        aspiration: 'I love computers and robotics. I want to study engineering.',
        extracurricular: 'Robotics club, coding competition.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'India', priority: 2, slots: 5 }],
        minBudget: 15000, maxBudget: 40000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'C2',
    label: 'Consistency Run 2 — same profile as C1',
    consistencyGroup: 'baseline',
    destinations: [
      { country: 'United Kingdom', priority: 1 },
      { country: 'India', priority: 2 }
    ],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 85, subjectsText: 'Physics: 87, Chemistry: 84, Mathematics: 86, English: 82, Computer Science: 88' }],
        aspiration: 'I love computers and robotics. I want to study engineering.',
        extracurricular: 'Robotics club, coding competition.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'India', priority: 2, slots: 5 }],
        minBudget: 15000, maxBudget: 40000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'C3',
    label: 'Consistency Run 3 — same profile as C1',
    consistencyGroup: 'baseline',
    destinations: [
      { country: 'United Kingdom', priority: 1 },
      { country: 'India', priority: 2 }
    ],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 85, subjectsText: 'Physics: 87, Chemistry: 84, Mathematics: 86, English: 82, Computer Science: 88' }],
        aspiration: 'I love computers and robotics. I want to study engineering.',
        extracurricular: 'Robotics club, coding competition.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'India', priority: 2, slots: 5 }],
        minBudget: 15000, maxBudget: 40000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── LOW MARKS — boundary and below threshold ──────────────────────────────
  {
    id: 'L1',
    label: 'Low marks — CBSE 45% — should get very limited or no Tier 1/2 recs',
    expectFewRecs: true,
    destinations: [{ country: 'United Kingdom', priority: 1 }, { country: 'India', priority: 2 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 45, subjectsText: 'Physics: 42, Chemistry: 44, Mathematics: 48, English: 50, Computer Science: 41' }],
        aspiration: 'I want to study engineering.',
        extracurricular: 'Cricket.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'India', priority: 2, slots: 5 }],
        minBudget: 10000, maxBudget: 25000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'L2',
    label: 'Border marks — CBSE 60% — borderline Tier 3/4',
    expectFewRecs: true,
    destinations: [{ country: 'India', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 60, subjectsText: 'Physics: 58, Chemistry: 62, Mathematics: 61, English: 63, Computer Science: 56' }],
        aspiration: 'I want to study computer science or IT.',
        extracurricular: 'Chess club.',
        passportCountry: 'India', countryOfResidence: 'India',
        destinationCountries: [{ country: 'India', priority: 1, slots: 10 }],
        minBudget: 5000, maxBudget: 15000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── HIGH MARKS ────────────────────────────────────────────────────────────
  {
    id: 'H1',
    label: 'High marks — IB 42/45 — should get Tier 1 REACH + MATCH',
    destinations: [{ country: 'United Kingdom', priority: 1 }, { country: 'Germany', priority: 2 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'IB Diploma',
        marks: [{ grade: 'Grade 12', overall: 42, subjectsText: 'Mathematics: 7, Physics: 7, Chemistry: 6, English: 7, Economics: 6' }],
        aspiration: 'I want to study engineering at a top university. I am interested in aerospace and advanced manufacturing.',
        extracurricular: 'Science olympiad, robotics team captain, school council.',
        passportCountry: 'India', countryOfResidence: 'UAE',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'Germany', priority: 2, slots: 5 }],
        minBudget: 30000, maxBudget: 60000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'H2',
    label: 'High marks — Cambridge A-Levels AAA — UK Law',
    destinations: [{ country: 'United Kingdom', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'Cambridge A-Levels',
        marks: [{ grade: 'Grade 12', overall: 90, subjectsText: 'English Literature: 92, History: 91, Politics: 89' }],
        aspiration: 'I want to study law. I am passionate about human rights and constitutional law.',
        extracurricular: 'Debate champion, Model UN, school newspaper.',
        passportCountry: 'United Kingdom', countryOfResidence: 'UAE',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 10 }],
        minBudget: 20000, maxBudget: 45000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── DIFFERENT STREAMS ─────────────────────────────────────────────────────
  {
    id: 'S1',
    label: 'Medicine stream — CBSE 92% PCB — India + UK',
    destinations: [{ country: 'India', priority: 1 }, { country: 'United Kingdom', priority: 2 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 92, subjectsText: 'Biology: 95, Chemistry: 93, Physics: 88, English: 90, Mathematics: 87' }],
        aspiration: 'I want to become a doctor. I am interested in surgery and want to help patients. My parents are both doctors.',
        extracurricular: 'Hospital volunteering, first aid certification.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [{ country: 'India', priority: 1, slots: 5 }, { country: 'United Kingdom', priority: 2, slots: 5 }],
        minBudget: 20000, maxBudget: 50000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'S2',
    label: 'Business stream — CBSE 78% Commerce — India',
    destinations: [{ country: 'India', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 78, subjectsText: 'Accountancy: 82, Business Studies: 80, Economics: 79, English: 75, Mathematics: 74' }],
        aspiration: 'I want to study business management or finance. I want to run my own company one day.',
        extracurricular: 'School business club, part-time at family shop.',
        passportCountry: 'India', countryOfResidence: 'India',
        destinationCountries: [{ country: 'India', priority: 1, slots: 10 }],
        minBudget: 8000, maxBudget: 20000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'S3',
    label: 'Design/Arts stream — IB 34 — UK',
    destinations: [{ country: 'United Kingdom', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'IB Diploma',
        marks: [{ grade: 'Grade 12', overall: 34, subjectsText: 'Visual Arts: 6, Design Technology: 6, English: 5, Mathematics: 5, Psychology: 5' }],
        aspiration: 'I love design and creativity. I want to study product design or graphic design. I have been drawing since I was 5.',
        extracurricular: 'Art club, won school design competition, freelance logo design.',
        passportCountry: 'UAE', countryOfResidence: 'UAE',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 10 }],
        minBudget: 20000, maxBudget: 40000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── DIFFERENT NATIONALITIES ───────────────────────────────────────────────
  {
    id: 'N1',
    label: 'Pakistani passport, Karachi resident, A-Levels, Engineering — UK + Germany',
    destinations: [{ country: 'United Kingdom', priority: 1 }, { country: 'Germany', priority: 2 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'Cambridge A-Levels',
        marks: [{ grade: 'Grade 12', overall: 83, subjectsText: 'Mathematics: 85, Physics: 84, Chemistry: 80' }],
        aspiration: 'I want to study mechanical or electrical engineering.',
        extracurricular: 'Robotics club, cricket team.',
        passportCountry: 'Pakistan', countryOfResidence: 'Pakistan',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'Germany', priority: 2, slots: 5 }],
        minBudget: 15000, maxBudget: 35000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'N2',
    label: 'UAE national, Dubai resident, EmSAT + IGCSE, Business — UK',
    destinations: [{ country: 'United Kingdom', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'Cambridge IGCSE',
        marks: [{ grade: 'Grade 12', overall: 75, subjectsText: 'Mathematics: 78, English: 76, Economics: 74, Business: 77' }],
        aspiration: 'I want to study business or economics. I am interested in finance and investment.',
        extracurricular: 'School investment club, family business experience.',
        passportCountry: 'UAE', countryOfResidence: 'UAE',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 10 }],
        minBudget: 25000, maxBudget: 50000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'N3',
    label: 'Egyptian passport, Cairo resident, Thanaweya Amma, Engineering — Germany',
    destinations: [{ country: 'Germany', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'Thanaweya Amma',
        marks: [{ grade: 'Grade 12', overall: 88, subjectsText: 'Mathematics: 90, Physics: 89, Chemistry: 86, English: 85' }],
        aspiration: 'I want to study engineering in Germany. I am interested in mechanical engineering and automotive industry.',
        extracurricular: 'Science fair, football team.',
        passportCountry: 'Egypt', countryOfResidence: 'Egypt',
        destinationCountries: [{ country: 'Germany', priority: 1, slots: 10 }],
        minBudget: 5000, maxBudget: 15000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── VAGUE ASPIRATION ──────────────────────────────────────────────────────
  {
    id: 'V1',
    label: 'Very vague aspiration — no clear stream — India',
    destinations: [{ country: 'India', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 72, subjectsText: 'English: 75, History: 70, Political Science: 73, Economics: 72, Geography: 69' }],
        aspiration: 'I am not sure what I want to study. Maybe something related to people or society. I like talking to people.',
        extracurricular: 'School cultural fest organiser.',
        passportCountry: 'India', countryOfResidence: 'India',
        destinationCountries: [{ country: 'India', priority: 1, slots: 10 }],
        minBudget: 5000, maxBudget: 15000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── BUDGET EDGE CASES ─────────────────────────────────────────────────────
  {
    id: 'B1',
    label: 'Very tight budget — $5K-$10K — India only',
    destinations: [{ country: 'India', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 80, subjectsText: 'Physics: 82, Chemistry: 79, Mathematics: 81, English: 78, Computer Science: 80' }],
        aspiration: 'I want to study computer science or software engineering.',
        extracurricular: 'Coding club.',
        passportCountry: 'India', countryOfResidence: 'India',
        destinationCountries: [{ country: 'India', priority: 1, slots: 10 }],
        minBudget: 5000, maxBudget: 10000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  {
    id: 'B2',
    label: 'High budget — $80K-$120K — UK + USA',
    destinations: [{ country: 'United Kingdom', priority: 1 }, { country: 'USA', priority: 2 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'IB Diploma',
        marks: [{ grade: 'Grade 12', overall: 38, subjectsText: 'Mathematics: 7, Physics: 6, Computer Science: 6, English: 6, Economics: 6' }],
        aspiration: 'I want to study computer science at a top university. I am interested in AI and machine learning.',
        extracurricular: 'Competitive programming, AI research intern.',
        passportCountry: 'India', countryOfResidence: 'UAE',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 5 }, { country: 'USA', priority: 2, slots: 5 }],
        minBudget: 80000, maxBudget: 120000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── GRADE 10 STUDENT ──────────────────────────────────────────────────────
  {
    id: 'G1',
    label: 'Grade 10 student — IGCSE — early planning',
    expectFewRecs: true,
    destinations: [{ country: 'United Kingdom', priority: 1 }],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 10', board: 'Cambridge IGCSE',
        marks: [{ grade: 'Grade 10', overall: 82, subjectsText: 'Mathematics: 85, Physics: 83, Chemistry: 80, English: 81, Computer Science: 84' }],
        aspiration: 'I want to study engineering. I love maths and science.',
        extracurricular: 'Robotics club.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [{ country: 'United Kingdom', priority: 1, slots: 10 }],
        minBudget: 20000, maxBudget: 40000, currency: 'USD'
      },
      lrpResponses: {}
    }
  },

  // ── THREE DESTINATIONS ────────────────────────────────────────────────────
  {
    id: 'T1',
    label: 'Three destinations — UK + India + Germany — Engineering',
    destinations: [
      { country: 'United Kingdom', priority: 1 },
      { country: 'India', priority: 2 },
      { country: 'Germany', priority: 3 }
    ],
    payload: {
      studentProfile: {
        name: 'Test Student', grade: 'Grade 12', board: 'CBSE',
        marks: [{ grade: 'Grade 12', overall: 87, subjectsText: 'Physics: 89, Chemistry: 86, Mathematics: 88, English: 84, Computer Science: 90' }],
        aspiration: 'I want to study computer science or software engineering. I am open to different countries.',
        extracurricular: 'Competitive programming, open source contributor.',
        passportCountry: 'India', countryOfResidence: 'Oman',
        destinationCountries: [
          { country: 'United Kingdom', priority: 1, slots: 4 },
          { country: 'India', priority: 2, slots: 3 },
          { country: 'Germany', priority: 3, slots: 3 }
        ],
        minBudget: 10000, maxBudget: 40000, currency: 'USD'
      },
      lrpResponses: {}
    }
  }
];

async function run() {
  console.log('\n' + '='.repeat(70));
  console.log('DREAM-VANTAGE FULL PIPELINE ATP — 18 TEST CASES');
  console.log('='.repeat(70));

  const consistencyResults = {};
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n── ${tc.id}: ${tc.label}`);

    let result;
    try {
      result = await post(tc.payload);
    } catch (err) {
      console.log(`   ✗ Request failed: ${err.message}`);
      failed++;
      continue;
    }

    // Attach previous consistency results
    if (tc.consistencyGroup && consistencyResults[tc.consistencyGroup]) {
      tc.consistencyRun = true;
      tc.previousRecs = consistencyResults[tc.consistencyGroup];
    }

    const { issues, recs, elapsed, recNames } = assess(tc, result);

    // Store for consistency comparison
    if (tc.consistencyGroup && recNames) {
      consistencyResults[tc.consistencyGroup] = recNames;
    }

    console.log(`   Time: ${elapsed}s | Recs: ${recs}`);

    if (recNames && recNames.length > 0) {
      console.log(`   Universities: ${recNames.slice(0, 5).join(', ')}${recNames.length > 5 ? '...' : ''}`);
    }

    const errors = issues.filter(i =>
      !i.startsWith('Tags:') && !i.startsWith('Consistency:')
    );
    const info = issues.filter(i =>
      i.startsWith('Tags:') || i.startsWith('Consistency:')
    );

    info.forEach(i => console.log(`   ℹ ${i}`));

    if (errors.length === 0) {
      console.log(`   ✓ PASS`);
      passed++;
    } else {
      errors.forEach(e => console.log(`   ✗ ${e}`));
      if (errors.every(e => e.includes('thin pool') || e.includes('Only'))) {
        console.log(`   ⚠ WARN`);
        warnings++;
      } else {
        console.log(`   ✗ FAIL`);
        failed++;
      }
    }

    // Small delay between tests
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n' + '='.repeat(70));
  console.log(`RESULTS: ${passed} PASS  |  ${warnings} WARN  |  ${failed} FAIL`);
  console.log('='.repeat(70) + '\n');
}

run().catch(console.error);

const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { analyzeStudent, generateWhyThisUni, scorePrograms } = require('../services/claude');
const {
  normalizeMarks,
  calculateTrend,
  predictGrade12,
  assignTiers,
  getReachTag,
  determineStudentCategory
} = require('../services/prediction');
const { scoreUniversity } = require('../services/scoring');
const { runContainerA } = require('../containers/containerA');
const { runContainerB } = require('../containers/containerB');
const { runContainerC } = require('../containers/containerC');
const { runContainerF }   = require('../containers/containerF');
const { fetchRankings }   = require('../containers/containerRankings');
const { compareRank }     = require('../utils/rankScore');
const { loadChunkContent } = require('../utils/loadChunkContent');
const { loadScholarshipChunks, getScholarshipGuide } = require('../utils/loadScholarshipChunks');
const { fetchUniversityScholarships } = require('../containers/containerScholarships');
const {
  convertToUSD,
  getStretchDelta,
  FX_RATES_TO_USD,
  fxRatesStale,
} = require('../services/budgetScoring');
const { COUNTRY_CURRENCY } = require('../services/fxRates');
const { deriveCountryBudget } = require('../services/budgetMapping');

// Sub-field → must_match keyword seeds
// Used to seed must_match before Container A runs
// Container A refines these — does not start from scratch
const SUB_FIELD_KEYWORDS = {
  // Engineering
  robotics:       ['robotics', 'automation', 'mechatronics'],
  mechanical:     ['mechanical', 'manufacturing', 'thermal engineering'],
  aerospace:      ['aerospace', 'aviation', 'aeronautical'],
  cs_software:    ['computer science', 'software engineering', 'computing'],
  electrical:     ['electrical engineering', 'electronics', 'power systems'],
  civil:          ['civil engineering', 'structural', 'construction'],
  chemical:       ['chemical engineering', 'process engineering', 'materials'],
  biomedical:     ['biomedical engineering', 'clinical engineering'],
  ai_data:        ['artificial intelligence', 'data science', 'machine learning'],
  // Medicine
  mbbs:           ['medicine', 'medical', 'mbbs'],
  dentistry:      ['dentistry', 'dental'],
  pharmacy:       ['pharmacy', 'pharmaceutical'],
  nursing:        ['nursing', 'healthcare'],
  biomedical_med: ['biomedical sciences', 'biomedical'],
  veterinary:     ['veterinary', 'animal science'],
  public_health:  ['public health', 'epidemiology'],
  // Law
  corporate_law:  ['corporate law', 'business law', 'commercial law'],
  criminal_law:   ['criminal law', 'criminology'],
  human_rights:   ['human rights', 'international law'],
  constitutional: ['constitutional law', 'public law'],
  // Business
  finance:        ['finance', 'financial economics', 'banking'],
  marketing:      ['marketing', 'communications', 'advertising'],
  entrepreneurship: ['entrepreneurship', 'innovation management'],
  accounting:     ['accounting', 'accountancy', 'audit'],
  international:  ['international business', 'global business'],
  // Design
  product:        ['product design', 'industrial design'],
  graphic:        ['graphic design', 'visual communication'],
  architecture:   ['architecture', 'architectural'],
  fashion:        ['fashion design', 'fashion'],
  interior:       ['interior design', 'interior architecture'],
  ux_digital:     ['user experience', 'digital design', 'interaction design'],
  // Arts
  psychology:     ['psychology', 'psychological'],
  economics:      ['economics', 'economic'],
  political_sci:  ['political science', 'politics', 'international relations'],
  history:        ['history', 'historical'],
  literature:     ['literature', 'english', 'linguistics'],
  philosophy:     ['philosophy', 'philosophical'],
  // Science
  physics:        ['physics', 'physical sciences'],
  chemistry:      ['chemistry', 'chemical sciences'],
  biology:        ['biology', 'biological sciences', 'life sciences'],
  mathematics:    ['mathematics', 'mathematical', 'statistics'],
  environmental:  ['environmental science', 'environmental studies'],
  geology:        ['geology', 'earth sciences', 'geoscience'],
  // Sports
  sports_science: ['sports science', 'exercise science'],
  physiotherapy:  ['physiotherapy', 'physical therapy'],
  sports_mgmt:    ['sports management', 'sports business'],
  coaching:       ['coaching', 'physical education'],
};

// ── Broad-word blocklist (module-level) ─────────────────────────────────
// Applied to BOTH mustMatch expansion AND general keyword expansion.
// Blocks stream-level words that match too broadly when used as individual terms.
// Full phrases are always kept — only the individual WORDS extracted from
// multi-word phrases are filtered.
//
// Rule: only block words that appear in programmes across ALL streams
// and therefore carry no discriminating signal on their own.
//
// DO NOT block subject-specific words like 'management', 'business',
// 'arts', 'design' — those are the primary identifier for their domain.
// A management student searching 'business management' needs 'management'
// to surface 'BA Management' programmes.
//
// 'engineering' IS blocked because every sub-field (aerospace, mechanical,
// civil) already has a more specific keyword. 'engineering' alone matches
// 3000+ programmes and adds no filtering value.
// 'systems' IS blocked — without context it matches biosystems, geosystems,
// embedded systems, etc., pulling in completely unrelated fields. "Computer
// systems" or "software systems" as full phrases are still kept.
// 'advanced' IS blocked — decorative word with no field signal on its own.
// 'digital' is intentionally NOT blocked — it consistently signals the
// tech/media orbit and is useful signal for explore recs.
const BROAD_WORD_BLOCKLIST = new Set([
  'engineering', 'science', 'technology',
  'studies', 'bachelor', 'undergraduate',
  'program', 'degree', 'general', 'applied',
  'systems',   // too broad — matches biosystems, geosystems, etc. when intent is CS/software
  'advanced',  // too broad — decorative word, appears across all programme names
]);

// ── Keyword expansion utilities ──────────────────────────────────────────
// Splits multi-word keyword phrases into individual words
// so partial matches work across all streams and programs.
// Example: "aerospace engineering" → ["aerospace engineering", "aerospace"]
//   ("engineering" blocked by BROAD_WORD_BLOCKLIST)
// Example: "criminal law" → ["criminal law", "criminal"]
//   ("law" is only 3 chars — excluded by length filter)
// Words shorter than 4 chars are excluded (avoids matching 'of', 'and', 'in' etc.)
// Original phrase is always kept alongside individual words.

function expandKeywords(keywords) {
  const expanded = new Set();
  for (const kw of (keywords || [])) {
    const clean = String(kw).toLowerCase().trim();
    if (!clean) continue;
    expanded.add(clean); // always keep original phrase regardless of blocklist
    clean.split(/\s+/)
      .filter(w => w.length > 3 && !BROAD_WORD_BLOCKLIST.has(w))
      .forEach(w => expanded.add(w));
  }
  return [...expanded];
}

// Same as expandKeywords but also filters the FULL PHRASE through the blocklist.
// Use for mustMatch keywords only — prevents a phrase like 'engineering' (single word)
// from being kept even as a phrase.
function expandMustMatchKeywords(keywords, blocklist) {
  const expanded = new Set();
  for (const kw of (keywords || [])) {
    const clean = String(kw).toLowerCase().trim();
    if (!clean || blocklist.has(clean)) continue; // block single-word phrases too
    expanded.add(clean);
    clean.split(/\s+/)
      .filter(w => w.length > 3 && !BROAD_WORD_BLOCKLIST.has(w))
      .forEach(w => expanded.add(w));
  }
  return [...expanded];
}

/**
 * Container I — Fallback chain
 *
 * Runs when budget exclusions leave fewer than 10 results.
 * Step 1: Expand stretchDelta × 1.5
 * Step 2: Drop min budget filter
 * Step 3: Drop all caps — return full sorted list
 *
 * Flags fallback unis with budgetFallbackTriggered = true
 * so frontend can optionally display a budget warning.
 */
function triggerBudgetFallback(allScored, studentBudget) {
  const expandedDelta =
    getStretchDelta(studentBudget.maxUSD) * 1.5;
  const expandedCeiling = studentBudget.maxUSD + expandedDelta;

  // Step 1 — expand stretch ceiling by 50%
  let step1 = allScored.filter(r => {
    if (r.budgetFallback) return true;  // V1 fallback unis ok
    if (!r.budgetExcluded) return true;
    if (r.budgetExclusionReason === 'above_stretch') {
      return r.feeUSD <= expandedCeiling;
    }
    return false; // still exclude below_min
  });

  if (step1.length >= 10) {
    step1.forEach(r => {
      if (r.budgetExcluded) {
        r.budgetFallbackTriggered = true;
        r.budgetFallbackStep = 1;
      }
    });
    return step1;
  }

  // Step 2 — drop min filter (include below_min too)
  let step2 = allScored.filter(r => {
    if (!r.budgetExcluded) return true;
    if (r.budgetExclusionReason === 'below_min') return true;
    if (r.budgetExclusionReason === 'above_stretch') {
      return r.feeUSD <= expandedCeiling;
    }
    return false;
  });

  if (step2.length >= 10) {
    step2.forEach(r => {
      if (r.budgetExcluded) {
        r.budgetFallbackTriggered = true;
        r.budgetFallbackStep = 2;
      }
    });
    return step2;
  }

  // Step 3 — drop all caps, return everything
  console.warn(
    `[budget] FALLBACK STEP 3: dropping all budget caps.` +
    ` Only ${step2.length} unis available.`
  );
  return allScored.map(r => {
    if (r.budgetExcluded) {
      r.budgetFallbackTriggered = true;
      r.budgetFallbackStep = 3;
    }
    return r;
  });
}

function getReachAndMatchTiers(tierEligibility, claudeEligibility) {

  // ── Path 1: Claude judgment (PRIMARY) ──────────────────────
  // Claude receives the qualification_recognition RAG chunk
  // and makes a country-aware, stream-aware, board-aware judgment.
  // This is always preferred over the math path because Claude
  // has country-specific grounding via the qualification_recognition chunk.
  const VALID_TAGS = new Set(['MATCH', 'REACH', 'SAFE', 'ASPIRATIONAL', 'NOT_REALISTIC']);
  // tier1 can be null when student has no realistic chance at elite universities
  // tier4 is always eligible so null is acceptable there too
  // Only require tier2 and tier3 to be valid non-null tags
  const claudeValid = (
    claudeEligibility &&
    VALID_TAGS.has(claudeEligibility.tier2_tag) &&
    VALID_TAGS.has(claudeEligibility.tier3_tag)
  );

  if (claudeValid) {
    const tags = {
      1: claudeEligibility.tier1_tag,
      2: claudeEligibility.tier2_tag,
      3: claudeEligibility.tier3_tag,
      4: claudeEligibility.tier4_tag,
    };

    // matchTier = first tier tagged MATCH or SAFE (best realistic tier)
    let matchTier = null;
    for (let t = 1; t <= 4; t++) {
      if (tags[t] === 'MATCH' || tags[t] === 'SAFE') {
        matchTier = t;
        break;
      }
    }
    if (!matchTier) matchTier = 3; // hard default

    // reachTier = tier immediately above match, only if tagged REACH
    let reachTier = null;
    if (matchTier > 1 && tags[matchTier - 1] === 'REACH') {
      reachTier = matchTier - 1;
    }

    console.log(
      `[tierSelection] Claude judgment:`,
      `match=${matchTier} reach=${reachTier}`,
      `tags=${JSON.stringify(tags)}`
    );
    return { matchTier, reachTier };
  }

  // ── Path 2: Math safety net (FALLBACK) ─────────────────────
  // Only fires when Claude returns invalid or missing tags.
  // Uses normalizedMarks against global thresholds.
  // Less accurate — no country or stream awareness.
  // Kept as a reliable fallback when Claude API fails.
  const hasValidMath = (
    tierEligibility?.effectiveMarks !== null &&
    tierEligibility?.effectiveMarks !== undefined
  );

  if (hasValidMath) {
    const tiers = [
      tierEligibility.tier1 || 'not_realistic',
      tierEligibility.tier2 || 'not_realistic',
      tierEligibility.tier3 || 'not_realistic',
      tierEligibility.tier4 || 'eligible',
    ];

    let matchTier = null;
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i] === 'eligible') { matchTier = i + 1; break; }
    }
    if (!matchTier) matchTier = 3;

    let reachTier = null;
    if (matchTier > 1 && tiers[matchTier - 2] === 'aspirational') {
      reachTier = matchTier - 1;
    }

    console.log(
      `[tierSelection] Math fallback:`,
      `match=${matchTier} reach=${reachTier}`,
      `effectiveMarks=${tierEligibility.effectiveMarks}`
    );
    return { matchTier, reachTier };
  }

  // ── Path 3: Hard default ────────────────────────────────────
  console.warn('[tierSelection] Both Claude and math failed — using default match=3');
  return { matchTier: 3, reachTier: null };
}

async function enrichWithAdditionalPrograms(
  top10,
  mustMatchKeywords,
  shouldMatchKeywords,
  supabaseClient,
  secondaryIntentKeywords = []
) {
  const uniIds = [
    ...new Set(top10.map(r => r.universityId))
  ];

  const { data: allPrograms, error } =
    await supabaseClient
      .from('programs')
      .select(`
        id, name, field_of_study,
        degree_level, duration_years,
        delivery_mode, program_url,
        university_id,
        tuition_fees (
          student_category,
          annual_fee, currency,
          academic_year
        ),
        entrance_tests (
          test_name, is_mandatory
        ),
        admission_requirements (
          subject_group, min_percentage
        )
      `)
      .in('university_id', uniIds)
      .eq('is_active', true);

  if (error || !allPrograms) {
    console.warn(
      '[enrichPrograms] DB query failed:',
      error?.message
    );
    return top10.map(r => ({
      ...r,
      programs: [{
        programId:         r.programId,
        programName:       r.programName,
        fitScore:          r.fitScore,
        tag:               r.tag,
        breakdown:         r.breakdown,
        budgetZone:        r.budgetZone,
        budgetBadge:       r.budgetBadge,
        programMatch:      r.programMatch,
        liveRequirements:  null,
        annualFeeRaw:      r.annualFeeRaw,
        annualFeeCurrency: r.annualFeeCurrency,
        annualFeeUSD:      r.annualFeeUSD,
        degreeLevel:       r.degreeLevel,
        durationYears:     r.durationYears,
        deliveryMode:      r.deliveryMode,
        examRequired:      r.examRequired,
        admissionPathway:  r.admissionPathway,
      }]
    }));
  }

  const byUni = new Map();
  for (const p of allPrograms) {
    const uid = p.university_id;
    if (!byUni.has(uid)) byUni.set(uid, []);
    byUni.get(uid).push(p);
  }

  const mustKw =
    mustMatchKeywords.map(
      k => k.toLowerCase()
    );
  const allKeywords = [
    ...mustMatchKeywords,
    ...shouldMatchKeywords,
    ...secondaryIntentKeywords
  ].map(k => k.toLowerCase());

  return top10.map(rec => {
    const uniPrograms =
      byUni.get(rec.universityId) || [];

    const additional = [];

    for (const p of uniPrograms) {
      if (p.id === rec.programId) continue;

      const normDeg = d => (d || '').replace(/[\.\s]+/g, '').toLowerCase();
      if (normDeg(p.degree_level) !== normDeg(rec.degreeLevel)) continue;

      const pName =
        (p.name || '').toLowerCase();
      const pField =
        (p.field_of_study || '').toLowerCase();

      const matchesAny = allKeywords.some(
        k => pName.includes(k) ||
             pField.includes(k)
      );
      if (!matchesAny) continue;

      const score = mustKw.some(
        k => pName.includes(k) ||
             pField.includes(k)
      ) ? 2 : 1;

      additional.push({ p, score });
    }

    additional.sort((a, b) =>
      b.score - a.score ||
      (a.p.name || '').localeCompare(
        b.p.name || ''
      )
    );

    const extras = additional
      .slice(0, 2)
      .map(({ p }) => {
        const fee = (p.tuition_fees || [])
          .find(f =>
            f.student_category === 'non_eu' ||
            f.student_category ===
              'international'
          ) || p.tuition_fees?.[0];

        return {
          programId:         p.id,
          programName:       p.name,
          fitScore:          null,
          tag:               null,
          breakdown:         null,
          budgetZone:        null,
          budgetBadge:       null,
          programMatch:      mustKw.some(
            k =>
              (p.name || '').toLowerCase()
                .includes(k) ||
              (p.field_of_study || '')
                .toLowerCase().includes(k)
          ) ? 'direct' : 'related',
          liveRequirements:  null,
          annualFeeRaw:      fee?.annual_fee
                               ?? null,
          annualFeeCurrency: fee?.currency
                               ?? null,
          annualFeeUSD:      null,
          degreeLevel:       p.degree_level,
          durationYears:     p.duration_years,
          deliveryMode:      p.delivery_mode,
          examRequired: (
            p.entrance_tests || []
          ).some(t => t.is_mandatory),
          admissionPathway:  null,
        };
      });

    const programs = [
      {
        programId:         rec.programId,
        programName:       rec.programName,
        fitScore:          rec.fitScore,
        tag:               rec.tag,
        breakdown:         rec.breakdown,
        budgetZone:        rec.budgetZone,
        budgetBadge:       rec.budgetBadge,
        programMatch:      rec.programMatch,
        liveRequirements:  null,
        annualFeeRaw:      rec.annualFeeRaw,
        annualFeeCurrency: rec.annualFeeCurrency,
        annualFeeUSD:      rec.annualFeeUSD,
        degreeLevel:       rec.degreeLevel,
        durationYears:     rec.durationYears,
        deliveryMode:      rec.deliveryMode,
        examRequired:      rec.examRequired,
        admissionPathway:  rec.admissionPathway,
      },
      ...extras
    ];

    return { ...rec, programs };
  });
}

// POST /api/analyze — main recommendation engine
router.post('/', async (req, res) => {
  try {
    const { studentProfile, lrpResponses } = req.body;

    // ── Validation ───────────────────────────────────────────────────────────
    // Normalise destination input
    // Accepts both old single string and
    // new destinationCountries array
    // ─────────────────────────────────
    let destinationCountries = [];

    // Backend is source of truth for slot allocation.
    // candidateSlotMap: how many programs to score per country.
    // finalSlotMap: how many to output (frontend sends these as slots).
    const candidateSlotMap = { 1: [15], 2: [9, 6], 3: [7, 5, 3] };
    const finalSlotMap     = { 1: [10], 2: [6, 4], 3: [5, 3, 2] };

    // Parse incoming — extract raw destination list
    let rawDestinations = [];
    if (
      Array.isArray(studentProfile.destinationCountries) &&
      studentProfile.destinationCountries.length > 0
    ) {
      rawDestinations = studentProfile.destinationCountries;
    } else if (studentProfile.destinationCountry) {
      // Old format — single string, backward compat
      rawDestinations = [{
        country:  studentProfile.destinationCountry,
        priority: 1,
        slots:    10,
      }];
    } else {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'At least one destination country required',
      });
    }

    // Validate incoming finalSlots sum to 10
    const totalSlots = rawDestinations
      .reduce((sum, d) => sum + (d.slots || 0), 0);
    if (totalSlots !== 10) {
      return res.status(400).json({
        error: 'Invalid slot allocation',
        message: `Slots must sum to 10, got ${totalSlots}`,
      });
    }

    // Rebuild with both candidateSlots and finalSlots
    const destCount      = Math.min(rawDestinations.length, 3);
    const candidateSlots = candidateSlotMap[destCount] || [15];
    const finalSlots     = finalSlotMap[destCount]     || [10];

    destinationCountries = rawDestinations.map((d, i) => ({
      country:    d.country,
      priority:   d.priority || i + 1,
      slots:      candidateSlots[i] ?? 7,   // candidate pool size
      finalSlots: finalSlots[i]     ?? 5,   // output size
    }));

    console.log(
      '[multi-dest] destinations:',
      destinationCountries.map(d =>
        `${d.country}(${d.slots}→${d.finalSlots})`
      ).join(', ')
    );

    // ── Container I — Convert student budget to USD ───────────────────────────
    const rawMin      = studentProfile.minBudget;
    const rawMax      = studentProfile.maxBudget;
    const rawCurrency = studentProfile.currency;

    // Guard: min must be strictly less than max
    if (rawMin != null && rawMax != null && rawMin >= rawMax) {
      return res.status(400).json({
        error: 'Invalid budget range',
        message: 'Minimum budget must be less than maximum budget',
      });
    }

    let studentBudget;

    if (rawMin != null && rawMax != null && rawCurrency) {
      try {
        studentBudget = {
          minUSD:           convertToUSD(rawMin, rawCurrency),
          maxUSD:           convertToUSD(rawMax, rawCurrency),
          originalCurrency: rawCurrency,
          originalMin:      rawMin,
          originalMax:      rawMax
        };
        console.log(
          `[budget] Converted ${rawMin}-${rawMax} ${rawCurrency}` +
          ` → $${studentBudget.minUSD.toFixed(0)}-` +
          `$${studentBudget.maxUSD.toFixed(0)} USD`
        );
      } catch (err) {
        return res.status(400).json({
          error: 'Invalid budget input',
          detail: err.message
        });
      }
    } else {
      // Backward compat — old budgetUSD field (V2 scoring disabled)
      studentBudget = {
        minUSD:           null,
        maxUSD:           studentProfile.budgetUSD || null,
        originalCurrency: 'USD',
        originalMin:      null,
        originalMax:      studentProfile.budgetUSD || null
      };
      if (studentBudget.maxUSD) {
        console.log(
          `[budget] Legacy budgetUSD: $${studentBudget.maxUSD} (V2 zones disabled)`
        );
      }
    }


    // ── Step 1: Normalize marks (display only) ───────────────────────────────
    const currentGradeNum = parseInt(
      String(studentProfile.grade).replace('Grade ', '')
    );
    const board = studentProfile.board;

    const marksArray = Array.isArray(studentProfile.marks)
      ? studentProfile.marks : [];

    const marksHistory = marksArray
      .filter(e => e && e.grade != null && e.overall != null)
      .map(e => ({
        grade:   parseInt(e.grade),
        overall: normalizeMarks(e.overall, board),
      }));

    const currentEntry = marksArray.find(
      e => parseInt(e.grade) === currentGradeNum
    );
    const normalizedMarks = currentEntry
      ? normalizeMarks(currentEntry.overall, board) : null;

    // ── Step 2: Calculate trend ──────────────────────────────────────────────
    const trend = calculateTrend(marksHistory);

    // ── Step 3: Predict Grade 12 (display only) ──────────────────────────────
    let prediction = null;
    if (currentGradeNum < 12) {
      prediction = predictGrade12(currentGradeNum, normalizedMarks, trend);
    }

    // ── Step 4: Assign display tiers ─────────────────────────────────────────
    const tierEligibility = assignTiers(normalizedMarks, currentGradeNum, trend);

    // ── Step 6: Build marksData + call analyzeStudent() ──────────────────────
    const marksData = (studentProfile.marks || []).map(m => ({
      grade: m.grade,
      overall: m.overall,
      subjectsText: m.subjectsText || null,
    }));

    // Seed must_match from sub-field selection before Container A runs
    const subFieldSeeds = (() => {
      const sf = studentProfile.subField;
      if (!sf || sf === 'other') {
        // Handle "other" — use student's own words
        const otherText = (studentProfile.subFieldOther || '');
        return otherText
          .toLowerCase()
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 4);
      }
      return SUB_FIELD_KEYWORDS[sf] || [];
    })();

    console.log('[subField] seeds:', subFieldSeeds,
                'from subField:', studentProfile.subField);

    // ── Multi-destination loop ──────────
    const allRecommendations = [];
    const allTierAnalyses    = [];
    const allDreamRecs       = [];
    const allExploreRecs     = [];

    const loopResults = await Promise.allSettled(
      destinationCountries.map(async (destination) => {
      const currentCountry    = destination.country;
      const countrySlots      = destination.slots;       // candidate pool size
      const countryFinalSlots = destination.finalSlots || 10;  // output size
      const loopStartTime     = Date.now();

      const iterationProfile = {
        ...studentProfile,
        destinationCountry: currentCountry
      };

      // ── Step 5: Student category (factual) ───────────────────────────────────
      const studentCategory = determineStudentCategory(
        iterationProfile.passportCountry,
        iterationProfile.countryOfResidence,
        iterationProfile.destinationCountry
      );
      console.log('CATEGORY:', studentCategory.label);

      console.log(
        `[multi-dest] processing ${currentCountry}` +
        ` (candidate:${countrySlots} final:${countryFinalSlots})`
      );

      // Pass student category label into profile so Claude sees it
      const profileForClaude = {
        ...iterationProfile,
        studentCategoryLabel: studentCategory.label,
      };

      // ── PRE-STEP — Fetch admission guide ──────────────────────────────────
      const admissionGuide = loadChunkContent(
        ['qualification_recognition'],
        currentCountry
      );
      const admissionContext = loadChunkContent(
        ['admission_checklist'],
        currentCountry
      );
      console.log(
        `[chunks] ${currentCountry}:`,
        `qualification_recognition=${admissionGuide ? admissionGuide.length : 0} chars`,
        `admission_checklist=${admissionContext ? admissionContext.length : 0} chars`
      );

    console.log('TIMING:', currentCountry, 'analyzeStudent START', Date.now() - loopStartTime + 'ms');
    const studentAnalysis = await analyzeStudent(
      studentProfile.aspiration,
      studentProfile.extracurricular,
      marksData,
      lrpResponses,
      profileForClaude,
      iterationProfile.destinationCountry,
      admissionGuide,
      normalizedMarks,                              // board-normalised score from normalizeBoard() or null
      studentProfile.primaryStream    || null,      // NEW — student-selected stream from dropdown
      studentProfile.openToRelated    || 'not_sure', // NEW — yes | no | not_sure
      studentProfile.secondaryAspiration || null,   // NEW — secondary aspiration text
      subFieldSeeds                                  // NEW — seed keywords from sub-field dropdown
    );
    console.log('TIMING:', currentCountry, 'analyzeStudent END', Date.now() - loopStartTime + 'ms');

    if (!studentAnalysis) {
      throw new Error(`Student analysis failed for ${currentCountry}`);
    }

    // Use dropdown stream directly if provided — do not trust Container A inference
    if (studentProfile.primaryStream) {
      studentAnalysis.stream = studentProfile.primaryStream;
      console.log('STAGE 1: stream overridden from dropdown:', studentProfile.primaryStream);
    }

    // ── secondary_intent fallback ────────────────────────────────────────────
    // Claude consistently returns [] for secondary_intent when the secondary
    // interest crosses streams (e.g. engineering student also wants AI).
    // If secondaryAspiration was provided and Claude returned empty, extract
    // keywords programmatically from the text.
    const ss = studentAnalysis.search_strategy || {};
    if (
      studentProfile.secondaryAspiration &&
      (!ss.secondary_intent || ss.secondary_intent.length === 0)
    ) {
      const STOPWORDS = new Set([
        'i','am','also','interested','in','the','a','an','and','or','to',
        'of','for','with','my','is','it','want','would','like','very','some',
        'about','are','that','this','have','has','be','as','on','at','but',
      ]);
      // Known academic term normalisation (multi-word first)
      const TERM_MAP = [
        [/\bdata science\b/i,           'data science'],
        [/\bmachine learning\b/i,        'machine learning'],
        [/\bartificial intelligence\b/i, 'artificial intelligence'],
        [/\bnatural language processing\b/i, 'natural language processing'],
        [/\bcomputer vision\b/i,         'computer vision'],
        [/\bdeep learning\b/i,           'deep learning'],
        [/\bcomputer science\b/i,        'computer science'],
        [/\bsoftware engineering\b/i,    'software engineering'],
        [/\bbusiness analytics\b/i,      'business analytics'],
        [/\bfinancial engineering\b/i,   'financial engineering'],
        [/\bquantitative finance\b/i,    'quantitative finance'],
        [/\bbioinformatics\b/i,          'bioinformatics'],
        [/\bhealth informatics\b/i,      'health informatics'],
        [/\bsustainability\b/i,          'sustainability'],
        [/\benvironmental\b/i,           'environmental'],
        [/\brenewable energy\b/i,        'renewable energy'],
        // single-word fallbacks
        [/\b(ai)\b/i,                   'artificial intelligence'],
        [/\b(ml)\b/i,                   'machine learning'],
        [/\b(cs)\b/i,                   'computer science'],
        [/\brobotics\b/i,               'robotics'],
        [/\baerospace\b/i,              'aerospace'],
        [/\bfinance\b/i,               'finance'],
        [/\bbusiness\b/i,              'business'],
        [/\bmanagement\b/i,            'management'],
        [/\beconomics\b/i,             'economics'],
        [/\bbiology\b/i,               'biology'],
        [/\bchemistry\b/i,             'chemistry'],
        [/\bphysics\b/i,               'physics'],
        [/\bprogramming\b/i,           'programming'],
        [/\bcoding\b/i,                'programming'],
        [/\bcybersecurity\b/i,         'cybersecurity'],
        [/\bblockchain\b/i,            'blockchain'],
        [/\bcloud computing\b/i,       'cloud computing'],
      ];
      const text = studentProfile.secondaryAspiration;
      const extracted = [];
      let remaining = text;
      for (const [pattern, canonical] of TERM_MAP) {
        if (pattern.test(remaining)) {
          extracted.push(canonical);
          remaining = remaining.replace(pattern, ' ');
          if (extracted.length >= 3) break;
        }
      }
      // If term map gave nothing, fall back to single meaningful words
      if (extracted.length === 0) {
        const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
        for (const w of words) {
          if (w.length > 3 && !STOPWORDS.has(w) && extracted.length < 3) {
            extracted.push(w);
          }
        }
      }
      if (extracted.length > 0) {
        ss.secondary_intent = extracted.slice(0, 3);
        studentAnalysis.search_strategy = ss;
        console.log('[secondary_intent] fallback extracted:', ss.secondary_intent);
      }
    }

    // ── Effective marks for scoring ──────────────────────────────────────────
    // normalizeBoard() result wins (deterministic, board-specific).
    // Falls back to Claude's normalized_score for unrecognised boards.
    // null only when both fail — scoring.js handles null via 0.85 default.
    const effectiveMarks =
      normalizedMarks !== null && normalizedMarks !== undefined
        ? normalizedMarks
        : (studentAnalysis.subject_profile?.normalized_score ?? null);

    // isPredicted: true when student confirmed these are teacher
    // predictions, not final results.
    // Defaults to true for Grade < 12 (most sub-Grade-12 marks are
    // predicted or indicative).
    // Only false when student explicitly unchecked the predicted flag.
    const isPredicted =
      currentEntry?.isPredicted !== false;

    // ── Effective marks for scoring (prediction-aware) ────────────────────────
    // For Grade 10/11 students, use predicted Grade 12 marks in scoring so
    // recommendations reflect where the student is heading, not just today.
    // Strategy by trend:
    //   improving → prediction.point
    //   declining → prediction.low  (conservative)
    //   stable    → current marks
    //   volatile  → prediction.low  (conservative — data uncertain)
    //   Grade 12  → current marks always
    let effectiveForScoring = effectiveMarks;
    let predictionUsed = false;

    if (currentGradeNum < 12 &&
        prediction !== null &&
        effectiveMarks !== null &&
        isPredicted) {           // only apply prediction to indicative marks
      const t = trend.trend;
      if (t === 'improving') {
        effectiveForScoring = prediction.point;
        predictionUsed = true;
      } else if (t === 'declining' ||
                 t === 'volatile') {
        effectiveForScoring = prediction.low;
        predictionUsed = true;
      }
      // stable or single → keep current marks
    }

    const isEarlyExplorer = currentGradeNum < 12;
    const applicationYearEstimate = isEarlyExplorer
      ? new Date().getFullYear() + (12 - currentGradeNum)
      : null;

    // STAGE 1 already logged inside analyzeStudent()
    console.log('STAGE 1: stream =', studentAnalysis.stream);
    console.log('STAGE 1: eligibility =',
      JSON.stringify(studentAnalysis.eligibility));

    // CONTAINER A — Post-graduation strategy
    // Standalone — runs after core, fails safely
    const containerAResult = await runContainerA(
      lrpResponses,
      studentAnalysis,
      iterationProfile  // NEW — source of passportCountry, destinationCountry, countryOfResidence
    );
    const postGradStrategy = containerAResult
      ?.post_grad_strategy || null;

    console.log('CONTAINER A:',
      postGradStrategy?.intent || 'not run');

    // CONTAINER C — Campus preferences extraction
    // Standalone — runs after core, fails safely
    const containerCResult = await runContainerC(
      studentProfile.aspiration,
      studentProfile.extracurricular
    );
    const campusPreferences = containerCResult
      ?.campus_preferences || null;

    console.log('CONTAINER C:',
      campusPreferences
        ? campusPreferences.activities_wanted?.join(', ')
        : 'not run or no preferences found');

    // Extract eligibility + db_query from Claude output
    const eligibility = studentAnalysis.eligibility || {};
    const dbQuery = studentAnalysis.db_query || {};

    // ── STAGE 5 — Two separate DB queries ────────────────────────────────────
    console.log('STAGE 5: starting DB queries...');

    const { matchTier, reachTier } =
      getReachAndMatchTiers(
        tierEligibility,
        studentAnalysis.eligibility
      );

    const fieldKeywords = (
      dbQuery.field_keywords || []
    ).map(k => String(k).toLowerCase()).filter(Boolean);

    console.log('STAGE 5: matchTier =', matchTier,
      '| reachTier =', reachTier,
      '| fieldKeywords =', fieldKeywords);

    const selectFields = `
      id, name, state, city,
      institution_type, global_tier,
      naac_grade, website,
      affiliated_to, can_apply_directly,
      apply_through,
      programs!inner (
        id, name, degree_level,
        field_of_study, duration_years,
        delivery_mode,
        language_of_instruction,
        program_url,
        tuition_fees (
          student_category, annual_fee,
          currency, academic_year
        ),
        entrance_tests (
          test_name, is_mandatory
        ),
        admission_requirements (
          subject_group, min_percentage
        )
      )
    `;

    const selectFieldsNoInner = selectFields
      .replace('programs!inner', 'programs');

    // Build field filter
    const fieldFilter = fieldKeywords.length > 0
      ? fieldKeywords
          .map(k =>
            `programs.field_of_study.ilike.%${k}%`
          ).join(',')
      : null;

    // Query A — MATCH tier universities
    let matchUniversities = [];
    try {
      let matchQuery = supabase()
        .from('universities')
        .select(selectFields)
        .eq('country', iterationProfile.destinationCountry)
        .eq('global_tier', matchTier);

      const { data: matchData, error: matchError } =
        await matchQuery;

      if (matchError) {
        console.error('MATCH query error:', matchError.message);
        // Fallback — no field filter
        const { data: matchFb } = await supabase()
          .from('universities')
          .select(selectFieldsNoInner)
          .eq('country', iterationProfile.destinationCountry)
          .eq('global_tier', matchTier);
        matchUniversities = matchFb || [];
      } else {
        matchUniversities = matchData || [];
      }
    } catch (e) {
      console.error('MATCH query exception:', e.message);
    }

    console.log('STAGE 5: MATCH tier', matchTier,
      '=', matchUniversities.length, 'universities');

    // Query B — REACH tier universities (if exists)
    let reachUniversities = [];
    if (reachTier) {
      try {
        let reachQuery = supabase()
          .from('universities')
          .select(selectFields)
          .eq('country', iterationProfile.destinationCountry)
          .eq('global_tier', reachTier);

        const { data: reachData, error: reachError } =
          await reachQuery;

        if (reachError) {
          console.error('REACH query error:', reachError.message);
          const { data: reachFb } = await supabase()
            .from('universities')
            .select(selectFieldsNoInner)
            .eq('country', iterationProfile.destinationCountry)
            .eq('global_tier', reachTier);
          reachUniversities = reachFb || [];
        } else {
          reachUniversities = reachData || [];
        }
      } catch (e) {
        console.error('REACH query exception:', e.message);
      }
    }

    console.log('STAGE 5: REACH tier', reachTier,
      '=', reachUniversities.length, 'universities');

    // Combine all universities
    const universities = [
      ...matchUniversities,
      ...reachUniversities
    ];

    console.log('STAGE 5: total universities =',
      universities.length);

    // Fetch university_life as a separate query
    // (Supabase nested select join unreliable for
    //  reverse FK — separate query is more robust)
    const universityIds = universities.map(u => u.id);
    let universityLifeMap = {};

    if (universityIds.length > 0) {
      const { data: lifeData, error: lifeError } =
        await supabase()
          .from('university_life')
          .select('*')
          .in('university_id', universityIds);

      if (lifeError) {
        console.error('university_life fetch error:',
          lifeError.message);
      } else {
        (lifeData || []).forEach(row => {
          universityLifeMap[row.university_id] = row;
        });
      }
    }

    console.log('University life data available for:',
      Object.keys(universityLifeMap).length,
      'universities');

    // Filter programs by field and degree
    // Done in JS because Supabase .or() on
    // joined tables has parse issues
    // Note: fieldKeywords already declared above

    const degreeKeywords = (
      dbQuery.degree_keywords || []
    ).map(k => k.toLowerCase());

    const clarity = studentAnalysis
      .aspiration_clarity || 'medium';

    // mustMatch blocklist — generic terms that match too broadly
    // and defeat the purpose of mustMatch filtering.
    // Claude returns these when aspiration is vague or stream-level.
    // Exact-string match: 'software engineering' passes, 'engineering' blocked.
    const MUSTMATCH_BLOCKLIST = new Set([
      'engineering', 'science', 'technology',
      'studies', 'bachelor', 'undergraduate',
      'program', 'degree', 'general', 'applied',
    ]);

    const rawMustMatch = (
      studentAnalysis.search_strategy?.must_match || []
    ).map(k => String(k).toLowerCase());

    const mustMatchKeywords = expandMustMatchKeywords(rawMustMatch, MUSTMATCH_BLOCKLIST);

    const blockedKeywords = rawMustMatch
      .filter(k => MUSTMATCH_BLOCKLIST.has(k));

    if (blockedKeywords.length > 0) {
      console.warn(
        `[mustMatch] blocked generic keywords: [${blockedKeywords.join(', ')}]`
      );
    }

    // Query C — exact mustMatch programs at tiers NOT in Query A/B
    // Queries programs table directly (avoids nested join filter limitation)
    // Results go to exploreRecs (ALSO CONSIDER section), never to main 10
    let queryCData = [];
    if (mustMatchKeywords.length > 0) {
      const excludedTiers = [matchTier, reachTier].filter(Boolean);

      // Build OR filter for mustMatch keywords against program name and field
      const nameFilters  = mustMatchKeywords.map(k => `name.ilike.%${k}%`);
      const fieldFilters = mustMatchKeywords.map(k => `field_of_study.ilike.%${k}%`);
      const programOrFilter = [...nameFilters, ...fieldFilters].join(',');

      try {
        // Step 1 — find matching programs with their university info
        const { data: matchingPrograms, error: queryCError } = await supabase()
          .from('programs')
          .select(`
            id,
            name,
            field_of_study,
            degree_level,
            duration_years,
            delivery_mode,
            program_url,
            university_id,
            universities!inner (
              id,
              name,
              country,
              global_tier,
              is_active
            )
          `)
          .or(programOrFilter)
          .eq('is_active', true)
          .eq('universities.country', iterationProfile.destinationCountry)
          .eq('universities.is_active', true)
          .not('universities.global_tier', 'in', `(${excludedTiers.join(',')})`)
          .lte('universities.global_tier', 4)
          .limit(20);

        if (queryCError) throw queryCError;

        queryCData = matchingPrograms || [];
        console.log(
          `[queryC] ${currentCountry}: found ${queryCData.length} exact mustMatch programs`,
          `outside tier ${excludedTiers.join('/')}`,
          queryCData.map(p => `${p.universities?.name} T${p.universities?.global_tier} — ${p.name}`).join(' | ')
        );
      } catch (err) {
        console.warn('[queryC] failed:', err.message);
        queryCData = [];
      }
    }

    // Query D — exact mustMatch programs at tiers ABOVE student's match/reach tiers
    // These go to the dream pool — student's marks/tier don't yet qualify
    // Runs in parallel context (after Query C, before JS filtering)
    let queryDData = [];
    if (mustMatchKeywords.length > 0 && matchTier > 1) {
      // Only tiers HIGHER than student's reach tier (or match tier if no reach)
      const highestEligibleTier = reachTier || matchTier;
      const higherTiers = Array.from(
        { length: highestEligibleTier - 1 },
        (_, i) => i + 1
      ).filter(t => t < highestEligibleTier);

      if (higherTiers.length > 0) {
        const nameFilters  = mustMatchKeywords.map(k => `name.ilike.%${k}%`);
        const fieldFilters = mustMatchKeywords.map(k => `field_of_study.ilike.%${k}%`);
        const programOrFilter = [...nameFilters, ...fieldFilters].join(',');

        try {
          const { data: dData, error: queryDError } = await supabase()
            .from('programs')
            .select(`
              id,
              name,
              field_of_study,
              degree_level,
              duration_years,
              delivery_mode,
              program_url,
              university_id,
              universities!inner (
                id,
                name,
                country,
                global_tier,
                is_active
              )
            `)
            .or(programOrFilter)
            .eq('is_active', true)
            .eq('universities.country', iterationProfile.destinationCountry)
            .eq('universities.is_active', true)
            .in('universities.global_tier', higherTiers)
            .limit(10);

          if (queryDError) throw queryDError;

          const isUgGrade = ['Grade 10', 'Grade 11', 'Grade 12'].includes(
            studentProfile.grade || studentProfile.currentGrade || ''
          );
          queryDData = (dData || []).filter(p => {
            if (!isUgGrade) return true;
            const deg = (p.degree_level || '').toLowerCase();
            const degRaw = p.degree_level || '';
            return !['msc', 'meng', 'ms', 'ma', 'mba', 'phd', 'master',
                     'm.sc', 'm.eng', 'postgraduate', 'llm', 'lld', 'bcl'].some(pg => deg.includes(pg)) &&
                   !degRaw.startsWith('LL.');
          });

          console.log(
            `[queryD] ${currentCountry}: found ${queryDData.length} exact mustMatch programs`,
            `at higher tiers ${higherTiers.join('/')}`,
            queryDData.map(p =>
              `${p.universities?.name} T${p.universities?.global_tier} — ${p.name}`
            ).join(' | ')
          );
        } catch (err) {
          console.warn('[queryD] failed:', err.message);
          queryDData = [];
        }
      }
    }

    // Snapshot full program lists before forEach mutation.
    // Used by second-pass fallback to restore zero-result universities.
    // Taken before any filtering so base filters can be re-applied per layer.
    const originalPrograms = new Map(
      universities.map(u => [
        u.id,
        u.programs ? [...u.programs] : []
      ])
    );

    universities.forEach(uni => {
      let programs = uni.programs || [];

      // Gate: exclude programs with no real min_percentage data.
      // admission_requirements empty OR all rows have null min_percentage
      // → program skipped (calculateAcademicFit would silently default to 0.85)
      // Stream bypass: portfolio/contextual-offer based streams
      // do not use percentage minimums — gate does not apply
      const GATE_BYPASS_STREAMS = ['design', 'arts', 'law', 'music', 'architecture'];
      const streamBypassGate = GATE_BYPASS_STREAMS.some(s =>
        (studentAnalysis?.stream || '').toLowerCase().includes(s)
      );

      const gated = streamBypassGate
        ? programs  // skip gate entirely for portfolio-based streams
        : programs.filter(p => {
            const reqs = p.admission_requirements || [];
            const hasReal = reqs.some(
              r => r.min_percentage !== null && r.min_percentage !== undefined
            );
            if (!hasReal) {
              console.log(
                `[gate] skipped "${p.name}" at "${uni.name}"` +
                ` reason=no_min_percentage`
              );
            }
            return hasReal;
          });
      programs = gated;

      // Filter by degree_level using Claude's
      // degree_keywords (UG only for Grade 9-12)
      if (degreeKeywords.length > 0) {
        const degFiltered = programs.filter(p => {
          const deg = (p.degree_level || '')
            .toLowerCase();
          return degreeKeywords.some(k =>
            deg.includes(k)
          );
        });
        // Only apply if leaves enough programs
        if (degFiltered.length >= 2) {
          programs = degFiltered;
        }
      }

      // Hard filter — mustMatch keywords (blocklist already applied above forEach).
      // No safety valve: if zero programs match, university is excluded entirely.
      // Falls back to field_keywords if mustMatch is empty or all blocked.
      if (mustMatchKeywords.length > 0) {
        programs = programs.filter(p => {
          const field = (p.field_of_study || '').toLowerCase();
          const name  = (p.name || '').toLowerCase();
          return mustMatchKeywords.some(k =>
            field.includes(k) || name.includes(k)
          );
        });
      } else if (fieldKeywords.length > 0 && clarity !== 'low') {
        // Legacy fallback — field_keywords with safety valve
        const fieldFiltered = programs.filter(p => {
          const field = (p.field_of_study || '').toLowerCase();
          const name  = (p.name || '').toLowerCase();
          return fieldKeywords.some(k =>
            field.includes(k) || name.includes(k)
          );
        });
        if (fieldFiltered.length >= 2) {
          programs = fieldFiltered;
        }
      }

      // Degree-level filter — all current students are pre-university
      // targeting undergraduate programs only.
      // Excludes PG programs for Grade 10/11/12 students.
      // TODO: Replace with program_level
      // DB column + backfill script.
      // Do before next country added.
      const UNDERGRAD_GRADES = ['Grade 10', 'Grade 11', 'Grade 12'];
      const PG_DEGREE_LEVELS = new Set([
        'M.Tech', 'M.Sc', 'MBA', 'PhD', 'Ph.D', 'MA', 'M.A.', 'M.A',
        'M.Sc.', 'M.Pharm', 'MSc', 'M.Phil.', 'MCA', 'MFA', 'M.Com',
        'PG Diploma', 'PGD', 'MSW', 'LL.M.', 'LL.M', 'LLM', 'LLD', 'BCL',
        'M.Arch', 'M.Phil',
        'M.Ed', 'M.P.Ed', 'M.E.', 'MBA / PGDM', 'MBA/PGDM', 'MBA.', 'MBA + MCA',
        // Germany + international PG variants
        'M.Eng.', 'M.B.A.', 'M.Ed.', 'M.Mus.',
        'MMM', 'Magister', 'Master of Music',
        'Ph.D.', 'second cycle', 'Dr. phil.', 'Konzertexamen',
        // UK integrated masters (UG entry, masters exit — exclude for Grade 10/11/12)
        'MEng', 'M.Eng', 'MPhys', 'MPharm', 'MChem',
        'MMath', 'MBiol', 'MGeol', 'MEarthSci',
        // US-style master's without dots — not caught by startsWith('M.')
        'MS', 'MA', 'MFA', 'MPA', 'MPH', 'MBA', 'MIS', 'MEd',
      ]);

      const gradeField = studentProfile.grade
        || studentProfile.currentGrade
        || '';
      if (UNDERGRAD_GRADES.includes(gradeField)) {
        const beforeDeg = programs.length;
        programs = programs.filter(p => {
          const deg = p.degree_level || '';
          return !PG_DEGREE_LEVELS.has(deg) &&
            !deg.startsWith('Master') &&
            !deg.startsWith('M.') &&
            !deg.startsWith('LL.');
        });
        const excluded = beforeDeg - programs.length;
        if (excluded > 0) {
          console.log(
            `[degreeFilter] excluded ${excluded} PG programs` +
            ` (student is ${gradeField})` +
            ` at "${uni.name}"`
          );
        }
      }

      // Tag pass 1 survivors — match quality travels to rec.programMatch
      uni.programs = programs.map(p => ({ ...p, programMatch: 'direct' }));
    });

    // mustMatch summary log — uses post-blocklist keywords (accurate count)
    if (rawMustMatch.length > 0) {
      const kept = universities.reduce(
        (sum, u) => sum + (u.programs?.length || 0), 0);
      // totalBeforeFieldFilter not tracked per-program — use universities
      // with 0 programs after filter as proxy for excluded
      const excludedUnis = universities.filter(
        u => (u.programs?.length || 0) === 0
      ).length;
      if (mustMatchKeywords.length > 0) {
        console.log(
          `[mustMatch] applied ${mustMatchKeywords.length} keywords:`,
          mustMatchKeywords
        );
      } else {
        console.log(
          '[mustMatch] skipped — all keywords blocked by blocklist;' +
          ' falling back to field_keywords'
        );
      }
      console.log(
        `[mustMatch] kept ${kept} programs,` +
        ` excluded ${excludedUnis} universities (0 matching programs)`
      );
    }

    // ── Second pass — layered mustMatch fallback ─────────────────────────────
    // Activates Container A fields (should_match, nice_to_match,
    // primary/secondary families) that were dead output until now.
    // Re-populates zero-result universities using progressively broader keywords.
    // Runs before allPrograms flatMap so Stage 6 + Stage 7 see the same data.

    const shouldMatchKeywords = expandKeywords(
      studentAnalysis.search_strategy?.should_match || []
    );

    const niceToMatchKeywords = expandKeywords(
      studentAnalysis.search_strategy?.nice_to_match || []
    );

    const primaryFamilyKeywords = expandKeywords(
      studentAnalysis.primary_program_families || []
    );

    const secondaryFamilyKeywords = expandKeywords(
      studentAnalysis.secondary_program_families || []
    );


    const survivingAfterPass1 = universities
      .reduce((sum, u) => sum + (u.programs?.length || 0), 0);

    if (survivingAfterPass1 < 30 && mustMatchKeywords.length > 0) {
      // Base filters re-applied on all restored programs:
      //   1. Gate: no_min_percentage — calculateAcademicFit needs real data
      //   2. PG degree filter — Grade 10/11/12 students are UG only
      const gradeFieldP2 = studentProfile.grade
        || studentProfile.currentGrade || '';
      const isUndergradP2 = [
        'Grade 10', 'Grade 11', 'Grade 12'
      ].includes(gradeFieldP2);
      const PG_LEVELS_P2 = new Set([
        'M.Tech', 'M.Sc', 'MBA', 'PhD', 'Ph.D', 'MA', 'M.A.', 'M.A',
        'M.Sc.', 'M.Pharm', 'MSc', 'M.Phil.', 'MCA', 'MFA', 'M.Com',
        'PG Diploma', 'PGD', 'MSW', 'LL.M.', 'LL.M', 'LLM', 'LLD', 'BCL',
        'M.Arch', 'M.Phil',
        'M.Ed', 'M.P.Ed', 'M.E.', 'MBA / PGDM', 'MBA/PGDM', 'MBA.', 'MBA + MCA',
        'M.Eng.', 'M.B.A.', 'M.Ed.', 'M.Mus.',
        'MMM', 'Magister', 'Master of Music',
        'Ph.D.', 'second cycle', 'Dr. phil.', 'Konzertexamen',
        'MEng', 'M.Eng', 'MPhys', 'MPharm', 'MChem',
        'MMath', 'MBiol', 'MGeol', 'MEarthSci',
        // US-style master's without dots
        'MS', 'MA', 'MFA', 'MPA', 'MPH', 'MBA', 'MIS', 'MEd',
      ]);

      const applyBaseFiltersP2 = (programs) => {
        let f = programs.filter(p => {
          const reqs = p.admission_requirements || [];
          return reqs.some(
            r => r.min_percentage !== null &&
                 r.min_percentage !== undefined
          );
        });
        if (isUndergradP2) {
          f = f.filter(p => {
            const deg = p.degree_level || '';
            return !PG_LEVELS_P2.has(deg) &&
              !deg.startsWith('Master') &&
              !deg.startsWith('M.');
          });
        }
        return f;
      };

      let pass2Layer2 = 0;
      let pass2Layer3 = 0;
      let pass2Layer4 = 0;

      // Layer 2 — should_match
      if (shouldMatchKeywords.length > 0) {
        for (const uni of universities) {
          if ((uni.programs?.length || 0) > 0) continue;
          const base = applyBaseFiltersP2(
            originalPrograms.get(uni.id) || []
          );
          const matched = base.filter(p => {
            const field = (p.field_of_study || '').toLowerCase();
            const name  = (p.name || '').toLowerCase();
            return shouldMatchKeywords.some(k =>
              field.includes(k) || name.includes(k)
            );
          }).map(p => ({ ...p, programMatch: 'related' }));
          if (matched.length > 0) {
            uni.programs = matched;
            pass2Layer2 += matched.length;
          }
        }
      }

      const afterLayer2 = universities.reduce(
        (sum, u) => sum + (u.programs?.length || 0), 0);

      // Layer 3 — nice_to_match + primary/secondary families
      if (afterLayer2 < 30) {
        const layer3Keywords = [
          ...niceToMatchKeywords,
          ...primaryFamilyKeywords,
          ...secondaryFamilyKeywords,
        ];
        if (layer3Keywords.length > 0) {
          for (const uni of universities) {
            if ((uni.programs?.length || 0) > 0) continue;
            const base = applyBaseFiltersP2(
              originalPrograms.get(uni.id) || []
            );
            const matched = base.filter(p => {
              const field = (p.field_of_study || '').toLowerCase();
              const name  = (p.name || '').toLowerCase();
              return layer3Keywords.some(k =>
                field.includes(k) || name.includes(k)
              );
            }).map(p => ({ ...p, programMatch: 'adjacent' }));
            if (matched.length > 0) {
              uni.programs = matched;
              pass2Layer3 += matched.length;
            }
          }
        }
      }

      const afterLayer3 = universities.reduce(
        (sum, u) => sum + (u.programs?.length || 0), 0);

      // Layer 4 — broad fallback, last resort
      // Capped at 2 programs per university, sorted by keyword proximity.
      // Threshold: only fire when layers 1-3 left fewer than 5 programs.
      // 5 is the minimum below which we cannot produce enough recommendations.
      // Keeping threshold low avoids broad fallback explosions for specialised
      // fields (e.g. UK aerospace, UK chemistry) where layers 1-3 find enough
      // programmes across enough universities to still produce 10 final recs.
      if (afterLayer3 < 5) {
        console.warn(
          `[mustMatch] broad fallback triggered` +
          ` — only ${afterLayer3} programs survived layers 1-3`
        );
        for (const uni of universities) {
          if ((uni.programs?.length || 0) > 0) continue;
          const restored = applyBaseFiltersP2(
            originalPrograms.get(uni.id) || []
          ).map(p => {
            // Score by keyword proximity — prefer programs closest to student interest
            const name  = (p.name || '').toLowerCase();
            const field = (p.field_of_study || '').toLowerCase();
            const allKw = [...mustMatchKeywords, ...shouldMatchKeywords, ...niceToMatchKeywords];
            const kwScore = allKw.filter(k => name.includes(k) || field.includes(k)).length;
            return { ...p, programMatch: 'broad', _kwScore: kwScore };
          });

          if (restored.length > 0) {
            // Sort by keyword proximity score desc, then take max 2 per university
            const ranked = restored.sort((a, b) => b._kwScore - a._kwScore);
            uni.programs = ranked.slice(0, 2);
            pass2Layer4 += uni.programs.length;
          }
        }
      }

      const totalAfterPass2 = universities.reduce(
        (sum, u) => sum + (u.programs?.length || 0), 0);
      console.log(
        `[mustMatch] pass1=${survivingAfterPass1}` +
        ` layer2=${pass2Layer2}` +
        ` layer3=${pass2Layer3}` +
        ` layer4=${pass2Layer4}` +
        ` total=${totalAfterPass2}`
      );
    }

    // Log after filtering
    const totalAfterFilter = universities
      .reduce((sum, u) =>
        sum + (u.programs?.length || 0), 0);
    console.log('STAGE 5: programs after JS filter =',
      totalAfterFilter);

    // Fallback — if both queries returned nothing
    if (universities.length === 0) {
      console.warn(
        '[analyze] No universities found for', currentCountry,
        '— skipping destination, other destinations continue'
      );
      return;
    }

    // ── STAGE 6 (formerly 8): Score program relevance with Claude ────────────
    const allPrograms = (universities || []).flatMap(uni =>
      (uni.programs || []).map(p => ({
        id: p.id,
        name: p.name,
        field_of_study: p.field_of_study,
        degree_level: p.degree_level,
      }))
    );

    console.log('STAGE 6: scoring',
      allPrograms.length, 'programs');
    console.log('TIMING:', currentCountry, 'scorePrograms START', Date.now() - loopStartTime + 'ms');
    const claudeScores = await scorePrograms(
      allPrograms, studentAnalysis, postGradStrategy);
    console.log('TIMING:', currentCountry, 'scorePrograms END', Date.now() - loopStartTime + 'ms');

    // CONTAINER B — Signal-based score adjustment
    // Standalone — runs after scoring, fails safely
    const containerBResult = await runContainerB(
      claudeScores,
      allPrograms,
      studentAnalysis.knn_features
    );

    // Use adjusted scores if container ran
    // Fall back to original scores if it failed
    const finalScores = containerBResult
      ?.adjustedScores || claudeScores;

    console.log('CONTAINER B: complete');

    // ── Container P — per-country budget window ───────────────────────────────
    const countryBudget = deriveCountryBudget(
      studentBudget.minUSD || 0,
      studentBudget.maxUSD || 0,
      currentCountry
    );
    const effectiveStudentBudget = {
      ...studentBudget,
      minUSD:        countryBudget.minUSD,
      maxUSD:        countryBudget.maxUSD,
      minLocal:      countryBudget.minLocal,
      maxLocal:      countryBudget.maxLocal,
      localCurrency: countryBudget.currency,
      budgetStatus:  countryBudget.budgetStatus,   // NEW
      badge:         countryBudget.badge,          // NEW
      warning:       countryBudget.warning,
    };
    console.log(
      `[containerP] ${currentCountry}:` +
      ` effectiveBudget $${effectiveStudentBudget.minUSD}` +
      `-$${effectiveStudentBudget.maxUSD}` +
      ` (${effectiveStudentBudget.budgetStatus || 'direct'})`
    );

    // ── Rankings pre-fetch — must run BEFORE scoreUniversity() ─────────────
    // scoreUniversity() reads uni.qs_rank / the_rank / arwu_rank to compute
    // the 10-point reputation score. These columns are NOT returned by the
    // Supabase SELECT — they are fetched from Perplexity via fetchRankings().
    // Pre-fetching here and merging onto the uni objects ensures reputation
    // scores are accurate. Container Q reuses this map — no double fetch.
    const uniCandidatesForRank = (universities || []).map(u => ({
      universityId:   u.id,
      universityName: u.name,
    }));
    const existingRankMap = await fetchRankings(
      uniCandidatesForRank, currentCountry
    );
    (universities || []).forEach(u => {
      const rank = existingRankMap.get(u.id);
      if (rank) Object.assign(u, rank);
    });
    console.log(
      `[rankings-prefetch] merged ranks for ${existingRankMap.size} universities`
    );

    // ── STAGE 7 (formerly 9): Score every uni+program combo ─────────────────
    const enrichedProfile = {
      ...iterationProfile,
      normalizedMarks: effectiveForScoring,
      grade: currentGradeNum,
      lrpResponses,
      nationality:   studentCategory.category,   // computed code, not raw form string
      parentInGulf:  studentCategory.ciwgEligible,
      aspirationSummary: studentAnalysis.student_summary,
      studentBudget: effectiveStudentBudget,   // Container P — country-specific window
    };

    const scoredResults = [];
    const uniProgramCount   = new Map();  // uni.id → count (max 2 per university)
    const seenCompositeKeys = new Set();  // uni.id::normalizedProgramName (dedup exact dupes)

    for (const uni of (universities || [])) {
      if (!uni.programs || uni.programs.length === 0) continue;

      // Tag based on which query this university came from
      const tag = uni.global_tier === reachTier
        ? 'REACH' : 'MATCH';

      // Skip if university tier is not in our two query tiers
      if (uni.global_tier !== matchTier &&
          uni.global_tier !== reachTier) continue;

      for (const program of uni.programs) {
        // Normalise program name — strip dots, collapse spaces, lowercase
        // "B.Tech. CSE" and "B.Tech CSE" → same key → only one scores
        const normName = (program.name || '')
          .toLowerCase()
          .replace(/\./g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const compositeKey = uni.id + '::' + normName;

        // Skip if this normalised program name already scored for this university
        if (seenCompositeKeys.has(compositeKey)) continue;

        // Enforce max 2 distinct programs per university
        const uniCount = uniProgramCount.get(uni.id) || 0;
        if (uniCount >= 2) continue;

        const claudeProgramScore = finalScores
          .find(s => s.id === program.id)
          ?.score ?? 12;

        const result = scoreUniversity(
          uni, program, enrichedProfile, claudeProgramScore
        );
        scoredResults.push({ ...result, tag, globalTier: uni.global_tier });
        seenCompositeKeys.add(compositeKey);
        uniProgramCount.set(uni.id, uniCount + 1);
      }
    }

    console.log('STAGE 7: scored', scoredResults.length, 'program candidates');

    // CONTAINER F — Campus life scoring bonus
    // Standalone — runs after core, fails safely
    const containerFResult = await runContainerF(
      scoredResults,
      universityLifeMap,
      campusPreferences  // from Container C
    );

    // Use adjusted results if container ran
    const finalScoredResults = containerFResult
      ?.adjustedResults || scoredResults;

    // ── Container I — Filter excluded universities ────────────────────────────
    const beforeFilter = finalScoredResults.length;
    let filteredResults = finalScoredResults.filter(
      r => !r.budgetExcluded
    );
    const afterFilter = filteredResults.length;

    console.log(
      `[budget] Excluded ${beforeFilter - afterFilter} universities` +
      ` (${afterFilter} remaining)`
    );

    // Log individual exclusions for debugging
    finalScoredResults
      .filter(r => r.budgetExcluded)
      .forEach(r => {
        console.log(
          `[budget] EXCLUDED ${r.universityName}` +
          ` reason=${r.budgetExclusionReason}`
        );
      });

    // DREAM candidate — best budget-excluded program matching must_match keywords
    // Falls back to shouldMatch if no mustMatch excluded programs exist
    const dreamCandidate = (() => {
      const excluded = finalScoredResults.filter(r => r.budgetExcluded);
      if (!excluded.length) return null;

      // Priority 1 — excluded programs matching mustMatch keywords (exact interest)
      const mustMatchDreams = excluded.filter(r => {
        const name  = (r.programName  || '').toLowerCase();
        const field = (r.fieldOfStudy || '').toLowerCase();
        return mustMatchKeywords.some(k => name.includes(k) || field.includes(k));
      }).sort((a, b) => b.fitScore - a.fitScore);

      // Priority 2 — excluded programs matching shouldMatch (closest alternative)
      const shouldMatchDreams = excluded.filter(r => {
        const name  = (r.programName  || '').toLowerCase();
        const field = (r.fieldOfStudy || '').toLowerCase();
        return shouldMatchKeywords.some(k => name.includes(k) || field.includes(k));
      }).sort((a, b) => b.fitScore - a.fitScore);

      // Also consider higher-tier exact mustMatch programs (Query D) as dream candidates
      // These are programs the student wants but at a tier above their current eligibility
      const queryDDreamCandidates = queryDData
        .filter(p => p.universities && p.universities.id)
        .map(p => ({
          universityId:       p.universities.id,
          universityName:     p.universities.name,
          programId:          p.id,
          programName:        p.name,
          fieldOfStudy:       p.field_of_study,
          destinationCountry: currentCountry,
          fitScore:           65,
          tag:                'REACH',
          global_tier:        p.universities.global_tier,
          budgetExcluded:     false,
          isDreamCandidate:   true,
          dreamSource:        'higher_tier_exact_match',
          dreamReason:        `${p.name} at ${p.universities.name} is the exact programme you want — ` +
                              `but this university is at Tier ${p.universities.global_tier}, ` +
                              `above your current eligible tiers. ` +
                              `Your marks qualify you for Tier ${matchTier} universities — ` +
                              `this is your aspiration to work toward.`,
        }));

      // Dream pool: budget-excluded mustMatch first, then Query D higher-tier exact, then shouldMatch
      const dreamPool = mustMatchDreams.length > 0
        ? mustMatchDreams
        : queryDDreamCandidates.length > 0
          ? queryDDreamCandidates
          : shouldMatchDreams;
      const isExactMatch = mustMatchDreams.length > 0;

      if (!dreamPool.length) return null;

      const best = dreamPool[0];

      // Build honest reason
      const reasons = [];
      if (best.budgetExclusionReason === 'above_stretch') {
        reasons.push('above your current budget');
      } else if (best.budgetExclusionReason === 'below_min') {
        reasons.push('below your minimum budget');
      }
      if (best.tag === 'REACH') {
        reasons.push('highly competitive for your current marks');
      }
      const reasonText = reasons.length
        ? reasons.join(' and ')
        : 'outside your current criteria';

      const dreamReason = isExactMatch
        ? `${best.universityName} offers ${best.programName} — exactly what you are looking for. It is currently ${reasonText}. If you can address this through scholarships, budget adjustment, or stronger marks, this is worth pursuing.`
        : `${best.universityName} is a strong university for your field and is currently ${reasonText}. Note: your specific programme preference (${mustMatchKeywords.slice(0, 2).join(', ')}) was not available here — but this is a strong stepping stone toward your goals.`;

      return {
        ...best,
        tag:                'DREAM',
        budgetBadge:        'Dream option',
        budgetZone:         'DREAM',
        destinationCountry: currentCountry,
        isDream:            true,
        isExactDreamMatch:  isExactMatch,
        dreamReason:        best.isDreamCandidate ? best.dreamReason : dreamReason,
      };
    })();

    if (dreamCandidate) {
      console.log(
        `[dream] candidate: "${dreamCandidate.universityName}"` +
        ` fitScore=${dreamCandidate.fitScore}` +
        ` reason=${dreamCandidate.budgetExclusionReason}`
      );
    }

    // Fallback chain — ensure at least countrySlots results
    if (filteredResults.length < countrySlots) {
      console.warn(
        `[budget] Only ${filteredResults.length} unis after filter.` +
        ` Triggering fallback chain.`
      );
      filteredResults = triggerBudgetFallback(
        finalScoredResults,
        effectiveStudentBudget
      );
    }

    // Separate results by tier
    const reachResults = filteredResults
      .filter(r => r.globalTier === reachTier)
      .sort((a, b) =>
        b.fitScore - a.fitScore ||
        compareRank(a, b) ||
        (a.universityName || '').localeCompare(b.universityName || '') ||
        (a.programName    || '').localeCompare(b.programName    || ''));

    const matchResults = filteredResults
      .filter(r => r.globalTier === matchTier)
      .sort((a, b) =>
        b.fitScore - a.fitScore ||
        compareRank(a, b) ||
        (a.universityName || '').localeCompare(b.universityName || '') ||
        (a.programName    || '').localeCompare(b.programName    || ''));

    // ── Container Q — Validate, Dedup, Trim ──────────────────────────────────
    const {
      validateCandidates,
      dedupByUniversity,
      trimToFinal,
    } = require('../services/containerQ');

    // reachMax keyed by finalSlots (output size)
    const reachMaxMap = { 10: 4, 6: 2, 5: 2, 4: 2, 3: 1 };
    const reachMax = reachMaxMap[countryFinalSlots] ?? Math.ceil(countryFinalSlots * 0.4);

    let top10;

    if (process.env.CONTAINER_Q === 'true') {
      console.log('[containerQ] enabled — running validation pipeline...');

      // Validate top countrySlots candidates (already expanded pool — no × 1.5 needed)
      const candidatePool = filteredResults
        .sort((a, b) =>
          b.fitScore - a.fitScore ||
          compareRank(a, b) ||
          (a.universityName || '').localeCompare(b.universityName || '') ||
          (a.programName    || '').localeCompare(b.programName    || ''))
        .slice(0, countrySlots);

      const stream = studentAnalysis.stream || 'general';
      const candidatePoolWithStream = candidatePool.map(c => ({
        ...c,
        stream
      }));
      const [validated, rankMap] = await Promise.all([
        validateCandidates(candidatePoolWithStream),
        Promise.resolve(existingRankMap),   // reuse pre-fetched ranks — do not fetch twice
      ]);

      // Merge ranking data onto candidatePool items (for sort inside dedup/trim)
      candidatePool.forEach(r => {
        const rank = rankMap.get(r.universityId);
        if (rank) Object.assign(r, rank);
      });


      // Merge ranking data onto validated items (for output)
      // Object.assign picks up all ranking fields — future schema additions
      // are automatically included without code changes here.
      validated.forEach(r => {
        const rank = rankMap.get(r.universityId);
        if (rank) Object.assign(r, rank);
      });

      const deduped = dedupByUniversity(validated);
      top10 = trimToFinal(deduped, countryFinalSlots, reachMax, reachTier, matchTier);

    } else {
      // ── Legacy Stage 8 (unchanged) ──────────────────────────────────────────
      function deduplicateResults(results) {
        const seen = new Map();
        return results.filter(r => {
          const count = seen.get(r.universityId) || 0;
          if (count < 2) {
            seen.set(r.universityId, count + 1);
            return true;
          }
          return false;
        });
      }

      const dedupReach = deduplicateResults(reachResults);
      const dedupMatch = deduplicateResults(matchResults);

      const finalReach = dedupReach.slice(0, reachMax);
      const remainingSlots = countryFinalSlots - finalReach.length;
      const finalMatch = dedupMatch.slice(0, remainingSlots);

      console.log('STAGE 8:',
        'REACH =', finalReach.length,
        '| MATCH =', finalMatch.length
      );

      finalReach.forEach(r => r.tag = 'REACH');
      finalMatch.forEach(r => r.tag = 'MATCH');

      let top10Legacy = [...finalReach, ...finalMatch];

      // Cap UNDERDOG at 2 per country
      const underdogInTop = top10Legacy.filter(
        r => r.budgetZone === 'UNDERDOG'
      );
      if (underdogInTop.length > 2) {
        const removed = underdogInTop.length - 2;
        let underdogSeen = 0;
        top10Legacy = top10Legacy.filter(r => {
          if (r.budgetZone !== 'UNDERDOG') return true;
          underdogSeen++;
          return underdogSeen <= 2;
        });
        const includedIds = new Set(
          top10Legacy.map(r => r.programId)
        );
        const replacements = filteredResults
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
        top10Legacy = [...top10Legacy, ...replacements];
        console.log(
          `[underdog] capped at 2, removed ${removed}` +
          ` underdog programs, added ${replacements.length} replacements`
        );
      }
      top10 = top10Legacy;
    }

    // ── Shortage fill loop ───────────────────────────────────────────────────
    // Runs only when ContainerQ validation dropped programs leaving top10 short.
    // Pulls overflow candidates (filteredResults rank > candidatePool), filters
    // by the stream keywords already computed at qualification stage, validates
    // through ContainerQ, and fills remaining slots up to countryFinalSlots.
    if (
      process.env.CONTAINER_Q === 'true' &&
      top10.length < countryFinalSlots
    ) {
      const shortage   = countryFinalSlots - top10.length;
      const usedUniIds = new Set(top10.map(r => r.universityId));
      const usedProgIds = new Set(top10.map(r => r.programId));
      const allKeywords = [
        ...mustMatchKeywords,
        ...shouldMatchKeywords,
        ...niceToMatchKeywords,
      ];

      const overflow = filteredResults
        .filter(r => {
          if (usedUniIds.has(r.universityId))  return false;
          if (usedProgIds.has(r.programId))    return false;
          if (allKeywords.length === 0)        return true;
          const name  = (r.programName  || '').toLowerCase();
          const field = (r.fieldOfStudy || '').toLowerCase();
          return allKeywords.some(k => name.includes(k) || field.includes(k));
        })
        .sort((a, b) =>
          b.fitScore - a.fitScore ||
          compareRank(a, b) ||
          (a.universityName || '').localeCompare(b.universityName || '') ||
          (a.programName    || '').localeCompare(b.programName    || ''))
        .slice(0, shortage * 3);   // fetch 3× to survive validation drops

      if (overflow.length > 0) {
        console.log(
          `[shortage-fill] top10=${top10.length} < target=${countryFinalSlots}` +
          ` shortage=${shortage} — validating ${overflow.length} overflow candidates`
        );

        const stream = studentAnalysis.stream || 'general';
        const overflowWithStream = overflow.map(c => ({ ...c, stream }));
        const validatedOverflow  = await validateCandidates(overflowWithStream);

        validatedOverflow.forEach(r => {
          const rank = existingRankMap.get(r.universityId);
          if (rank) Object.assign(r, rank);
        });

        const dedupedOverflow = dedupByUniversity(validatedOverflow);

        for (const r of dedupedOverflow) {
          if (top10.length >= countryFinalSlots) break;
          if (usedUniIds.has(r.universityId))   continue;
          r.tag = r.globalTier === reachTier ? 'REACH' : 'MATCH';
          top10.push(r);
          usedUniIds.add(r.universityId);
        }

        console.log(
          `[shortage-fill] filled to ${top10.length}` +
          ` (target ${countryFinalSlots})`
        );
      } else {
        console.log(
          `[shortage-fill] no keyword-matching overflow available` +
          ` — returning ${top10.length} results`
        );
      }
    }

    // Strip internal validation metadata before output
    top10 = top10.map(
      ({ _validationStatus, ...rest }) => rest
    );

    // ── Language layer ────────────────────────────────────────────────────────
    // Prefer English/Bilingual programs. Swap local-language programs out of
    // top10 if English alternatives exist in filteredResults. Tag remaining
    // local-language programs with isLanguageFallback. Tag Bilingual with isBilingual.
    const {
      applyLanguageLayer,
      buildNoRecNotice,
      isEnglishPool: isEngPool,
    } = require('../utils/languageLayer');

    // ── Supplementary T3/T4 preferred-language pool (language swap only) ─────
    // Main scoring covers T1/T2 only. If preferred-language slots can't be filled
    // from T1/T2, pull preferred-language T3/T4 programs as swap candidates.
    // These are ONLY passed into applyLanguageLayer — they do NOT affect top10
    // selection, scoring, budget fallback, dream candidates, or explore recs.
    let languageSwapPool = filteredResults;
    if (top10.length > 0) {
      const preferred = (studentProfile.preferredLanguage || 'English').trim();
      const isPreferredLang = lang =>
        preferred === 'English' ? isEngPool(lang) : (lang === preferred || lang === 'Bilingual');
      const nonPreferredInTop10 = top10.filter(r => !isPreferredLang(r.languageOfInstruction));
      const preferredInFiltered  = filteredResults.filter(r => isPreferredLang(r.languageOfInstruction));

      if (nonPreferredInTop10.length > 0 && preferredInFiltered.length < nonPreferredInTop10.length) {
        try {
          const langValues = preferred === 'English'
            ? ['English', 'Bilingual']
            : [preferred, 'Bilingual'];

          let suppQuery = supabase()
            .from('programs')
            .select(`
              id, name, degree_level, duration_years, delivery_mode,
              language_of_instruction, field_of_study, program_url,
              universities!inner (
                id, name, country, state, city, global_tier,
                institution_type, qs_rank, the_rank, can_apply_directly, apply_through, is_active
              )
            `)
            .eq('universities.country', currentCountry)
            .eq('universities.is_active', true)
            .in('universities.global_tier', [3, 4])
            .eq('is_active', true)
            .in('language_of_instruction', langValues);

          if (mustMatchKeywords.length > 0) {
            const nameFilters  = mustMatchKeywords.map(k => `name.ilike.%${k}%`);
            const fieldFilters = mustMatchKeywords.map(k => `field_of_study.ilike.%${k}%`);
            suppQuery = suppQuery.or([...nameFilters, ...fieldFilters].join(','));
          }

          const { data: suppPrograms } = await suppQuery.limit(20);

          const isUGStudent = ['Grade 10', 'Grade 11', 'Grade 12'].includes(studentProfile.grade || '');
          const PG_PREFIXES = ['M.', 'MSc', 'MBA', 'PhD', 'Master', 'LLM', 'MEng', 'MPhys'];
          const alreadyInPool = new Set(filteredResults.map(r => r.programId));

          const suppScored = (suppPrograms || [])
            .filter(p => p.universities)
            .filter(p => !alreadyInPool.has(p.id))
            .filter(p => !isUGStudent || !PG_PREFIXES.some(pg => (p.degree_level || '').startsWith(pg)))
            .map(p => {
              const uni = p.universities;
              const tierBase    = uni.global_tier === 3 ? 55 : 48;
              const keywordBoost = mustMatchKeywords.filter(k =>
                (p.name || '').toLowerCase().includes(k) ||
                (p.field_of_study || '').toLowerCase().includes(k)
              ).length * 3;
              return {
                programId:             p.id,
                universityId:          uni.id,
                universityName:        uni.name,
                programName:           p.name,
                degreeLevel:           p.degree_level,
                durationYears:         p.duration_years,
                deliveryMode:          p.delivery_mode,
                languageOfInstruction: p.language_of_instruction,
                destinationCountry:    currentCountry,
                city:                  uni.city,
                state:                 uni.state,
                institutionType:       uni.institution_type,
                qs_rank:               uni.qs_rank,
                the_rank:              uni.the_rank,
                fitScore:              Math.min(tierBase + keywordBoost, 65),
                globalTier:            uni.global_tier,
                tag:                   'MATCH',
                isLowerTierFill:       true,
                budgetExcluded:        false,
              };
            });

          if (suppScored.length > 0) {
            languageSwapPool = [...filteredResults, ...suppScored];
            console.log(
              `[languageLayer] ${currentCountry}: added ${suppScored.length}` +
              ` T3/T4 ${preferred} programs to swap pool`
            );
          }
        } catch (err) {
          console.warn('[languageLayer] supplementary T3/T4 query failed:', err.message);
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    let languageFallbackNotice = null;
    let noRecNotice = null;

    if (top10.length === 0) {
      noRecNotice = buildNoRecNotice(currentCountry, finalScoredResults, studentProfile.preferredLanguage || '');
      console.log(
        `[languageLayer] ${currentCountry}: 0 programs —`,
        noRecNotice?.message
      );
    } else {
      const langResult = applyLanguageLayer(
        top10,
        languageSwapPool,
        currentCountry,
        countryFinalSlots,
        studentProfile.preferredLanguage || ''
      );
      top10                  = langResult.top10;
      languageFallbackNotice = langResult.languageFallbackNotice;

      if (languageFallbackNotice) {
        console.log(
          `[languageLayer] ${currentCountry}: ${languageFallbackNotice.englishCount} English` +
          ` + ${languageFallbackNotice.localCount} ${languageFallbackNotice.localLanguage}` +
          ` fallback programs`
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Enrich each university card
    // with additional relevant programs
    // from the same university
    const secondaryIntentKeywords = expandKeywords(
      studentAnalysis.search_strategy?.secondary_intent || []
    );

    // EXPLORE recs — nice_to_match / secondary_intent programs from non-top10 universities
    const top10Ids    = new Set(top10.map(r => r.programId));    // programme-level dedup
    const top10UniIds = new Set(top10.map(r => r.universityId)); // university-level dedup
    const exploreRecs = (() => {
      const exploreKeywords = [
        ...niceToMatchKeywords,
        ...secondaryIntentKeywords,
      ];
      if (exploreKeywords.length === 0) return [];

      return filteredResults
        .filter(r => !top10UniIds.has(r.universityId))
        .filter(r => {
          const name  = (r.programName  || '').toLowerCase();
          const field = (r.fieldOfStudy || '').toLowerCase();
          return exploreKeywords.some(k =>
            name.includes(k) || field.includes(k)
          );
        })
        .sort((a, b) =>
          b.fitScore - a.fitScore ||
          compareRank(a, b) ||
          (a.universityName || '').localeCompare(b.universityName || '')
        )
        .slice(0, 5)
        .map(r => ({
          ...r,
          isExplore:          true,
          exploreTag:         'EXPLORATORY',
          destinationCountry: currentCountry,
        }));
    })();

    console.log(
      `[explore] ${exploreRecs.length} exploratory recs for ${currentCountry}`
    );

    // Add Query C exact matches to explore recs
    if (queryCData.length > 0) {
      const top10Ids = new Set(top10.map(r => r.universityId));

      // PG filter for explore — same logic as main loop.
      // Query C queries programs directly with no degree_level filter,
      // so we must strip PG programs here for UG-only students.
      const gradeFieldQC = studentProfile.grade || studentProfile.currentGrade || '';
      const isUndergradQC = ['Grade 10', 'Grade 11', 'Grade 12'].includes(gradeFieldQC);
      const PG_LEVELS_QC = new Set([
        'M.Tech', 'M.Sc', 'MBA', 'PhD', 'Ph.D', 'MA', 'M.A.', 'M.A',
        'M.Sc.', 'M.Pharm', 'MSc', 'M.Phil.', 'MCA', 'MFA', 'M.Com',
        'PG Diploma', 'PGD', 'MSW', 'LL.M.', 'LL.M', 'LLM', 'LLD', 'BCL',
        'M.Arch', 'M.Phil',
        'M.Ed', 'M.P.Ed', 'M.E.', 'MBA / PGDM', 'MBA/PGDM', 'MBA.', 'MBA + MCA',
        'M.Eng.', 'M.B.A.', 'M.Ed.', 'M.Mus.',
        'MMM', 'Magister', 'Master of Music',
        'Ph.D.', 'second cycle', 'Dr. phil.', 'Konzertexamen',
        'MEng', 'M.Eng', 'MPhys', 'MPharm', 'MChem',
        'MMath', 'MBiol', 'MGeol', 'MEarthSci',
        'MS', 'MA', 'MFA', 'MPA', 'MPH', 'MIS', 'MEd',
      ]);
      const isUgProgram = (p) => {
        if (!isUndergradQC) return true;
        const deg = p.degree_level || '';
        return !PG_LEVELS_QC.has(deg) && !deg.startsWith('Master') && !deg.startsWith('M.') && !deg.startsWith('LL.');
      };

      // Only surface lower-tier exact matches (Query C) when the main 10
      // couldn't find the student's desired programme at their eligible tier.
      // If the main recs already satisfy mustMatchKeywords, Query C is a
      // fallback that served no purpose — showing it would contradict the
      // main results and confuse the student.
      const mainRecsHaveMustMatch = top10.some(r =>
        mustMatchKeywords.some(k =>
          (r.programName  || '').toLowerCase().includes(k) ||
          (r.fieldOfStudy || '').toLowerCase().includes(k)
        )
      );

      if (mainRecsHaveMustMatch) {
        console.log(
          `[queryC] ${currentCountry}: skipping EXACT_PROGRAM_MATCH — ` +
          `main recs already satisfy mustMatch keywords`
        );
      } else {
        const queryCExplore = queryCData
          .filter(p => p.universities && !top10UniIds.has(p.universities.id))
          .filter(p => isUgProgram(p))
          .map(p => ({
            universityId:       p.universities.id,
            universityName:     p.universities.name,
            programId:          p.id,
            programName:        p.name,
            fieldOfStudy:       p.field_of_study,
            destinationCountry: currentCountry,
            fitScore:           60,
            tag:                'MATCH',
            isExplore:          true,
            exploreTag:         'EXACT_PROGRAM_MATCH',
            exploreReason:      `${p.name} at ${p.universities.name} is an exact match for what you want. ` +
                                `No ${iterationProfile.primaryStream || 'matching'} programmes were found ` +
                                `at your eligible tiers (Tier ${matchTier}${reachTier ? `/${reachTier}` : ''}). ` +
                                `This university is at Tier ${p.universities.global_tier} — ` +
                                `your academic profile is stronger than typical applicants here, ` +
                                `giving you a high chance of admission.`,
            global_tier:        p.universities.global_tier,
          }))
          .slice(0, 3); // max 3 from Query C per country

        allExploreRecs.push(...queryCExplore);
        console.log(`[queryC] added ${queryCExplore.length} explore recs for ${currentCountry}`);
      }
    }

    top10 = await enrichWithAdditionalPrograms(
      top10,
      mustMatchKeywords,
      shouldMatchKeywords,
      supabase(),
      secondaryIntentKeywords
    );

    console.log('STAGE 8: total =', top10.length,
      'recommendations');

    // ── STAGE 8 (formerly 10): Generate "Why this uni?" ──────────────────────

    // Fallback string when Claude is unavailable — built from scored data only
    function whyFallback(item) {
      return `${item.universityName} offers ${item.programName} ` +
        `with a fit score of ${item.fitScore}/100 (${item.tag}). ` +
        `Academic: ${item.breakdown.academic}/30 · ` +
        `Program: ${item.breakdown.program}/25 · ` +
        `Budget: ${item.breakdown.budget}/10.`;
    }

    // generateWhyThisUni with one retry (2s delay) before fallback.
    // Many Anthropic 500s are transient — one retry resolves most.
    // Passes programId + universityId for static block cache lookup (ContainerWS).
    async function generateWhyWithRetry(item) {
      const args = [
        { name: item.universityName, institution_type: item.institutionType },
        { name: item.programName },
        enrichedProfile,
        { breakdown: item.breakdown, fitScore: item.fitScore, tag: item.tag },
        item.programId    || null,          // cache key for static block
        item.universityId || null,          // informational
        item.level        || 'undergraduate',
        currentCountry                      // destinationCountry
      ];
      try {
        return await generateWhyThisUni(...args);
      } catch (err) {
        console.warn(
          `[why] attempt 1 failed for "${item.universityName}" — ` +
          `${err.message} — retrying in 2s`
        );
        await new Promise(r => setTimeout(r, 2000));
        return await generateWhyThisUni(...args); // throws → caught by allSettled
      }
    }

    console.log('TIMING:', currentCountry, 'generateWhyThisUni START', Date.now() - loopStartTime + 'ms');
    const whySettled = await Promise.allSettled(
      top10.map(item => generateWhyWithRetry(item))
    );
    console.log('TIMING:', currentCountry, 'generateWhyThisUni END', Date.now() - loopStartTime + 'ms');

    const recommendations = await Promise.all(
      top10.map(async (item, i) => {
        const settled = whySettled[i];
        const coreWhy = settled.status === 'fulfilled'
          ? settled.value
          : (() => {
              console.error(
                `[why] both attempts failed for "${item.universityName}" — ` +
                `using fallback. Reason: ${settled.reason?.message}`
              );
              return whyFallback(item);
            })();

        const whyThisUni = coreWhy;

        return { ...item, whyThisUni };
      })
    );

    // ── Build tierDisplay from Claude's eligibility assessment ───────────────
    // These drive the tier cards — not assignTiers()
    const tierDisplay = {
      tier1: {
        tag: eligibility.tier1_tag || null,
        status: eligibility.tier1_tag === 'MATCH' ? 'eligible'
          : eligibility.tier1_tag === 'REACH' ? 'eligible'
          : eligibility.tier1_tag === 'ASPIRATIONAL' ? 'aspirational'
          : 'not_realistic'
      },
      tier2: {
        tag: eligibility.tier2_tag || null,
        status: eligibility.tier2_tag === 'MATCH' ? 'eligible'
          : eligibility.tier2_tag === 'REACH' ? 'eligible'
          : eligibility.tier2_tag === 'SAFE' ? 'eligible'
          : 'not_realistic'
      },
      tier3: {
        tag: eligibility.tier3_tag || null,
        status: eligibility.tier3_tag ? 'eligible'
          : 'not_realistic'
      },
      tier4: {
        tag: eligibility.tier4_tag || null,
        status: eligibility.tier4_tag ? 'eligible'
          : 'not_realistic'
      },
      reasoning: eligibility.eligibility_reasoning || ''
    };

    // ── Build response ────────────────────────────────────────────────────────
    const tierAnalysis = {
      currentGrade:           currentGradeNum,
      board,
      normalizedMarks,
      trend,
      prediction,
      predictionUsed,
      isEarlyExplorer,
      applicationYearEstimate,
      tierEligibility,
      tierDisplay,
      studentCategory,
      destinationCountry:     iterationProfile.destinationCountry,
      stream:                 studentAnalysis.stream,
      subjectProfile:         studentAnalysis.subject_profile,
      eligibility:            studentAnalysis.eligibility,
      eligibleTiers:          [matchTier, reachTier].filter(Boolean),
      counsellorNote:         studentAnalysis.counsellor_note,
      aspirationMismatch:     studentAnalysis.aspiration_mismatch,
      mismatchNote:           studentAnalysis.mismatch_note,
      aspirationClarity:      studentAnalysis.aspiration_clarity,
      analysisConfidence:     studentAnalysis.confidence,
      normalizedScore:        studentAnalysis.subject_profile?.normalized_score,
      normalizationBasis:     studentAnalysis.subject_profile?.normalization_basis,
      foundationYearRequired: studentAnalysis.subject_profile?.foundation_year_required,
      equivalencyRequired:    studentAnalysis.subject_profile?.equivalency_required,
      equivalencyNote:        studentAnalysis.subject_profile?.equivalency_note,
      languageTestRequired:   studentAnalysis.subject_profile?.language_test_required,
      languageTestNote:       studentAnalysis.subject_profile?.language_test_note,
      reasoning:              studentAnalysis.reasoning,
      degreeLevels:           studentAnalysis.degree_levels,
      knnFeatures:            studentAnalysis.knn_features,
      studentSummary:         studentAnalysis.student_summary,
      searchStrategy:         studentAnalysis.search_strategy,
      marksHistory,
      post_grad_strategy:     postGradStrategy,
      campus_preferences:     campusPreferences,
      searchContext: {
        primarySearched:  mustMatchKeywords.join(', '),
        fallbackApplied:  survivingAfterPass1 === 0,
        fallbackNote: survivingAfterPass1 === 0
          ? `We searched for programmes in "${mustMatchKeywords.join(', ')}" but found none at ${currentCountry} universities matching your tier and budget. Showing ${shouldMatchKeywords[0] ? shouldMatchKeywords[0] + ' programmes' : 'the closest available alternatives'} instead — these are the strongest foundation for your goals.`
          : null,
        dreamAvailable:   dreamCandidate !== null,
        exploreAvailable: exploreRecs.length > 0,
      },
      languageFallbackNotice,
      noRecNotice,
    };

    allTierAnalyses.push({
      country: currentCountry,
      tierAnalysis,
    });

    // ── Container M — Live Requirements Enrichment ───────────────────────────
    const { getLiveRequirements } = require('../services/requirements');
    let finalRecommendations = recommendations;

    if (process.env.CONTAINER_M_ENABLED !== 'false') {
      console.log('[containerM] enriching top 10...');
      const containerMStart = Date.now();

      // Build guide anchor once — same for all recs in this country loop.
      // Scores sentences by keyword density, takes top 6, caps at 800 chars.
      const GUIDE_KEYWORDS = [
        'english', 'ielts', 'toefl', 'language', 'deadline',
        'ucas', 'uni-assist', 'aps', 'blocked', 'visa',
        'test', 'exam', 'fee', 'requirement', 'eligib',
      ];
      const guideAnchor = (() => {
        if (!admissionGuide) return null;
        const sentences = admissionGuide
          .split(/(?<=[.!?])\s+/)
          .filter(s => s.trim().length > 0);
        const scored = sentences.map(s => {
          const lower = s.toLowerCase();
          const score = GUIDE_KEYWORDS.reduce(
            (acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0
          );
          return { s, score };
        });
        const top = scored
          .sort((a, b) => b.score - a.score)
          .slice(0, 6)
          .map(x => x.s)
          .join(' ');
        return top.slice(0, 800) || null;
      })();

      // Raw board percentage — currentEntry already computed at line 278,
      // in scope here. No recomputation needed.
      // scoreBand partitions cache key so different score tiers don't share
      // eligibility evaluations (your_score_meets_requirement).
      const boardPercentage = currentEntry?.overall ?? null;
      const scoreBand =
        boardPercentage === null ? 'unknown'
        : boardPercentage >= 95  ? 'top'
        : boardPercentage >= 85  ? 'high'
        : boardPercentage >= 75  ? 'good'
        : boardPercentage >= 60  ? 'mid'
        : 'low';

      // ── Subject summary for Container M ──────────────────────────────────
      // Trimmed from subject_profile — strips internal normalization fields.
      // Passed to Perplexity for subject-gate eligibility evaluation.
      // subject_profile itself may be null even when studentAnalysis is not.
      const subjectSummary =
        studentAnalysis.subject_profile
        ? {
            subjects_found:      studentAnalysis.subject_profile.subjects_found || {},
            pcm_average:         studentAnalysis.subject_profile.pcm_average ?? null,
            pcb_average:         studentAnalysis.subject_profile.pcb_average ?? null,
            subject_combination: studentAnalysis.subject_profile.subject_combination || null,
            strongest_subject:   studentAnalysis.subject_profile.strongest_subject || null,
            weakest_subject:     studentAnalysis.subject_profile.weakest_subject || null,
            overall_average:     studentAnalysis.subject_profile.overall_average ?? null,
          }
        : null;

      console.log('TIMING:', currentCountry, 'getLiveRequirements START', Date.now() - loopStartTime + 'ms');
      const enrichedResults = await Promise.allSettled(
        recommendations.map(async (rec, idx) => {
          try {
            // Container M and Container S run in parallel per program.
            // Small 100ms stagger between Gemini calls as hygiene (Tier 1 allows 1K RPM).
            const scholarshipDelay = new Promise(res => setTimeout(res, idx * 100));
            const [liveRequirements, meritScholarships] = await Promise.all([
              getLiveRequirements(
                rec,
                iterationProfile.passportCountry,
                iterationProfile.countryOfResidence,
                studentCategory.category,
                tierAnalysis.normalizedScore,
                iterationProfile.destinationCountry,
                iterationProfile.board,
                guideAnchor,
                boardPercentage,
                scoreBand,
                studentAnalysis.stream,
                subjectSummary,
                admissionGuide,
                admissionContext
              ),
              scholarshipDelay.then(() => fetchUniversityScholarships(
                rec.universityName,
                rec.programName,
                iterationProfile.destinationCountry,
                iterationProfile.passportCountry,
                rec.level || 'undergraduate',
                getScholarshipGuide(
                  iterationProfile.destinationCountry,
                  iterationProfile.passportCountry
                ),
                rec.programId   || null,   // cache key
                rec.universityId || null    // informational
              )).catch(() => ({ summary: '', sources: [], items: [] })),
            ]);

            // meritScholarships shape: { summary, sources, items } or { summary:'', sources:[], items:[] }
            const hasScholarshipData = meritScholarships?.items?.length > 0 || meritScholarships?.summary?.length > 0;
            return {
              ...rec,
              liveRequirements: liveRequirements || null,
              merit_scholarships: hasScholarshipData ? meritScholarships : null,
            };
          } catch (err) {
            console.warn(
              `[containerM] failed for "${rec.universityName}": ${err.message}`
            );
            return { ...rec, liveRequirements: null };
          }
        })
      );

      finalRecommendations = enrichedResults.map(
        (r) => r.status === 'fulfilled'
          ? r.value
          : { ...r.reason, liveRequirements: null }
      );

      console.log(`[containerM] done in ${Date.now() - containerMStart}ms`);
      console.log('TIMING:', currentCountry, 'getLiveRequirements END', Date.now() - loopStartTime + 'ms');
    } else {
      console.log('[containerM] disabled via env');
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Collect this country's recommendations
    // trimmed to its slot allocation
    const countryRecs = finalRecommendations
      .slice(0, countryFinalSlots)
      .map(rec => ({
        ...rec,
        destinationCountry: currentCountry,
      }));

    allRecommendations.push(...countryRecs);

    if (dreamCandidate) allDreamRecs.push(dreamCandidate);
    allExploreRecs.push(...exploreRecs);

      }) // end iteration
  ) // end Promise.allSettled
    // ────────────────────────────────────

    // Check for fatal rejections
      const fatalRejections = loopResults
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || 'Unknown error');

      if (fatalRejections.length > 0 && allRecommendations.length === 0) {
        console.error('[analyze] All destinations failed:', fatalRejections);
        return res.status(500).json({
          error: 'Analysis failed',
          message: fatalRejections[0]
        });
      }
      if (fatalRejections.length > 0) {
        console.warn('[analyze] Some destinations failed:', fatalRejections);
      }

    const attemptedCountries = destinationCountries.map(d => d.country);
    const successfulCountries = [...new Set(
      allRecommendations.map(r => r.destinationCountry).filter(Boolean)
    )];
    const skippedCountries = attemptedCountries
      .filter(c => !successfulCountries.includes(c))
      .map(c => ({
        country: c,
        reason:  'no_results',
        message: `No universities found for ${c} — this destination may not be in our database yet.`
      }));

    // Sort results by original destination priority order
    // (Promise.allSettled does not guarantee order)
    const priorityOrder = destinationCountries.map(d => d.country);

    allRecommendations.sort((a, b) =>
      priorityOrder.indexOf(a.destinationCountry) -
      priorityOrder.indexOf(b.destinationCountry)
    );

    allTierAnalyses.sort((a, b) =>
      priorityOrder.indexOf(a.country) -
      priorityOrder.indexOf(b.country)
    );

    allDreamRecs.sort((a, b) =>
      priorityOrder.indexOf(a.destinationCountry) -
      priorityOrder.indexOf(b.destinationCountry)
    );

    allExploreRecs.sort((a, b) =>
      priorityOrder.indexOf(a.destinationCountry) -
      priorityOrder.indexOf(b.destinationCountry)
    );

    console.log('STAGE 10: sending response with',
      allRecommendations.length, 'recommendations');

    const responseRecommendations =
      allRecommendations;

    res.json({
      tierAnalysis:
        allTierAnalyses[0]?.tierAnalysis || null,
      tierAnalyses: allTierAnalyses,
      recommendations:       responseRecommendations,
      dreamRecommendations:  allDreamRecs,
      exploreRecommendations: allExploreRecs,
      formData: {
        studentProfile: {
          passportCountry:    studentProfile.passportCountry    || null,
          countryOfResidence: studentProfile.countryOfResidence || null,
          grade:              studentProfile.grade              || null,
        },
        scholarshipChunks: (() => {
          const destCountries = destinationCountries.map(d => d.country);
          return loadScholarshipChunks(destCountries, studentProfile.passportCountry || null);
        })(),
        countryCurrencyMap: COUNTRY_CURRENCY,
        fxRatesUSDToLocal: (() => {
          // FX_RATES_TO_USD is local→USD (e.g. INR: 0.012)
          // Invert to USD→local for frontend display
          const usdToLocal = {};
          for (const [ccy, rate] of Object.entries(FX_RATES_TO_USD)) {
            usdToLocal[ccy] = rate > 0 ? 1 / rate : 1;
          }
          return usdToLocal;
        })(),
        perCountryBudgets: destinationCountries.map(d => ({
          country: d.country,
          ...deriveCountryBudget(
            studentBudget.minUSD || 0,
            studentBudget.maxUSD || 0,
            d.country
          ),
        })),
        fxRateStale: fxRatesStale || false,
      },
      skippedCountries,
    });

  } catch (err) {
    console.error('Analyze route error:', err);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

module.exports = router;

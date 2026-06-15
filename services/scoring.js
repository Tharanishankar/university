const { getExamPathway } = require('../data/india_prereqs');
const { calculateBudgetFitV2, convertToUSD } = require('./budgetScoring');

// Get minimum required marks from admission requirements array
function getMinRequired(admissionRequirements) {
  if (!admissionRequirements || admissionRequirements.length === 0) return null;
  const overall = admissionRequirements.find(
    (r) => r.subject_group === 'overall' || r.subject_group === 'Overall'
  );
  return overall ? parseFloat(overall.min_percentage) : null;
}

function calculateAcademicFit(studentMarks, minRequired) {
  if (!minRequired) return 0.85;
  const gap = studentMarks - minRequired;
  if (gap >= 10) return 1.0;
  if (gap >= 5) return 0.95;
  if (gap >= 0) return 0.85;
  if (gap >= -5) return 0.70;
  if (gap >= -10) return 0.50;
  return 0.30;
}

// Environment fit (25 points)
// Only exact delivery mode match from DB data.
// All content/style fit already handled by Claude
// in scorePrograms() via knn_features.
function matchEnvironment(university, program, studentProfile) {
  let envScore = 20; // default — Claude handled the rest

  if (studentProfile && program.delivery_mode) {
    const preferredMode = (studentProfile.studyMode || '').toLowerCase();
    const actualMode = (program.delivery_mode || '').toLowerCase();

    // Exact delivery mode match — boost or penalise
    if (preferredMode && actualMode &&
        preferredMode !== 'no preference' &&
        actualMode !== 'unknown') {
      const modeMatch =
        (preferredMode === 'on-campus' && actualMode === 'campus') ||
        (preferredMode === 'online'    && actualMode === 'online')  ||
        (preferredMode === 'hybrid'    && actualMode === 'hybrid');
      if (modeMatch) envScore = 25;
      else envScore = 15;
    }
  }

  return envScore;
}

// Fee category map — maps student category key to known
// DB fee row labels across all supported university systems.
// Add new country fee category labels here when onboarding
// new countries. Check tuition_fees.student_category values
// in DB for each new country.
const FEE_CATEGORY_MAP = {
  domestic: [
    'General', 'general',
    'Indian', 'domestic', 'home_uk',
    'eu_domestic',        // Germany EU students
  ],
  diaspora: [
    'NRI', 'nri', 'foreign_national', 'international',
  ],
  international: [
    'international',      // UK, USA
    'foreign',            // generic
    'non_eu',             // Germany
    'foreign_national',   // India
    'all', 'ALL',         // USA universal
    'overseas',           // AU/CA future
  ],
};

// Resolve whatever nationality string arrives (form input or
// computed category code) to one of the three internal keys.
function resolveCategory(nationality) {
  if (!nationality) return 'domestic';
  const n = String(nationality).toLowerCase().trim();
  // New category codes — direct match
  if (n === 'domestic')      return 'domestic';
  if (n === 'diaspora')      return 'diaspora';
  if (n === 'international') return 'international';
  // Old category codes — backward compat
  if (n === 'resident_indian' || n === 'indian resident') return 'domestic';
  if (n === 'nri' || n.startsWith('nri ') || n === 'oci/pio') return 'diaspora';
  if (n === 'foreign_national' || n === 'foreign national') return 'international';
  return 'domestic'; // safe default
}

// Get fee for student category
function getFeeForStudent(tuitionFees, nationality, passportCountry = null, destinationCountry = null) {
  if (!tuitionFees || tuitionFees.length === 0) return null;

  // EU passport → Germany: override to eu_domestic fee
  const EU_PASSPORT_COUNTRIES = [
    'France', 'Italy', 'Spain', 'Netherlands', 'Belgium', 'Austria',
    'Poland', 'Sweden', 'Denmark', 'Finland', 'Portugal', 'Greece',
    'Czech Republic', 'Romania', 'Hungary', 'Ireland', 'Croatia',
    'Slovakia', 'Bulgaria', 'Lithuania', 'Latvia', 'Estonia',
    'Slovenia', 'Luxembourg', 'Malta', 'Cyprus'
  ];
  if (destinationCountry === 'Germany' &&
      passportCountry &&
      EU_PASSPORT_COUNTRIES.includes(passportCountry)) {
    const euMatch = tuitionFees.find(f => f.student_category === 'eu_domestic');
    if (euMatch) {
      return {
        amount:   parseFloat(euMatch.annual_fee),
        currency: euMatch.currency || 'EUR',
      };
    }
  }

  const category = resolveCategory(nationality);
  const labels   = FEE_CATEGORY_MAP[category];

  const match = tuitionFees.find(f => labels.includes(f.student_category));
  if (match) {
    if (!match.currency) {
      console.warn(
        `[fee] null currency on student_category="${match.student_category}" — defaulting to INR`
      );
    }
    return {
      amount:   parseFloat(match.annual_fee),
      currency: match.currency || 'INR'
    };
  }

  // Final fallback — no matching label found
  // Return null rather than silently returning a potentially wrong fee
  // (e.g. domestic fee for an international student)
  console.warn(
    `[fee] no matching fee category for nationality="${nationality}" ` +
    `destination="${destinationCountry}" — labels checked: ${JSON.stringify(labels)} ` +
    `— available: ${tuitionFees.map(f => f.student_category).join(', ')}`
  );
  return null;
}

function calculateBudgetFit(feeUSD, budgetUSD) {
  if (feeUSD === null || feeUSD === undefined || !budgetUSD) return 0.7;
  const ratio = feeUSD / budgetUSD;
  if (ratio <= 0.5) return 1.0;
  if (ratio <= 0.75) return 0.95;
  if (ratio <= 0.9) return 0.85;
  if (ratio <= 1.0) return 0.70;
  if (ratio <= 1.2) return 0.50;
  return 0.20;
}

// Safely parse a ranking value that may be banded (e.g. '=101-200', '501-600')
// Returns the lower bound of the range as an integer, or null if unparseable
function parseRank(rank) {
  if (!rank) return null;
  const str = String(rank).replace(/[^0-9\-]/g, '');
  const num = parseInt(str.split('-')[0]);
  return isNaN(num) ? null : num;
}

function getReputationScore(naacGrade, institutionType, rankings = {}) {
  // Cluster 1 — QS World Ranking
  const qs = parseRank(rankings.qs_rank);
  if (qs !== null && qs > 0) {
    if (qs <= 50)   return 10;
    if (qs <= 100)  return 9;
    if (qs <= 200)  return 8;
    if (qs <= 500)  return 7;
    if (qs <= 1000) return 6;
    return 5;
  }

  // Cluster 2 — THE World Ranking
  const the = parseRank(rankings.the_rank);
  if (the !== null && the > 0) {
    if (the <= 50)   return 10;
    if (the <= 100)  return 9;
    if (the <= 200)  return 8;
    if (the <= 500)  return 7;
    if (the <= 1000) return 6;
    return 5;
  }

  // Cluster 3 — ARWU Shanghai Ranking
  const arwu = parseRank(rankings.arwu_rank);
  if (arwu !== null && arwu > 0) {
    if (arwu <= 50)  return 10;
    if (arwu <= 100) return 9;
    if (arwu <= 200) return 8;
    if (arwu <= 500) return 7;
    return 6;
  }

  // Cluster 4 — Regional Ranking
  const regional = parseRank(rankings.regional_rank);
  if (regional !== null && regional > 0) {
    if (regional <= 10) return 8;
    if (regional <= 25) return 7;
    if (regional <= 50) return 6;
    return 5;
  }

  // Cluster 5 — Country Ranking (NIRF, CUG, US News etc.)
  const country = parseRank(rankings.country_rank);
  const nirf    = parseRank(rankings.nirf_rank);
  const bestCountry = [country, nirf]
    .filter(r => r !== null && r > 0)
    .sort((a, b) => a - b)[0] || null;

  if (bestCountry) {
    if (bestCountry <= 10) return 8;
    if (bestCountry <= 25) return 7;
    if (bestCountry <= 50) return 6;
    return 5;
  }

  // Cluster 6 — No international ranking
  // Fall back to India domestic: NAAC grade + institution type
  const typeScore = {
    institute_of_national_importance: 10,
    central_university: 9,
    deemed_university: 7,
    university: 6,
    autonomous_college: 5,
    affiliated_college: 3,
    private: 5,
  };
  const gradeScore = {
    'A++': 10, 'A+': 9, A: 8,
    'B++': 7, 'B+': 6, B: 5,
    C: 4,
  };
  const ts = typeScore[institutionType] || 5;
  const gs = gradeScore[naacGrade] || 5;
  return Math.round(ts * 0.5 + gs * 0.5);
}

// Determine REACH / MATCH / SAFE tag
function getReachMatchSafe(fitScore, studentMarks, minRequired) {
  const gap = minRequired ? studentMarks - minRequired : 5;
  if (fitScore >= 95 || gap >= 10) return 'SAFE';
  if (fitScore >= 85 || gap >= 0) return 'MATCH';
  return 'REACH';
}

// claudeProgramScore = 0-25 integer from Claude's scorePrograms()
function scoreUniversity(university, program, studentProfile, claudeProgramScore) {
  // Academic Fit (30 points)
  const minRequired = getMinRequired(program.admission_requirements);
  const academicFit = calculateAcademicFit(studentProfile.normalizedMarks, minRequired);
  const academicScore = Math.round(academicFit * 30);

  // Program Fit (25 points) — Claude-scored
  const programScore = claudeProgramScore ?? 12;

  // Environment Fit (25 points) — delivery mode match only
  const envScore = matchEnvironment(university, program, studentProfile);

  // Budget Fit (10 points) — Container I (V2) with V1 fallback
  const feeData = getFeeForStudent(
    program.tuition_fees,
    studentProfile.nationality,
    studentProfile.passportCountry    || null,
    studentProfile.destinationCountry || null,
  );
  // Convert fee to USD using the currency field from the DB row
  let feeUSD = null;
  if (feeData) {
    try {
      feeUSD = Math.round(convertToUSD(feeData.amount, feeData.currency));
    } catch {
      // Unknown currency — V2 will throw below, V1 fallback handles it
    }
  }

  let budgetScore, budgetZone, budgetBadge, budgetExcluded;
  let budgetExclusionReason, scholarshipFlag, affordableFlag, budgetFallback;

  try {
    if (feeUSD === null || feeUSD === undefined) throw new Error('No fee data');
    const result = calculateBudgetFitV2(
      feeUSD,
      studentProfile.studentBudget?.minUSD,
      studentProfile.studentBudget?.maxUSD,
      university.global_tier,
      studentProfile.destinationCountry || null,
      studentProfile.studentBudget?.budgetStatus === 'covers_all'
    );
    budgetScore          = result.score;
    budgetZone           = result.zone;
    budgetBadge          = result.badge;
    budgetExcluded       = result.excluded;
    budgetExclusionReason = result.exclusionReason;
    scholarshipFlag      = result.scholarshipFlag;
    affordableFlag       = result.affordableFlag || false;
    budgetFallback       = false;
  } catch (err) {
    console.warn(
      `[budget-v2] FALLBACK uni="${university.name}" ` +
      `fee=${feeUSD} reason="${err.message}" → using V1`
    );
    // Fall back to old single-budget logic — V1 preserved below
    const v1Ratio = calculateBudgetFit(
      feeUSD, studentProfile.studentBudget?.maxUSD || studentProfile.budgetUSD
    );
    budgetScore          = Math.round(v1Ratio * 10);
    budgetZone           = 'FALLBACK';
    budgetBadge          = null;
    budgetExcluded       = false;
    budgetExclusionReason = null;
    scholarshipFlag      = false;
    budgetFallback       = true;
  }

  // Reputation (10 points)
  const reputationScore = getReputationScore(
    university.naac_grade,
    university.institution_type,
    {
      qs_rank:       university.qs_rank,
      the_rank:      university.the_rank,
      arwu_rank:     university.arwu_rank,
      regional_rank: university.regional_rank,
      country_rank:  university.country_rank,
      nirf_rank:     university.nirf_rank,
    }
  );

  const totalScore = academicScore + programScore + envScore + budgetScore + reputationScore;
  const tag = getReachMatchSafe(totalScore, studentProfile.normalizedMarks, minRequired);

  // Exam pathway info
  const fieldOfStudy = program.field_of_study || 'general';
  const examInfo = getExamPathway(
    university.institution_type,
    fieldOfStudy,
    studentProfile.nationality,
    studentProfile.parentInGulf
  );

  // Fee in both currencies (annualFeeRaw = raw DB amount, any currency)
  const annualFeeRaw = feeData?.amount ?? null;
  const annualFeeUSD = feeUSD; // already converted via convertToUSD

  return {
    universityId: university.id,
    universityName: university.name,
    city: university.city,
    state: university.state,
    institutionType: university.institution_type,
    naacGrade: university.naac_grade,
    website: university.website,
    programId: program.id,
    programName: program.name,
    programUrl: program.program_url || null,
    fieldOfStudy: program.field_of_study,
    degreeLevel: program.degree_level,
    durationYears: program.duration_years,
    deliveryMode: program.delivery_mode,
    languageOfInstruction: program.language_of_instruction || 'English',
    annualFeeRaw,
    annualFeeUSD,
    annualFeeCurrency: feeData?.currency || null,
    examRequired: examInfo.examRequired,
    admissionPathway: examInfo.pathway,
    minRequired,
    feeUSD,
    fitScore: totalScore,
    tag,
    breakdown: {
      academic: academicScore,
      program: programScore,
      environment: envScore,
      budget: budgetScore,
      reputation: reputationScore,
    },
    // Container I metadata
    budgetZone,
    budgetBadge,
    budgetExcluded,
    budgetExclusionReason,
    scholarshipFlag,
    affordableFlag,
    budgetFallback,
    programMatch: program.programMatch || 'direct',
  };
}

module.exports = {
  scoreUniversity,
  getFeeForStudent,
  getMinRequired,
  calculateAcademicFit,
  calculateBudgetFit,
  getReputationScore,
  getReachMatchSafe,
};

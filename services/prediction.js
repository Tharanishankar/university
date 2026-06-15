/**
 * prediction.js — Math-only functions for display.
 * No intelligence here. Claude handles all decisions.
 * These functions support the UI display layer only.
 */

const _countryConfigs  = require('../data/country-config');
const _defaultConfig   = require('../data/country-config/default');
function getCountryConfig(country) {
  return _countryConfigs[country] || _defaultConfig;
}
const { normalizeBoard } = require('../utils/boardNormalization');

/**
 * Board-aware marks normalisation.
 * Delegates to boardNormalization.js for all board-specific logic.
 */
function normalizeMarks(marks, board) {
  return normalizeBoard(marks, board).normalized_score;
}

/**
 * Calculate trend from marks history.
 * @param {Array} marksHistory [{grade, overall}]
 */
function calculateTrend(marksHistory) {
  if (!marksHistory ||
      marksHistory.length < 2) {
    return {
      trend: 'single',
      delta: 0,
      volatileFlag: false,
      note: 'Add more grade entries ' +
        'to see your improvement trend.'
    };
  }

  const sorted = [...marksHistory]
    .sort((a, b) => a.grade - b.grade);
  const deltas = [];
  for (let i = 1; i < sorted.length; i++) {
    deltas.push(
      sorted[i].overall -
      sorted[i - 1].overall
    );
  }
  const rawAvg =
    deltas.reduce((a, b) => a + b, 0)
    / deltas.length;

  // Flag volatile before capping
  const volatileFlag =
    Math.abs(rawAvg) > 8;

  // Cap delta at ±8 per year
  const cappedAvg = Math.min(8,
    Math.max(-8, rawAvg));
  const delta = Math.round(cappedAvg);

  if (volatileFlag) {
    return {
      trend: 'volatile',
      delta,
      volatileFlag: true,
      note: 'Your marks show significant ' +
        'variation. We have used a ' +
        'conservative estimate for ' +
        'your Grade 12 prediction.'
    };
  }

  if (delta > 1) {
    return {
      trend: 'improving',
      delta,
      volatileFlag: false,
      note: 'Your marks are improving ' +
        'year on year. Maintain this ' +
        'in Grade 12 to access your ' +
        'target programmes.'
    };
  }

  if (delta < -1) {
    return {
      trend: 'declining',
      delta,
      volatileFlag: false,
      note: 'Your marks show a dip. ' +
        'Focus on strengthening your ' +
        'core subjects in Grade 12.'
    };
  }

  return {
    trend: 'stable',
    delta: 0,
    volatileFlag: false,
    note: 'Your marks are consistent. ' +
      'Strong Grade 12 results will ' +
      'open more options.'
  };
}

/**
 * Predict Grade 12 marks from current grade.
 * For display on tier analysis screen only.
 * NOT used for DB filtering.
 */
function predictGrade12(currentGrade, marks, trend) {
  const years = 12 - parseInt(currentGrade);
  if (years <= 0) return {
    low: marks, high: marks, point: marks, confidence: 'actual'
  };
  const predicted = marks + (trend.delta * years);
  const uncertainty = years * 2;
  return {
    low:  Math.min(Math.max(Math.round(predicted - uncertainty), 40), 99),
    high: Math.min(Math.max(Math.round(predicted + uncertainty), 40), 99),
    point: Math.min(Math.max(Math.round(predicted), 40), 99),
    confidence: years === 1 ? 'high' : years === 2 ? 'medium' : 'low'
  };
}

/**
 * Assign display tiers for the tier analysis screen.
 * For display only — NOT used for DB filtering.
 * Claude determines real eligibility.
 */
function assignTiers(normalizedMarks, grade, trend) {
  const gradeNum = parseInt(String(grade).replace('Grade ', ''));
  const effective = gradeNum === 12
    ? normalizedMarks
    : predictGrade12(gradeNum, normalizedMarks, trend).point;
  return {
    tier1: effective >= 90 ? 'eligible'
      : effective >= 80 ? 'aspirational' : 'not_realistic',
    tier2: effective >= 75 ? 'eligible'
      : effective >= 65 && gradeNum < 12 ? 'aspirational' : 'not_realistic',
    tier3: effective >= 55 ? 'eligible' : 'not_realistic',
    tier4: 'eligible',
    effectiveMarks: effective
  };
}

/**
 * Get reach tag from Claude's eligibility output.
 * Claude decides the tags — we just read them.
 * @param {number} globalTier - university.global_tier (1-4)
 * @param {object} eligibility - studentAnalysis.eligibility
 */
function getReachTag(globalTier, eligibility) {
  if (!eligibility) return 'MATCH';
  return eligibility[`tier${globalTier}_tag`] || null;
}

/**
 * Factual student category determination.
 * NOT intelligence — just passport + residence facts.
 * Passed to Claude as context only.
 */
function determineStudentCategory(passportCountry, countryOfResidence, destinationCountry) {
  const config = getCountryConfig(destinationCountry || passportCountry);

  // Destination has no diaspora rules (default.js or any country
  // config with empty diasporaCountries). Use simple domestic /
  // international split — no NRI or diaspora concepts apply.
  if (config.diasporaCountries.length === 0) {
    const isDomestic = passportCountry === destinationCountry;
    return {
      category: isDomestic ? 'domestic' : 'international',
      label:    isDomestic ? 'Domestic'  : 'International',
      ciwgEligible:  false,
      nriQuota:      false,
      dasaEligible:  false,
      foreignQuota:  !isDomestic,
    };
  }

  // Destination has diaspora rules (e.g. India via india.js).
  // Run full NRI / CIWG logic unchanged.
  const inDiasporaCountry = config.diasporaCountries.includes(countryOfResidence);
  const isIndian = passportCountry === 'India';
  const inIndia  = countryOfResidence === 'India';

  if (isIndian && inIndia) return {
    category: 'domestic',
    dasaEligible: false,
    ciwgEligible: false,
    nriQuota: false,
    foreignQuota: false,
    label: 'Indian Resident'
  };
  if (isIndian && !inIndia) return {
    category: 'diaspora',
    dasaEligible: true,
    ciwgEligible: inDiasporaCountry,
    nriQuota: true,
    foreignQuota: false,
    label: inDiasporaCountry ? 'NRI - Gulf' : 'NRI - Other'
  };
  return {
    category: 'international',
    dasaEligible: true,
    ciwgEligible: false,
    nriQuota: false,
    foreignQuota: true,
    label: 'Foreign National'
  };
}

module.exports = {
  normalizeMarks,
  calculateTrend,
  predictGrade12,
  assignTiers,
  getReachTag,
  determineStudentCategory
};

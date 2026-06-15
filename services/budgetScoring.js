'use strict';

/**
 * Container I — Budget Zone Scoring (V2)
 *
 * Replaces legacy calculateBudgetFit() in scoring.js.
 * Scores universities by zone based on student's
 * min/max budget. Excludes universities outside
 * realistic range.
 *
 * Returns: { score, zone, badge, excluded,
 *            exclusionReason, scholarshipFlag }
 */

// Countries where €0/SEK 0 tuition is genuine (public universities are free)
// When a fee row exists with annual_fee = 0 in these countries,
// it means the university is genuinely tuition-free — not missing data.
// For all other countries, annual_fee = 0 means missing/incomplete data.
// TO ADD A NEW FREE-TUITION COUNTRY: add its exact name as it appears
// in the universities.country DB column to this array.
const FREE_TUITION_COUNTRIES = [
  'Germany',   // Public universities charge €0 tuition (semester fee ~€250-400 only)
  'France',    // Public universities charge €0-€500 (Grandes Écoles charge more)
  'Sweden',    // Free for EU/EEA students; non-EU pay fees (SEK 80K-200K)
  'Norway',    // Free for all students regardless of nationality
];

// Live-updated FX rates (local → USD).
// Seeded with fallback values at startup.
// Updated by updateFxRates() called from server.js.
let FX_RATES_TO_USD = {
  USD: 1.00,
  INR: 0.012,
  EUR: 1.08,
  GBP: 1.27,
  AED: 0.27,
  CAD: 0.74,
  AUD: 0.65,
  SGD: 0.75,
  NZD: 0.60,
  MYR: 0.21,
};

// True when the last FX rate update failed and hardcoded fallback is active.
let fxRatesStale = false;

/**
 * Convert any supported currency to USD.
 * Throws if currency unknown.
 */
function convertToUSD(amount, currency) {
  const rate = FX_RATES_TO_USD[currency];
  if (rate === undefined) {
    console.warn(
      `[budgetScoring] Unknown currency: ${currency} — ` +
      `treating as USD (fee may be inaccurate)`
    );
    return amount; // treat as USD, soft fail
  }
  return amount * rate;
}

/**
 * Called at server startup to refresh FX rates
 * from the live rates service.
 * Non-blocking — fallback rates remain active
 * until this resolves.
 */
async function updateFxRates() {
  try {
    const { getLocalToUSDRates } = require('./fxRates');
    const freshRates = await getLocalToUSDRates();
    Object.assign(FX_RATES_TO_USD, freshRates);
    fxRatesStale = false;
    console.log('[budgetScoring] FX rates updated:', Object.keys(freshRates).join(', '));
  } catch (err) {
    fxRatesStale = true;
    console.warn('[budgetScoring] FX rates stale — using hardcoded fallback');
    console.warn(`[budgetScoring] FX rate update failed: ${err.message} — using fallback`);
  }
}

/**
 * Compute stretch delta based on max budget.
 * Returns absolute USD amount.
 */
function getStretchDelta(maxUSD) {
  if (maxUSD < 10000) return maxUSD * 0.40;
  if (maxUSD < 25000) return maxUSD * 0.30;
  if (maxUSD < 50000) return maxUSD * 0.20;
  return maxUSD * 0.15;
}

/**
 * Main scoring function — replaces calculateBudgetFit.
 *
 * @param {Number} feeUSD - University fee in USD
 * @param {Number} minUSD - Student min budget in USD
 * @param {Number} maxUSD - Student max budget in USD
 * @returns {Object} { score, zone, badge, excluded,
 *                     exclusionReason, scholarshipFlag }
 */
function calculateBudgetFitV2(feeUSD, minUSD, maxUSD, globalTier, destinationCountry = null, coversAll = false) {
  // Free tuition handler — must come before validation
  // feeUSD = 0 is valid ONLY for countries where public universities charge no tuition
  // For all other countries, feeUSD = 0 means missing/incomplete DB data → stays as throw → V1 FALLBACK
  if (typeof feeUSD === 'number' && feeUSD === 0) {
    if (destinationCountry && FREE_TUITION_COUNTRIES.includes(destinationCountry)) {
      return {
        score:           10,
        zone:            'SWEET_SPOT',
        badge:           'Free tuition',
        excluded:        false,
        exclusionReason: null,
        scholarshipFlag: false,
        affordableFlag:  true,
      };
    }
    // Zero fee for non-free-tuition country = missing data
    // Fall through to throw → caught by scoreUniversity → V1 FALLBACK (score=7)
    throw new Error(`Invalid fee: ${feeUSD} — zero fee for non-free-tuition country ${destinationCountry}`);
  }
  // covers_all: student budget exceeds country maximum
  // All universities in this country are affordable
  // Use country range for relative scoring — nothing excluded
  // Score based on position within country range
  // minUSD/maxUSD are already set to country range by deriveCountryBudget
  // so normal zone calculation runs correctly — no special return needed here
  // Validate inputs — these are programmer errors
  if (typeof feeUSD !== 'number' || feeUSD < 0) throw new Error(`Invalid fee: ${feeUSD}`);
  // If minUSD is null, zero, or not provided — treat as no minimum stated
  // Use maxUSD * 0.5 as effective floor so zone thresholds don't collapse
  const effectiveMinUSD = (typeof minUSD === 'number' && minUSD > 0)
    ? minUSD
    : (typeof maxUSD === 'number' && maxUSD > 0 ? maxUSD * 0.5 : null);
  if (effectiveMinUSD === null) throw new Error(`Invalid minBudget: ${minUSD}`);
  if (typeof maxUSD !== 'number' || maxUSD <= 0) {
    throw new Error(`Invalid maxBudget: ${maxUSD}`);
  }

  const sweetSpotCeiling = effectiveMinUSD * 1.2;
  const stretchDelta = getStretchDelta(maxUSD);
  const stretchCeiling = maxUSD + stretchDelta;
  const underdogFloor = effectiveMinUSD / 1.15;

  // EXCLUDED LOW
  if (feeUSD < underdogFloor) {
    return {
      score: 0,
      zone: 'EXCLUDED_LOW',
      badge: null,
      excluded: true,
      exclusionReason: 'below_min',
      scholarshipFlag: false,
      affordableFlag: false
    };
  }

  // UNDERDOG — below min but within 15% of min
  // Only for Tier 1/2/3 — lower tiers excluded as too cheap
  if (feeUSD < effectiveMinUSD) {
    if (!globalTier || globalTier >= 4) {
      return {
        score: 0,
        zone: 'EXCLUDED_LOW',
        badge: null,
        excluded: true,
        exclusionReason: 'below_min',
        scholarshipFlag: false,
        affordableFlag: false
      };
    }
    return {
      score: 6,
      zone: 'UNDERDOG',
      badge: 'Relevant option below your range',
      excluded: false,
      exclusionReason: null,
      scholarshipFlag: false,
      affordableFlag: true
    };
  }

  // EXCLUDED HIGH
  if (feeUSD > stretchCeiling) {
    return {
      score: 0,
      zone: 'EXCLUDED_HIGH',
      badge: null,
      excluded: true,
      exclusionReason: 'above_stretch',
      scholarshipFlag: false
    };
  }

  // SWEET SPOT
  if (feeUSD <= sweetSpotCeiling) {
    return {
      score: 10,
      zone: 'SWEET_SPOT',
      badge: 'Comfortably within budget',
      excluded: false,
      exclusionReason: null,
      scholarshipFlag: false
    };
  }

  // IN-RANGE
  if (feeUSD <= maxUSD) {
    return {
      score: 8,
      zone: 'IN_RANGE',
      badge: 'Within your budget',
      excluded: false,
      exclusionReason: null,
      scholarshipFlag: false
    };
  }

  // STRETCH (fee > max but <= stretchCeiling)
  return {
    score: 5,
    zone: 'STRETCH',
    badge: 'Above max — scholarship needed',
    excluded: false,
    exclusionReason: null,
    scholarshipFlag: true
  };
}

module.exports = {
  calculateBudgetFitV2,
  convertToUSD,
  getStretchDelta,
  updateFxRates,
  FX_RATES_TO_USD,
  fxRatesStale,
};

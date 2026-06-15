'use strict';

/**
 * Container P — Per-country budget window
 *
 * Translates a student's USD budget into a per-country tuition window.
 *
 * THREE CASES:
 *   covers_all : studentMax > countryMax
 *     → Use country range (countryMin–countryMax) as window
 *     → Student can afford everything — no exclusions
 *     → Relative scoring preserved within country range
 *
 *   in_range   : studentMax within countryMin–countryMax
 *     → Use student's actual budget (studentMin–studentMax) as window
 *     → Normal zone filtering applies
 *
 *   below_min  : studentMax < countryMin
 *     → Use student's actual budget as window
 *     → Budget fallback chain handles thin results
 *
 * TO ADD A NEW COUNTRY: add config file in country-config/
 * and register it in country-config/index.js
 * Required fields: minUSD, maxUSD, currency, currencyRate
 */

const countryConfigs = require('../data/country-config');

function getCountryRange(country) {
  const config = countryConfigs[country];
  if (!config || config.minUSD == null || config.maxUSD == null) {
    return null;
  }
  return {
    minUSD:       config.minUSD,
    maxUSD:       config.maxUSD,
    currency:     config.currency     || 'USD',
    currencyRate: config.currencyRate || 1.0,
  };
}

function deriveCountryBudget(studentMinUSD, studentMaxUSD, country) {
  const range = getCountryRange(country);

  // Unknown country — direct passthrough
  if (!range) {
    console.warn(`[budgetMapping] No config for country: ${country} — using direct passthrough`);
    return {
      minUSD:       studentMinUSD || 0,
      maxUSD:       studentMaxUSD || 0,
      minLocal:     studentMinUSD || 0,
      maxLocal:     studentMaxUSD || 0,
      currency:     'USD',
      budgetStatus: 'in_range',
      warning:      `No fee data for ${country}. Budget applied directly.`,
    };
  }

  const { minUSD: countryMin, maxUSD: countryMax, currency, currencyRate } = range;

  let effectiveMinUSD;
  let effectiveMaxUSD;
  let budgetStatus;
  let badge = null;

  // Case 1 — covers_all: student budget exceeds country maximum
  if (studentMaxUSD > countryMax) {
    effectiveMinUSD = countryMin;
    effectiveMaxUSD = countryMax;
    budgetStatus    = 'covers_all';
    badge           = `Your budget covers all programmes in ${country}`;
    console.log(
      `[budgetMapping] ${country}: covers_all`,
      `studentMax=$${studentMaxUSD} > countryMax=$${countryMax}`,
      `→ using country range $${countryMin}–$${countryMax}`
    );
  }
  // Case 2 — in_range: student budget within country range
  else if (studentMaxUSD >= countryMin) {
    effectiveMinUSD = studentMinUSD != null ? studentMinUSD : countryMin;
    effectiveMaxUSD = studentMaxUSD;
    budgetStatus    = 'in_range';
    console.log(
      `[budgetMapping] ${country}: in_range`,
      `$${effectiveMinUSD}–$${effectiveMaxUSD}`
    );
  }
  // Case 3 — below_min: student budget below country minimum
  else {
    effectiveMinUSD = studentMinUSD != null ? studentMinUSD : 0;
    effectiveMaxUSD = studentMaxUSD;
    budgetStatus    = 'below_min';
    console.log(
      `[budgetMapping] ${country}: below_min`,
      `studentMax=$${studentMaxUSD} < countryMin=$${countryMin}`
    );
  }

  // Convert to local currency
  const effectiveMinLocal = Math.round(effectiveMinUSD / currencyRate);
  const effectiveMaxLocal = Math.round(effectiveMaxUSD / currencyRate);

  return {
    minUSD:       effectiveMinUSD,
    maxUSD:       effectiveMaxUSD,
    minLocal:     effectiveMinLocal,
    maxLocal:     effectiveMaxLocal,
    currency,
    budgetStatus,
    badge,
    warning:      budgetStatus === 'below_min'
      ? `Your budget may be below typical fees in ${country}`
      : null,
  };
}

module.exports = { deriveCountryBudget };

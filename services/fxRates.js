'use strict';

/**
 * FX Rates Service
 *
 * Fetches live rates from Open Exchange Rates (OXR).
 * 24-hour in-memory cache. Falls back to hardcoded
 * rates on any network/API failure.
 *
 * OXR returns rates as USD → local (e.g. USD=1, GBP=0.79).
 * getLocalToUSDRates() inverts them for budgetScoring.
 */

const OXR_APP_ID = process.env.OPEN_EXCHANGE_APP_ID;
const OXR_URL = `https://openexchangerates.org/api/latest.json?app_id=${OXR_APP_ID}&base=USD`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let ratesCache = null; // { rates: {USD:1, GBP:0.79,...}, fetchedAt: Date }

// Single source of truth for country → ISO currency code.
// Used by analyze.js (via COUNTRY_CURRENCY export) and
// getCurrencyForCountry(). Add new countries here only.
const COUNTRY_CURRENCY = {
  'India':                  'INR',
  'United Kingdom':         'GBP',
  'Germany':                'EUR',
  'France':                 'EUR',
  'Netherlands':            'EUR',
  'Ireland':                'EUR',
  'United States':          'USD',
  'USA':                    'USD',
  'UAE':                    'AED',
  'United Arab Emirates':   'AED',
  'Canada':                 'CAD',
  'Australia':              'AUD',
  'Singapore':              'SGD',
  'New Zealand':            'NZD',
  'Malaysia':               'MYR',
};

function getFallbackRates() {
  // USD → local (OXR format)
  return {
    USD: 1.00,
    GBP: 0.79,
    EUR: 0.92,
    INR: 83.50,
    AED: 3.67,
    CAD: 1.36,
    AUD: 1.53,
    SGD: 1.34,
    NZD: 1.66,
    MYR: 4.71,
  };
}

async function getFxRates() {
  if (ratesCache && Date.now() - ratesCache.fetchedAt < CACHE_TTL_MS) {
    return ratesCache.rates;
  }

  if (!OXR_APP_ID) {
    console.warn('[fxRates] OPEN_EXCHANGE_APP_ID not set — using fallback rates');
    return getFallbackRates();
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(OXR_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`OXR HTTP ${res.status}`);

    const data = await res.json();
    ratesCache = { rates: data.rates, fetchedAt: Date.now() };
    console.log('[fxRates] Live rates fetched successfully');
    return ratesCache.rates;

  } catch (err) {
    console.warn(`[fxRates] Fetch failed (${err.message}) — using fallback rates`);
    return getFallbackRates();
  }
}

async function convertCurrency(amount, fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return amount;
  const rates = await getFxRates();
  const fromRate = rates[fromCurrency];
  const toRate   = rates[toCurrency];

  if (!fromRate) {
    console.warn(`[fxRates] Unknown fromCurrency: ${fromCurrency} — returning raw amount`);
    return amount;
  }
  if (!toRate) {
    console.warn(`[fxRates] Unknown toCurrency: ${toCurrency} — returning raw amount`);
    return amount;
  }

  return (amount / fromRate) * toRate;
}

function getCurrencyForCountry(country) {
  return COUNTRY_CURRENCY[country] || null;
}

async function getLocalToUSDRates() {
  const rates = await getFxRates();
  const inverted = {};
  for (const [currency, usdToLocal] of Object.entries(rates)) {
    inverted[currency] = usdToLocal > 0 ? 1 / usdToLocal : 0;
  }
  return inverted;
}

module.exports = {
  getFxRates,
  convertCurrency,
  getCurrencyForCountry,
  getLocalToUSDRates,
  getFallbackRates,
  COUNTRY_CURRENCY,
};

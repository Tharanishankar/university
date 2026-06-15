module.exports = {
  currency:         'EUR',
  currencyRate:     1.08,
  diasporaCountries: [],
  // Germany public universities: free (€0)
  // minUSD = 0 because public universities are genuinely free
  // maxUSD = top private/international programme fees
  // TO UPDATE: check DAAD published data annually
  minUSD: 0,
  maxUSD: 2200,
  tuitionPercentiles: { p10:500, p25:800, p50:2000, p75:8000, p90:22000 },
};

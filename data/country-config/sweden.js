module.exports = {
  currency:         'SEK',
  currencyRate:     0.095,     // 1 SEK = $0.095 USD
  diasporaCountries: [],
  // EU students pay nothing. Non-EU: SEK 80K-200K/year
  // minUSD = 0 because EU students are free
  // maxUSD = non-EU p90 equivalent
  // TO UPDATE: check UHR (Swedish Higher Education Authority) data annually
  minUSD: 0,
  maxUSD: 16000,
};

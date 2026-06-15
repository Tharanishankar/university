'use strict';
const express = require('express');
const router  = express.Router();
const { getFxRates } = require('../services/fxRates');

router.get('/', async (req, res) => {
  try {
    const rates = await getFxRates();
    res.json({ success: true, rates, timestamp: Date.now() });
  } catch (err) {
    console.error('[rates] Failed to fetch rates:', err.message);
    res.status(500).json({ success: false, error: 'Could not fetch exchange rates' });
  }
});

module.exports = router;

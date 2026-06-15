const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// GET /api/universities — fetch candidate pool for a student
router.post('/candidate-pool', async (req, res) => {
  try {
    const { aspirationAnalysis, tierEligibility } = req.body;

    const eligibleTiers = [];
    if (tierEligibility.tier1 !== 'not_realistic') eligibleTiers.push(1);
    if (tierEligibility.tier2 !== 'not_realistic') eligibleTiers.push(2);
    eligibleTiers.push(3, 4);

    const { data: universities, error } = await supabase()
      .from('universities')
      .select(`
        id, name, state, city, type, website,
        naac_grade, institution_type, affiliated_to,
        can_apply_directly, apply_through,
        programs (
          id, name, degree_level, field_of_study,
          duration_years, delivery_mode,
          tuition_fees (
            student_category, annual_fee, currency
          ),
          entrance_tests (
            test_name, is_mandatory, min_score
          ),
          admission_requirements (
            subject_group, min_percentage
          )
        )
      `)
      .eq('country', req.query.country || 'India')
      .eq('is_active', true)
      .limit(200);

    if (error) {
      console.error('Supabase query error:', error);
      return res.status(500).json({ error: 'Failed to fetch universities', details: error.message });
    }

    res.json({ universities: universities || [] });
  } catch (err) {
    console.error('Universities route error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

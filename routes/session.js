const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// Generate a session reference like DV-2025-000123
function generateSessionRef() {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 999999).toString().padStart(6, '0');
  return `DV-${year}-${rand}`;
}

// POST /api/session/save — save a completed session
router.post('/save', async (req, res) => {
  try {
    const { studentProfile, lrpResponses, tierAnalysis, recommendations } = req.body;

    const sessionRef = generateSessionRef();

    const { data, error } = await supabase()
      .from('test_sessions')
      .insert({
        session_ref: sessionRef,
        student_profile: studentProfile,
        lrp_responses: lrpResponses,
        tier_analysis: tierAnalysis,
        recommendations: recommendations,
      })
      .select()
      .single();

    if (error) {
      console.error('Session save error:', error);
      return res.status(500).json({ error: 'Failed to save session', details: error.message });
    }

    res.json({ sessionRef, sessionId: data.id });
  } catch (err) {
    console.error('Session route error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /api/session/:ref — retrieve a session by reference
router.get('/:ref', async (req, res) => {
  try {
    const { ref } = req.params;

    const { data, error } = await supabase()
      .from('test_sessions')
      .select('*')
      .eq('session_ref', ref)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ session: data });
  } catch (err) {
    console.error('Session retrieve error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

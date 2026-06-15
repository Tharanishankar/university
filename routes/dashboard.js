// backend/routes/dashboard.js
// Dashboard routes — save runs, load history, save decisions

const express = require('express');
const router  = express.Router();
const supabase = require('../services/supabase');

// ── Helper: build session key from profile ────────────────
function buildSessionKey(name, board, passportCountry) {
  return [name, board, passportCountry]
    .map(s => (s || '').toLowerCase().trim().replace(/\s+/g, '_'))
    .join('-');
}

// ── Helper: get or create session ────────────────────────
async function getOrCreateSession(sessionKey, name, board, passportCountry) {
  const db = supabase();

  // Check existing
  const { data: existing } = await db
    .from('student_sessions')
    .select('id, session_key, run_count:student_runs(count)')
    .eq('session_key', sessionKey)
    .single();

  if (existing) return existing.id;

  // Create new
  const { data: created, error } = await db
    .from('student_sessions')
    .insert({
      session_key:      sessionKey,
      student_name:     name,
      board:            board,
      passport_country: passportCountry,
    })
    .select('id')
    .single();

  if (error) throw new Error('Failed to create session: ' + error.message);
  return created.id;
}

// ─────────────────────────────────────────────────────────
// POST /api/dashboard/save
// Called after analysis completes — saves run + recommendations
// ─────────────────────────────────────────────────────────
router.post('/save', async (req, res) => {
  try {
    const {
      name,
      board,
      passportCountry,
      formInputs,
      recommendations,
      containerAOutput,
    } = req.body;

    if (!name || !board || !passportCountry) {
      return res.status(400).json({ error: 'name, board, passportCountry required' });
    }
    if (!recommendations || !recommendations.length) {
      return res.status(400).json({ error: 'recommendations required' });
    }

    const db = supabase();
    const sessionKey = buildSessionKey(name, board, passportCountry);

    // Get or create session
    const sessionId = await getOrCreateSession(
      sessionKey, name, board, passportCountry
    );

    // Get run number
    const { count } = await db
      .from('student_runs')
      .select('*', { count: 'exact', head: true })
      .eq('session_key', sessionKey);

    const runNumber = (count || 0) + 1;

    // Create run
    const { data: run, error: runError } = await db
      .from('student_runs')
      .insert({
        session_id:          sessionId,
        session_key:         sessionKey,
        run_number:          runNumber,
        form_inputs:         formInputs || null,
        container_a_output:  containerAOutput || null,
      })
      .select('id')
      .single();

    if (runError) throw new Error('Failed to create run: ' + runError.message);

    // Save recommendations
    const recRows = recommendations.map(rec => ({
      run_id:              run.id,
      session_key:         sessionKey,
      university_id:       rec.universityId || null,
      program_id:          rec.programId    || null,
      university_name:     rec.universityName,
      program_name:        rec.programName,
      field_of_study:      rec.fieldOfStudy || null,
      destination_country: rec.destinationCountry || null,
      fit_score:           rec.fitScore    || null,
      tag:                 rec.tag         || null,
      full_rec_json:       rec,
    }));

    const { error: recError } = await db
      .from('student_recommendations')
      .insert(recRows);

    if (recError) throw new Error('Failed to save recommendations: ' + recError.message);

    console.log(
      `[dashboard] saved run ${runNumber} for session ${sessionKey}`,
      `— ${recommendations.length} recs`
    );

    res.json({
      sessionKey,
      sessionId,
      runId:     run.id,
      runNumber,
      saved:     recommendations.length,
    });

  } catch (err) {
    console.error('[dashboard] save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/dashboard/:sessionKey
// Load all runs and recommendations for a session
// ─────────────────────────────────────────────────────────
router.get('/:sessionKey', async (req, res) => {
  try {
    const { sessionKey } = req.params;
    const db = supabase();

    // Get all runs
    const { data: runs, error: runsError } = await db
      .from('student_runs')
      .select('id, run_number, created_at, form_inputs')
      .eq('session_key', sessionKey)
      .order('run_number', { ascending: true });

    if (runsError) throw new Error(runsError.message);
    if (!runs || !runs.length) {
      return res.json({ sessionKey, runs: [] });
    }

    // Get all recommendations for all runs
    const runIds = runs.map(r => r.id);
    const { data: recs, error: recsError } = await db
      .from('student_recommendations')
      .select('id, run_id, university_name, program_name, destination_country, fit_score, tag, full_rec_json')
      .in('run_id', runIds)
      .order('fit_score', { ascending: false });

    if (recsError) throw new Error(recsError.message);

    // Get all decisions for this session
    const { data: decisions } = await db
      .from('student_decisions')
      .select('recommendation_id, uni_decision, program_decision, university_id, field_of_study')
      .eq('session_key', sessionKey);

    // Build decision map
    const decisionMap = {};
    (decisions || []).forEach(d => {
      decisionMap[d.recommendation_id] = {
        uniDecision:     d.uni_decision,
        programDecision: d.program_decision,
      };
    });

    // Group recs by run
    const recsByRun = {};
    (recs || []).forEach(rec => {
      if (!recsByRun[rec.run_id]) recsByRun[rec.run_id] = [];
      recsByRun[rec.run_id].push({
        ...rec,
        decision: decisionMap[rec.id] || null,
      });
    });

    // Assemble response
    const result = runs.map(run => ({
      runId:      run.id,
      runNumber:  run.run_number,
      createdAt:  run.created_at,
      formInputs: run.form_inputs,
      recs:       recsByRun[run.id] || [],
    }));

    res.json({ sessionKey, runs: result });

  } catch (err) {
    console.error('[dashboard] load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/dashboard/decision
// Save accept/reject decision for one recommendation
// ─────────────────────────────────────────────────────────
router.post('/decision', async (req, res) => {
  try {
    const {
      sessionKey,
      recommendationId,
      universityId,
      programId,
      fieldOfStudy,
      uniDecision,
      programDecision,
    } = req.body;

    if (!sessionKey || !recommendationId) {
      return res.status(400).json({ error: 'sessionKey and recommendationId required' });
    }
    if (!uniDecision || !programDecision) {
      return res.status(400).json({ error: 'uniDecision and programDecision required' });
    }

    const db = supabase();

    // Upsert decision
    const { error } = await db
      .from('student_decisions')
      .upsert({
        session_key:       sessionKey,
        recommendation_id: recommendationId,
        university_id:     universityId || null,
        program_id:        programId    || null,
        field_of_study:    fieldOfStudy || null,
        uni_decision:      uniDecision,
        program_decision:  programDecision,
      }, { onConflict: 'recommendation_id' });

    if (error) throw new Error(error.message);

    res.json({ saved: true, recommendationId, uniDecision, programDecision });

  } catch (err) {
    console.error('[dashboard] decision error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

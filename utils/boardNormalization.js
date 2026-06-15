'use strict';

/**
 * boardNormalization.js — Board-specific marks normalisation
 *
 * Converts raw input from any school board / curriculum to a
 * normalised 0-100 score for use in scoring.js academic fit
 * calculation and Container M eligibility evaluation.
 *
 * Design rules:
 *   - 23 ordered rules — first match wins
 *   - Returns null normalized_score only when conversion is impossible
 *   - Never invents scores — returns low confidence when uncertain
 *   - Percentage boards: passthrough (clamped 0-100)
 *   - Grade boards: midpoint of grade band
 *   - Points boards: linear scale to 0-100
 *
 * Usage:
 *   const { normalizeBoard } = require('../utils/boardNormalization');
 *   const result = normalizeBoard('85', 'CBSE', 'Grade 12');
 *   // → { normalized_score: 85, input_mode: 'percentage', ... }
 */

// ── Grade lookup tables ──────────────────────────────────────────────────────

/** Cambridge A-Level / BTEC: grade → percentage midpoint */
const A_LEVEL_MAP = {
  'A*': 95, 'A': 88, 'B': 78, 'C': 68, 'D': 58, 'E': 48, 'U': 0,
  'D*': 95, 'M': 65, 'P': 50
};

/** Cambridge IGCSE / O-Level letter grades */
const O_LEVEL_LETTER_MAP = {
  'A*': 95, 'A': 88, 'B': 78, 'C': 68, 'D': 58,
  'E': 48, 'F': 38, 'G': 28, 'U': 0
};

/** Cambridge IGCSE numeric grades (9-1 scale, introduced 2017) */
const IGCSE_NUMERIC_MAP = {
  '9': 97, '8': 91, '7': 85, '6': 78,
  '5': 70, '4': 62, '3': 52, '2': 42, '1': 30
};

/** IB Diploma subject grades (7-point scale) */
const IB_SUBJECT_MAP = {
  '7': 97, '6': 87, '5': 77, '4': 67,
  '3': 57, '2': 45, '1': 30
};

/**
 * French Baccalauréat (0-20) → percentage.
 * Linear: (score / 20) × 100. Passing = 10 (50%).
 */
const BAC_SCORE_MAP = {
  '20': 100, '19': 95, '18': 90, '17': 85, '16': 80,
  '15': 75, '14': 70, '13': 65, '12': 60, '11': 55,
  '10': 50, '9': 45, '8': 40, '7': 35, '6': 30,
  '5': 25, '4': 20, '3': 15, '2': 10, '1': 5, '0': 0
};

/** Sri Lanka A-Level: A*, A, B, C, S (subsidiary pass), F */
const SRI_LANKA_GRADE_MAP = {
  'A*': 95, 'A': 90, 'B': 80, 'C': 70, 'S': 55, 'F': 0
};

/** US/Canada letter grade → percentage midpoint */
const US_LETTER_MAP = {
  'A+': 98, 'A': 95, 'A-': 92,
  'B+': 88, 'B': 85, 'B-': 82,
  'C+': 78, 'C': 75, 'C-': 72,
  'D+': 68, 'D': 65, 'D-': 62,
  'F': 30
};

// ── Helper: convert multi-subject letter grade string ────────────────────────

/**
 * Converts a string of letter grades (e.g. "A*AB", "AAB", "A+B+C+")
 * to a percentage average using the supplied gradeMap.
 *
 * Greedy longest-match: sorts map keys by length descending so that
 * "A*" is always matched before "A", "A+" before "A", etc.
 *
 * @param {string} input     - raw grade string, e.g. "A*AB" or "AAB"
 * @param {Object} gradeMap  - lookup table: grade string → numeric value
 * @returns {{ avg: number|null, count: number, grades: string[] }}
 */
function convertLetterGrades(input, gradeMap) {
  if (!input || typeof input !== 'string') {
    return { avg: null, count: 0, grades: [] };
  }

  // Sort keys longest-first for greedy match
  const keys = Object.keys(gradeMap).sort((a, b) => b.length - a.length);

  const grades = [];
  let remaining = input.toUpperCase().replace(/\s+/g, '');

  while (remaining.length > 0) {
    let matched = false;
    for (const key of keys) {
      if (remaining.startsWith(key)) {
        grades.push(key);
        remaining = remaining.slice(key.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Skip unrecognised character (separators, commas, etc.)
      remaining = remaining.slice(1);
    }
  }

  if (grades.length === 0) return { avg: null, count: 0, grades: [] };

  const values = grades.map(g => gradeMap[g]).filter(v => v != null);
  if (values.length === 0) return { avg: null, count: 0, grades };

  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return { avg, count: grades.length, grades };
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Normalise raw marks from any board to a 0-100 score.
 *
 * @param {string|number|null} marks      - raw student input (overall score field)
 * @param {string|null}        board      - board name as typed in the form
 * @param {string|null}        gradeLevel - "Grade 10", "Grade 11", "Grade 12", etc.
 *
 * @returns {{
 *   normalized_score:      number|null,
 *   native_value:          string|number|null,
 *   input_mode:            string,
 *   is_rank_based:         boolean,
 *   qualification_level:   'final'|'lower_secondary'|'supplementary'|'unknown',
 *   conversion_confidence: 'high'|'medium'|'low',
 *   flag:                  string|null
 * }}
 */
function normalizeBoard(marks, board, gradeLevel) {
  const NULL_RESULT = {
    normalized_score:      null,
    native_value:          null,
    input_mode:            'unknown',
    is_rank_based:         false,
    qualification_level:   'unknown',
    conversion_confidence: 'low',
    flag:                  null
  };

  // Guard — no marks provided
  if (marks === null || marks === undefined || marks === '') {
    return { ...NULL_RESULT, flag: 'no_marks_provided' };
  }

  const raw      = String(marks).trim();
  const b        = String(board || '').toLowerCase().trim();
  const gradeNum = gradeLevel
    ? parseInt(String(gradeLevel).replace(/\D/g, ''), 10)
    : null;

  const isLowerSecondary = gradeNum !== null && gradeNum <= 10;
  const qualLevel        = isLowerSecondary ? 'lower_secondary' : 'final';

  // ── RULE 1: CBSE ──────────────────────────────────────────────────────────
  // India national board. Reports aggregate percentage 0-100, OR CGPA 0-10.
  // CGPA × 9.5 = approximate percentage (official CBSE conversion formula).
  if (b.includes('cbse')) {
    const val = parseFloat(raw);
    if (isNaN(val)) return { ...NULL_RESULT, flag: 'cbse_invalid_input' };
    // CGPA 0-10 scale
    if (val <= 10) {
      return {
        normalized_score:      Math.min(100, Math.max(0, Math.round(val * 9.5))),
        native_value:          val,
        input_mode:            'cgpa_cbse',
        is_rank_based:         false,
        qualification_level:   qualLevel,
        conversion_confidence: 'high',
        flag:                  null
      };
    }
    // Percentage 0-100
    return {
      normalized_score:      Math.min(100, Math.max(0, Math.round(val))),
      native_value:          val,
      input_mode:            'percentage',
      is_rank_based:         false,
      qualification_level:   qualLevel,
      conversion_confidence: 'high',
      flag:                  null
    };
  }

  // ── RULE 2: ICSE / ISC ────────────────────────────────────────────────────
  // Council for the Indian School Certificate Examinations.
  // Reports percentage 0-100.
  if (b.includes('icse') || b.includes('isc')) {
    const pct = parseFloat(raw);
    if (isNaN(pct)) return { ...NULL_RESULT, flag: 'icse_invalid_input' };
    return {
      normalized_score:      Math.min(100, Math.max(0, Math.round(pct))),
      native_value:          pct,
      input_mode:            'percentage',
      is_rank_based:         false,
      qualification_level:   qualLevel,
      conversion_confidence: 'high',
      flag:                  null
    };
  }

  // ── RULE 3: Indian State Boards ───────────────────────────────────────────
  // All state boards report aggregate percentage 0-100.
  if (
    b.includes('state board') ||
    b.includes('maharashtra')  ||
    b.includes('karnataka')    ||
    b.includes('tamil nadu')   ||
    b.includes('kerala')       ||
    b.includes('telangana')    ||
    b.includes('andhra')       ||
    b.includes('rajasthan')    ||
    b.includes('up board')     ||
    b.includes('mp board')     ||
    b.includes('gujarat')      ||
    b.includes('west bengal')  ||
    b.includes('punjab')       ||
    b.includes('haryana')      ||
    b.includes('bihar')        ||
    b.includes('indian state') ||
    b.includes('hbse')         ||
    b.includes('rbse')         ||
    b.includes('bseb')         ||
    b.includes('mpbse')
  ) {
    const pct = parseFloat(raw);
    if (isNaN(pct)) return { ...NULL_RESULT, flag: 'indian_state_invalid_input' };
    return {
      normalized_score:      Math.min(100, Math.max(0, Math.round(pct))),
      native_value:          pct,
      input_mode:            'percentage',
      is_rank_based:         false,
      qualification_level:   qualLevel,
      conversion_confidence: 'high',
      flag:                  null
    };
  }

  // ── RULE 4: IB Diploma ────────────────────────────────────────────────────
  // Total points 0-45. Minimum for diploma = 24.
  // Individual subject entry (1-7) also handled as fallback.
  if (b.includes('ib diploma') || b.includes('international baccalaureate') ||
      (b === 'ib') || b.includes('ib - dp')) {
    const pts = parseFloat(raw);
    if (!isNaN(pts) && pts >= 0 && pts <= 45) {
      return {
        normalized_score:      Math.round((pts / 45) * 100),
        native_value:          pts,
        input_mode:            'ib_points',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: pts < 24 ? 'low' : 'high',
        flag:                  pts < 24 ? 'below_ib_passing_threshold' : null
      };
    }
    // Fallback: student entered a subject grade (1-7)
    const { avg } = convertLetterGrades(raw, IB_SUBJECT_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'ib_grade',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  'ib_subject_grade_not_total_points'
      };
    }
    return { ...NULL_RESULT, flag: 'ib_unparseable' };
  }

  // ── RULE 5: Cambridge A-Levels ────────────────────────────────────────────
  // Final qualification. Grades A*-U per subject.
  // Student may enter one ("A") or multiple ("A*AB", "AAB").
  if (
    b.includes('a-level') ||
    b.includes('a level')  ||
    b === 'cambridge a-levels' ||
    b.includes('cambridge international a')
  ) {
    // Check if student entered a direct percentage equivalent
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct <= 100) {
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   qualLevel,
        conversion_confidence: 'medium',
        flag:                  'a_level_percentage_direct'
      };
    }
    // Letter grade(s)
    const { avg, count } = convertLetterGrades(raw, A_LEVEL_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   qualLevel,
        conversion_confidence: count >= 2 ? 'high' : 'medium',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'a_level_unparseable' };
  }

  // ── RULE 6: Cambridge AS-Level ────────────────────────────────────────────
  // Supplementary — halfway to A-Level, not a complete final qualification.
  if (
    b.includes('as-level') ||
    b.includes('as level') ||
    b.includes('cambridge as')
  ) {
    const { avg } = convertLetterGrades(raw, A_LEVEL_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'supplementary',
        conversion_confidence: 'medium',
        flag:                  'as_level_supplementary_only'
      };
    }
    const pct = parseFloat(raw);
    if (!isNaN(pct)) {
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   'supplementary',
        conversion_confidence: 'medium',
        flag:                  'as_level_supplementary_only'
      };
    }
    return { ...NULL_RESULT, flag: 'as_level_unparseable' };
  }

  // ── RULE 7: Cambridge IGCSE / O-Level / GCSE ─────────────────────────────
  // Lower secondary. Grades A*-G (old) or 9-1 (new).
  if (
    b.includes('igcse')    ||
    b.includes('o-level')  ||
    b.includes('o level')  ||
    b.includes('cambridge o') ||
    b.includes('gcse')
  ) {
    const numVal = parseFloat(raw);
    if (!isNaN(numVal)) {
      // Numeric 9-1 format — integer in the 1-9 grade range
      if (Number.isInteger(numVal) && numVal >= 1 && numVal <= 9) {
        return {
          normalized_score:      IGCSE_NUMERIC_MAP[String(numVal)],
          native_value:          numVal,
          input_mode:            'igcse_numeric',
          is_rank_based:         false,
          qualification_level:   'lower_secondary',
          conversion_confidence: 'high',
          flag:                  null
        };
      }
      // Percentage (PUM or raw %) — values 10-100
      if (numVal > 9 && numVal <= 100) {
        return {
          normalized_score:      Math.round(numVal),
          native_value:          numVal,
          input_mode:            'percentage',
          is_rank_based:         false,
          qualification_level:   'lower_secondary',
          conversion_confidence: 'medium',
          flag:                  null
        };
      }
    }
    // Letter grade format (single or composite)
    const { avg } = convertLetterGrades(raw, O_LEVEL_LETTER_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'lower_secondary',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'igcse_unparseable' };
  }

  // ── RULE 8: German Abitur ─────────────────────────────────────────────────
  // Reversed scale: 1.0 (best) to 4.0 (worst).
  // Conversion: normalised = Math.round((4.0 - val) / 3.0 * 100)
  // 1.0 → 100%, 1.8 → 73%, 2.5 → 50%, 4.0 → 0%
  if (['german abitur', 'abitur', 'deutsches abitur'].includes(b)) {
    const val = parseFloat(raw);
    if (!isNaN(val) && val >= 1.0 && val <= 4.0) {
      const normalised = Math.round((4.0 - val) / 3.0 * 100);
      return {
        normalized_score:      normalised,
        native_value:          val,
        input_mode:            'grade_point',
        is_rank_based:         false,
        qualification_level:   'secondary',
        conversion_confidence: 'high',
        flag:                  null,
      };
    }
  }

  // ── RULE 9: French Baccalauréat ───────────────────────────────────────────
  // Score 0-20. Passing = 10. Mention bien = 14, très bien = 16.
  if (
    b.includes('baccalaur') ||
    b.includes('french bac') ||
    b.startsWith('bac ')    ||
    b === 'bac'
  ) {
    const score = parseFloat(raw);
    if (!isNaN(score) && score >= 0 && score <= 20) {
      // Try lookup first (exact integer or .0 decimal)
      const key = String(Math.round(score));
      const fromMap = BAC_SCORE_MAP[key];
      return {
        normalized_score:      fromMap !== undefined
          ? fromMap
          : Math.round((score / 20) * 100),
        native_value:          score,
        input_mode:            'bac_score',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'high',
        flag:                  score < 10 ? 'below_bac_passing_threshold' : null
      };
    }
    return { ...NULL_RESULT, flag: 'bac_unparseable' };
  }

  // ── RULE 10: US High School / GPA ─────────────────────────────────────────
  // GPA on 4.0 scale OR percentage 0-100. Letter grade also accepted.
  if (
    b.includes('us high school')       ||
    b.includes('american high school') ||
    b.includes('high school diploma')  ||
    b.includes('gpa')                  ||
    b.includes('common core')          ||
    b.includes('us curriculum')        ||
    b === 'us'
  ) {
    const val = parseFloat(raw);
    if (!isNaN(val)) {
      if (val >= 0 && val <= 5.0) {
        // GPA scale — 4.0 or 5.0
        if (val <= 4.0) {
          return {
            normalized_score:      Math.round((val / 4.0) * 100),
            native_value:          val,
            input_mode:            'gpa_4',
            is_rank_based:         false,
            qualification_level:   'final',
            conversion_confidence: 'medium',
            flag:                  null
          };
        }
        return {
          normalized_score:      Math.round((val / 5.0) * 100),
          native_value:          val,
          input_mode:            'gpa_5',
          is_rank_based:         false,
          qualification_level:   'final',
          conversion_confidence: 'medium',
          flag:                  null
        };
      }
      if (val > 5.0 && val <= 100) {
        // Percentage
        return {
          normalized_score:      Math.round(val),
          native_value:          val,
          input_mode:            'percentage',
          is_rank_based:         false,
          qualification_level:   'final',
          conversion_confidence: 'high',
          flag:                  null
        };
      }
    }
    // Letter grade
    const mapped = US_LETTER_MAP[raw.toUpperCase()];
    if (mapped !== undefined) {
      return {
        normalized_score:      mapped,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'us_unparseable' };
  }

  // ── RULE 11: Australian ATAR ──────────────────────────────────────────────
  // ATAR is a percentile rank 0-99.95 — rank-based.
  // Treat as direct percentile → normalized score with rank flag.
  if (
    b.includes('atar')  ||
    b.includes('vce')   ||
    b.includes('qce')   ||
    b.includes('sace')  ||
    b.includes('wace')  ||
    b.includes('tceas') ||
    (b.includes('australian') && b.includes('hsc'))
  ) {
    const atar = parseFloat(raw);
    if (!isNaN(atar) && atar >= 0 && atar <= 100) {
      return {
        normalized_score:      Math.min(99.95, atar),
        native_value:          atar,
        input_mode:            'atar_percentile',
        is_rank_based:         true,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  'rank_based_score_percentile'
      };
    }
    return { ...NULL_RESULT, flag: 'atar_unparseable' };
  }

  // ── RULE 12: Sri Lanka A-Level ────────────────────────────────────────────
  // Grades: A*, A, B, C, S (subsidiary pass), F — uses SRI_LANKA_GRADE_MAP.
  if (b.includes('sri lanka') || b.includes('a/l') || b.includes('al sri')) {
    const { avg } = convertLetterGrades(raw, SRI_LANKA_GRADE_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    const pct = parseFloat(raw);
    if (!isNaN(pct)) {
      return {
        normalized_score:      Math.min(100, Math.round(pct)),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'sri_lanka_unparseable' };
  }

  // ── RULE 13: Pakistan Matric / Intermediate ───────────────────────────────
  // FBISE and provincial BISE boards. Aggregate percentage 0-100.
  if (
    b.includes('pakistan')  ||
    b.includes('fbise')     ||
    b.includes('bise')      ||
    (b.includes('matric') && (b.includes('pak') || b.includes('board')))
  ) {
    const pct = parseFloat(raw);
    if (!isNaN(pct)) {
      return {
        normalized_score:      Math.min(100, Math.round(pct)),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   qualLevel,
        conversion_confidence: 'high',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'pakistan_unparseable' };
  }

  // ── RULE 14: SPM (Malaysia) ───────────────────────────────────────────────
  // Sijil Pelajaran Malaysia. Form value: "SPM - Malaysia".
  // New system: GPA 0.00-4.00. Old system: A+, A, A-, B+, B, C+, C, D, E, G.
  // b.startsWith('spm') matches all SPM variants from the form datalist.
  if (b.startsWith('spm')) {
    const SPM_GRADE_MAP = {
      'A+': 95, 'A': 90, 'A-': 85,
      'B+': 80, 'B': 75, 'C+': 70,
      'C': 65, 'D': 55, 'E': 45, 'G': 0
    };
    // GPA format (0.00-4.00)
    const gpa = parseFloat(raw);
    if (!isNaN(gpa) && gpa >= 0 && gpa <= 4.0) {
      return {
        normalized_score:      Math.round((gpa / 4.0) * 100),
        native_value:          gpa,
        input_mode:            'spm_gpa',
        is_rank_based:         false,
        qualification_level:   'lower_secondary',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    // Letter grade format
    const { avg } = convertLetterGrades(raw, SPM_GRADE_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'spm_grade',
        is_rank_based:         false,
        qualification_level:   'lower_secondary',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'spm_unparseable' };
  }

  // ── RULE 15: Bangladesh SSC / HSC ────────────────────────────────────────
  // GPA out of 5.00 scale. Some students may enter percentage.
  if (
    b.includes('bangladesh') ||
    (b.includes('ssc') && b.includes('banglad')) ||
    (b.includes('hsc') && b.includes('banglad')) ||
    b.includes('nctb')
  ) {
    const val = parseFloat(raw);
    if (!isNaN(val)) {
      if (val <= 5.0) {
        return {
          normalized_score:      Math.round((val / 5.0) * 100),
          native_value:          val,
          input_mode:            'gpa_5',
          is_rank_based:         false,
          qualification_level:   qualLevel,
          conversion_confidence: 'medium',
          flag:                  null
        };
      }
      if (val <= 100) {
        return {
          normalized_score:      Math.round(val),
          native_value:          val,
          input_mode:            'percentage',
          is_rank_based:         false,
          qualification_level:   qualLevel,
          conversion_confidence: 'high',
          flag:                  null
        };
      }
    }
    return { ...NULL_RESULT, flag: 'bangladesh_unparseable' };
  }

  // ── RULE 16: EmSAT ────────────────────────────────────────────────────────
  // UAE university entrance exam. Per-subject scores 200-2200.
  // NOT a school leaving certificate — cannot be normalised to 0-100.
  // Returns null score with supplementary flag so Claude handles manually.
  if (b.includes('emsat') || b.includes('em sat')) {
    return {
      normalized_score:      null,
      native_value:          raw,
      input_mode:            'emsat',
      is_rank_based:         false,
      qualification_level:   'supplementary',
      conversion_confidence: 'low',
      flag:                  'emsat_not_a_leaving_certificate'
    };
  }

  // ── RULE 17: UAE / Gulf Ministry Curriculum ───────────────────────────────
  // UAE MoE and Gulf national curricula. Percentage 0-100.
  if (
    b.includes('uae')      ||
    b.includes('emirates') ||
    b.includes('gulf')     ||
    b.includes('kuwait')   ||
    b.includes('bahrain')  ||
    b.includes('oman')     ||
    (b.includes('qatar') && !b.includes('university'))
  ) {
    const pct = parseFloat(raw);
    if (!isNaN(pct)) {
      return {
        normalized_score:      Math.min(100, Math.round(pct)),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   qualLevel,
        conversion_confidence: 'high',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'gulf_unparseable' };
  }

  // ── RULE 17: WAEC / WASSCE / NECO ────────────────────────────────────────
  // West African Examinations Council and equivalents.
  // Grades A1 (best) through F9. Also accepts raw percentage.
  if (b.includes('waec') || b.includes('wassce') || b.includes('neco')) {
    const WAEC_GRADE_MAP = {
      'A1': 95, 'B2': 85, 'B3': 80,
      'C4': 70, 'C5': 65, 'C6': 60,
      'D7': 50, 'E8': 40, 'F9': 0
    };
    const necoFlag = b.includes('neco')
      ? 'NECO is widely recognised in Nigeria. Some international universities prefer WAEC. Verify acceptance with target university.'
      : null;
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  necoFlag
      };
    }
    const { avg } = convertLetterGrades(raw, WAEC_GRADE_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  necoFlag
      };
    }
    return { ...NULL_RESULT, flag: 'waec_unparseable' };
  }

  // ── RULE 18: KCSE Kenya ───────────────────────────────────────────────────
  // Kenya Certificate of Secondary Education.
  // Overall letter grade A–E or mean score 0–12.
  if (b.includes('kcse')) {
    const KCSE_GRADE_MAP = {
      'A': 95, 'A-': 90, 'B+': 85,
      'B': 80, 'B-': 75, 'C+': 70,
      'C': 65, 'C-': 60, 'D+': 55,
      'D': 50, 'D-': 45, 'E': 40
    };
    const kcseFlag = 'UK universities often require foundation year for KCSE applicants to competitive programmes.';
    const pct = parseFloat(raw);
    if (!isNaN(pct)) {
      if (pct <= 12) {
        return {
          normalized_score:      Math.round((pct / 12) * 100),
          native_value:          pct,
          input_mode:            'kcse_mean_score',
          is_rank_based:         false,
          qualification_level:   'final',
          conversion_confidence: 'medium',
          flag:                  kcseFlag
        };
      }
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  kcseFlag
      };
    }
    const { avg } = convertLetterGrades(raw, KCSE_GRADE_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  kcseFlag
      };
    }
    return { ...NULL_RESULT, flag: 'kcse_unparseable' };
  }

  // ── RULE 19: ACSEE Tanzania ───────────────────────────────────────────────
  // Advanced Certificate of Secondary Education Examination.
  // Grades A, B, C, D, E, S (subsidiary), F.
  if (b.includes('acsee')) {
    const ACSEE_GRADE_MAP = {
      'A': 90, 'B': 80, 'C': 70,
      'D': 60, 'E': 50, 'S': 40, 'F': 0
    };
    // Division format: "Division I" / "Division II" / "Division III" / "Division IV" / "Division 0"
    // Tanzania ACSEE overall division (aggregate points, lower = better → map to score band)
    const ACSEE_DIVISION_MAP = {
      'DIVISION I': 88, 'DIV I': 88, 'DIV. I': 88,
      'DIVISION II': 70, 'DIV II': 70, 'DIV. II': 70,
      'DIVISION III': 55, 'DIV III': 55, 'DIV. III': 55,
      'DIVISION IV': 40, 'DIV IV': 40, 'DIV. IV': 40,
      'DIVISION 0': 0,  'DIV 0': 0,  'DIV. 0': 0
    };
    const rawNorm = raw.toUpperCase().replace(/\s+/g, ' ').trim();
    const divScore = ACSEE_DIVISION_MAP[rawNorm];
    if (divScore !== undefined) {
      return {
        normalized_score:      divScore,
        native_value:          raw,
        input_mode:            'division',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    const { avg } = convertLetterGrades(raw, ACSEE_GRADE_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   'final',
        conversion_confidence: 'medium',
        flag:                  null
      };
    }
    return { ...NULL_RESULT, flag: 'acsee_unparseable' };
  }

  // ── RULE 20: ZIMSEC Zimbabwe ──────────────────────────────────────────────
  // Zimbabwe School Examinations Council.
  // O-Level (Grade ≤10) or A-Level (final). Grades A, B, C, D, E, U.
  if (b.includes('zimsec')) {
    const ZIMSEC_GRADE_MAP = {
      'A': 90, 'B': 80, 'C': 70,
      'D': 60, 'E': 50, 'U': 0
    };
    const isOLevel   = gradeNum !== null && gradeNum <= 10;
    const zimsecQual = isOLevel ? 'lower_secondary' : 'final';
    const zimsecFlag = isOLevel
      ? 'ZIMSEC O-Level is Grade 10. A-Level needed for university entry.'
      : null;
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   zimsecQual,
        conversion_confidence: 'medium',
        flag:                  zimsecFlag
      };
    }
    const { avg } = convertLetterGrades(raw, ZIMSEC_GRADE_MAP);
    if (avg !== null) {
      return {
        normalized_score:      avg,
        native_value:          raw,
        input_mode:            'letter_grade',
        is_rank_based:         false,
        qualification_level:   zimsecQual,
        conversion_confidence: 'medium',
        flag:                  zimsecFlag
      };
    }
    return { ...NULL_RESULT, flag: 'zimsec_unparseable' };
  }

  // ── RULE 21: Generic percentage passthrough ───────────────────────────────
  // Catches boards not listed above (South African NSC, Ethiopian,
  // and any other unlisted board) when student enters a number 0-100.
  // Accepted with low confidence.
  {
    const pct = parseFloat(raw);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      return {
        normalized_score:      Math.round(pct),
        native_value:          pct,
        input_mode:            'percentage',
        is_rank_based:         false,
        qualification_level:   qualLevel,
        conversion_confidence: 'low',
        flag:                  'board_not_recognised_percentage_assumed'
      };
    }
  }

  // ── RULE 22: Unrecognised / unparseable ───────────────────────────────────
  return {
    ...NULL_RESULT,
    native_value: raw,
    flag:         'unrecognised_board_or_format'
  };
}

module.exports = { normalizeBoard };

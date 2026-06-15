const ENTRANCE_EXAM_REQUIREMENTS = {
  institute_of_national_importance: {
    engineering: {
      exam: 'JEE_ADVANCED',
      qualifying: 'JEE_MAIN',
      nri_pathway: 'DASA_CIWG',
      oci_pathway: 'DIRECT_JEE_ADVANCED',
    },
    medicine: {
      exam: 'NEET',
      nri_pathway: 'NEET_NRI_QUOTA',
    },
    law: {
      exam: 'CLAT or AILET',
      nri_pathway: 'CLAT_NRI_QUOTA',
    },
  },
  central_university: {
    general: { exam: 'CUET' },
    engineering: { exam: 'JEE_MAIN or CUET' },
  },
  university: {
    engineering: { exam: 'JEE_MAIN or STATE_CET' },
    medicine: { exam: 'NEET' },
    law: { exam: 'CLAT or STATE_LAW_CET' },
    general: { exam: 'CUET or DIRECT' },
  },
  deemed_university: {
    engineering: { exam: 'OWN_TEST or JEE_MAIN' },
    medicine: { exam: 'NEET' },
    general: { exam: 'OWN_TEST or DIRECT' },
  },
  private: {
    general: { exam: 'OWN_TEST or DIRECT' },
    engineering: { exam: 'OWN_TEST or JEE_MAIN' },
  },
};

// Keys are category codes from determineStudentCategory()
// (domestic / diaspora / international) — not display labels.
// parentInGulf flag in getExamPathway() gates CIWG separately,
// so diaspora gets ciwg_eligible:true and parentInGulf does
// the final check — Gulf and non-Gulf NRI share one entry.
// Note: OCI/PIO resolves to 'diaspora' via resolveNationalityToCategory.
const NRI_QUOTA_ADVANTAGES = {
  domestic: {
    ciwg_eligible: false,
    nri_quota_access: false,
    message: 'General category',
  },
  diaspora: {
    ciwg_eligible: true,      // parentInGulf flag gates CIWG path
    nri_quota_access: true,
    message: 'NRI Quota Access — CIWG Gulf Quota if parent in Gulf',
  },
  international: {
    ciwg_eligible: false,
    nri_quota_access: false,
    message: 'Foreign national — check DASA scheme eligibility',
  },
};

const SUBJECT_PROGRAM_MAP = {
  'Computer Science': {
    required: ['Mathematics'],
    important: ['Physics'],
    optional: ['Chemistry'],
  },
  Engineering: {
    required: ['Mathematics', 'Physics'],
    important: ['Chemistry'],
    optional: [],
  },
  Medicine: {
    required: ['Biology', 'Chemistry', 'Physics'],
    important: [],
    optional: [],
  },
  Law: {
    required: ['English'],
    important: [],
    optional: [],
  },
  Business: {
    required: ['English'],
    important: ['Mathematics'],
    optional: ['Economics'],
  },
  Design: {
    required: ['English'],
    important: [],
    optional: ['Mathematics'],
  },
};

// Resolve any nationality string (old label, new code, or undefined)
// to one of the three category codes used as NRI_QUOTA_ADVANTAGES keys.
// Accepts both legacy label strings and new category codes so the
// call site in scoring.js needs no changes during this transition.
function resolveNationalityToCategory(nationality) {
  if (!nationality) return 'domestic';
  const n = String(nationality).toLowerCase().trim();
  // New category codes — direct match
  if (n === 'domestic')      return 'domestic';
  if (n === 'diaspora')      return 'diaspora';
  if (n === 'international') return 'international';
  // Old category codes — backward compat
  if (n === 'resident_indian') return 'domestic';
  if (n === 'nri' || n === 'foreign_national') return 'diaspora'; // nri old code
  // Old label strings — backward compat
  if (n === 'indian resident') return 'domestic';
  if (n.startsWith('nri ') || n === 'oci/pio') return 'diaspora';
  if (n === 'foreign national') return 'international';
  return 'domestic'; // safe default
}

// Determine exam pathway for a student at a given institution type + program field
function getExamPathway(institutionType, fieldOfStudy, nationality, parentInGulf) {
  const typeKey = (institutionType || '').toLowerCase().replace(/\s+/g, '_');
  const fieldKey = (fieldOfStudy || 'general').toLowerCase();

  const requirements =
    ENTRANCE_EXAM_REQUIREMENTS[typeKey] ||
    ENTRANCE_EXAM_REQUIREMENTS['private'];

  const fieldReq =
    requirements[fieldKey] ||
    requirements['general'] ||
    { exam: 'DIRECT or OWN_TEST' };

  const nriInfo = NRI_QUOTA_ADVANTAGES[resolveNationalityToCategory(nationality)];

  let pathway = 'General';
  let examRequired = fieldReq.exam;

  if (nriInfo.ciwg_eligible && parentInGulf) {
    pathway = 'DASA/CIWG Gulf Quota';
    examRequired = fieldReq.nri_pathway || fieldReq.exam;
  } else if (nriInfo.jee_advanced_direct && fieldKey === 'engineering') {
    pathway = 'OCI — Direct JEE Advanced';
    examRequired = fieldReq.oci_pathway || fieldReq.exam;
  } else if (nriInfo.nri_quota_access) {
    pathway = 'NRI Quota';
    examRequired = fieldReq.nri_pathway || fieldReq.exam;
  }

  return { examRequired, pathway, nriInfo };
}

module.exports = {
  ENTRANCE_EXAM_REQUIREMENTS,
  NRI_QUOTA_ADVANTAGES,
  SUBJECT_PROGRAM_MAP,
  getExamPathway,
};

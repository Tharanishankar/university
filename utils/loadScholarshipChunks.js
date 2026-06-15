// backend/utils/loadScholarshipChunks.js
// Loads scholarship pathway GUIDANCE (for Gemini search context) and structured loan data.
// Completely separate from admission_guide_chunks — zero token impact on existing prompts.

const path = require('path');
const fs   = require('fs');

const GUIDE_PATH = path.join(__dirname, '../data/chunks/scholarship_guide_chunks.json');

let GUIDE = null;

function getGuide() {
  if (!GUIDE) {
    try {
      GUIDE = JSON.parse(fs.readFileSync(GUIDE_PATH, 'utf8'));
    } catch (err) {
      console.error('loadScholarshipChunks: failed to load guide file', err.message);
      GUIDE = { _pathway_guides: {}, _student_loans_by_citizenship: {} };
    }
  }
  return GUIDE;
}

/**
 * Determine which pathway applies for a given passport country within a destination.
 * Returns the pathway key: 'international' | 'home_domestic' | 'eu_eea' | 'nri_diaspora'
 */
function resolvePathway(destinationCountry, passportCountry) {
  if (!passportCountry) return 'international';

  const EU_EEA = ['Germany', 'France', 'Netherlands', 'Sweden', 'Ireland', 'Belgium',
    'Italy', 'Spain', 'Portugal', 'Austria', 'Denmark', 'Finland', 'Norway', 'Iceland',
    'Luxembourg', 'Greece', 'Czech Republic', 'Poland', 'Hungary', 'Romania'];

  // Home student: same country
  if (passportCountry === destinationCountry) return 'home_domestic';

  // UK citizen in UK is home; British-Indian background still home
  if (destinationCountry === 'United Kingdom' && passportCountry === 'United Kingdom') return 'home_domestic';

  // EU/EEA passport in EU destination
  if (EU_EEA.includes(passportCountry) && EU_EEA.includes(destinationCountry)) return 'eu_eea';

  // UK passport in EU country — treat as international post-Brexit
  if (passportCountry === 'United Kingdom' && EU_EEA.includes(destinationCountry)) return 'international';

  return 'international';
}

/**
 * Build a concise text guidance string for Gemini's scholarship search prompt.
 * Combines the resolved pathway with country-specific search tips.
 *
 * @param {string} destinationCountry
 * @param {string} passportCountry
 * @returns {string} - prompt-ready guidance text
 */
function getScholarshipGuide(destinationCountry, passportCountry) {
  const guide = getGuide();
  const countryGuide = guide._pathway_guides?.[destinationCountry];
  if (!countryGuide) return '';

  const pathway = resolvePathway(destinationCountry, passportCountry);
  const pathwayData = countryGuide[pathway] || countryGuide['international'] || {};

  const lines = [
    `Student nationality: ${passportCountry || 'international'} | Destination: ${destinationCountry}`,
    `Applicable scholarship pathway: ${pathway.replace('_', ' ')}`,
  ];

  if (pathwayData.search_tips?.length) {
    lines.push('\nSearch guidance:');
    pathwayData.search_tips.forEach(tip => lines.push(`• ${tip}`));
  }

  if (pathwayData.do_not_mention) {
    lines.push(`\nDo NOT mention: ${pathwayData.do_not_mention}`);
  }

  if (countryGuide.international?.chevening_ineligible_note &&
      pathway === 'international' &&
      passportCountry) {
    lines.push(`\nNote: ${countryGuide.international.chevening_ineligible_note}`);
  }

  if (countryGuide[pathway]?.bond_note) {
    lines.push(`\nImportant: ${countryGuide[pathway].bond_note}`);
  }

  return lines.join('\n');
}

/**
 * Get structured loan options for a passport country (for frontend display).
 *
 * @param {string} passportCountry
 * @returns {Array} - array of lender objects
 */
function getStudentLoans(passportCountry) {
  const guide = getGuide();
  const entry = guide._student_loans_by_citizenship?.[passportCountry];
  if (!entry) return [];
  return {
    intro: entry.intro || '',
    lenders: entry.lenders || [],
  };
}

/**
 * Main export — called from analyze.js for the formData response block.
 * Returns loan data for the passport country (for frontend Funding Options section).
 * Scholarship guidance is fetched per-program via getScholarshipGuide() in Container S.
 *
 * @param {string[]} destinationCountries
 * @param {string}   passportCountry
 * @returns {{ loans: { intro, lenders } }}
 */
function loadScholarshipChunks(destinationCountries = [], passportCountry = null) {
  const loans = passportCountry ? getStudentLoans(passportCountry) : { intro: '', lenders: [] };
  return { loans };
}

module.exports = { loadScholarshipChunks, getScholarshipGuide, getStudentLoans };

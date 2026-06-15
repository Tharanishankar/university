// backend/utils/languageLayer.js
// Language-of-instruction awareness layer.
//
// Rule: English/Bilingual programs fill recommendation slots first (by fitScore).
// Local-language programs (German, French, etc.) fill remaining slots only after
// all English options in the scored pool are exhausted.
//
// Bilingual → English pool (student can attend) but tagged with isBilingual: true
//             so frontend can show a soft info badge.
// Local-language fallback programs → tagged with isLanguageFallback: true
//             so frontend can show language caveat badge + requirement text.

const path = require('path');
const fs   = require('fs');

// Programs in these language values are treated as the English pool.
const ENGLISH_POOL_VALUES = new Set(['English', 'Bilingual', 'null', null, undefined, '']);

function isEnglishPool(lang) {
  return ENGLISH_POOL_VALUES.has(lang);
}

// Load admission guide chunks once.
let _admissionChunks = null;
function getAdmissionChunks() {
  if (!_admissionChunks) {
    try {
      const p = path.join(__dirname, '../data/chunks/admission_guide_chunks.json');
      _admissionChunks = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      _admissionChunks = {};
    }
  }
  return _admissionChunks;
}

// Pattern that identifies a local-language section (not English proficiency).
// Germany: "German-taught programmes", France: "French-taught programmes", etc.
const LOCAL_LANG_SECTION_RE = /\b(German|French|Spanish|Italian|Dutch|Swedish|Japanese|Chinese|Korean|Arabic|Portuguese|Turkish|Hindi)\b.{0,30}(taught|medium|programme|language requirement)/i;

/**
 * Extract the local-language requirement text for a given country.
 * Stops at the "English-taught" line so we don't include IELTS/TOEFL requirements.
 * Returns null if the country has no local-language section (e.g. UK, USA, Australia).
 */
function getLocalLanguageRequirementText(country) {
  const chunks = getAdmissionChunks();
  const chunk  = chunks[country];
  if (!chunk) return null;

  const text = chunk.qualification_recognition || chunk.admission_checklist || '';
  const idx  = text.indexOf('LANGUAGE REQUIREMENTS');
  if (idx < 0) return null;

  let section = text.slice(idx, idx + 900);

  // Stop before the English-taught section — we only want the local language part.
  const enIdx = section.indexOf('English-taught');
  if (enIdx > 0) section = section.slice(0, enIdx);

  // Strip the "LANGUAGE REQUIREMENTS:" header line itself.
  section = section.replace(/^LANGUAGE REQUIREMENTS:?\s*/i, '').trim();

  // Only return if the section actually describes a local (non-English) language requirement.
  if (!LOCAL_LANG_SECTION_RE.test(section)) return null;

  return section.length > 40 ? section : null;
}

/**
 * Determine the dominant non-English language in a set of scored results.
 * Used by buildNoRecNotice to explain why a country has no English results.
 */
function detectLocalLanguage(scoredResults) {
  const counts = {};
  for (const r of scoredResults) {
    const lang = r.languageOfInstruction;
    if (!isEnglishPool(lang)) {
      counts[lang] = (counts[lang] || 0) + 1;
    }
  }
  if (Object.keys(counts).length === 0) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Determine the dominant language in a set of fallback programs.
 * Unlike detectLocalLanguage, this is not filtered — it returns whatever
 * language appears most (English, German, etc.), used for the fallback notice.
 */
function detectFallbackLanguage(fallbackPrograms) {
  const counts = {};
  for (const r of fallbackPrograms) {
    const lang = r.languageOfInstruction || 'English';
    counts[lang] = (counts[lang] || 0) + 1;
  }
  if (Object.keys(counts).length === 0) return null;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Core function. Called after top10 + filteredResults are both available.
 *
 * preferredLanguage: the student's chosen language of instruction (e.g. 'English',
 * 'German', 'French'). Empty string / null / undefined = default to English priority.
 *
 * What it does:
 *  1. Determine primary pool: programs taught in preferredLanguage (or English/Bilingual
 *     if no preference). Bilingual always goes in the preferred-language pool.
 *  2. Fill slots from primary pool first (by fitScore).
 *  3. Fill remaining slots from secondary pool (tagged isLanguageFallback: true).
 *  4. Bilingual programs → tagged isBilingual: true (soft badge only).
 *
 * Returns: { top10, languageFallbackNotice, noRecNotice }
 */
function applyLanguageLayer(top10, filteredResults, destinationCountry, countryFinalSlots, preferredLanguage) {
  // Normalise: treat empty/null as 'English' default
  const preferred = (preferredLanguage || 'English').trim();

  // A program is in the preferred pool if:
  //   - preferred is English → English or Bilingual or null/empty (existing behaviour)
  //   - preferred is X       → X or Bilingual
  function isPreferredPool(lang) {
    if (preferred === 'English') return isEnglishPool(lang);
    return lang === preferred || lang === 'Bilingual';
  }

  // Tag Bilingual programs (always).
  top10 = top10.map(r => {
    if (r.languageOfInstruction === 'Bilingual') {
      return { ...r, isBilingual: true };
    }
    return r;
  });

  // Separate current top10 into preferred and non-preferred.
  const top10Preferred = top10.filter(r => isPreferredPool(r.languageOfInstruction));
  const top10Other     = top10.filter(r => !isPreferredPool(r.languageOfInstruction));

  // Fast path — no non-preferred programs in top10.
  if (top10Other.length === 0) {
    return { top10, languageFallbackNotice: null, noRecNotice: null };
  }

  // Check if there are preferred-language programs in filteredResults not yet in top10.
  const usedIds      = new Set(top10.map(r => r.programId));
  const extraPreferred = filteredResults
    .filter(r => isPreferredPool(r.languageOfInstruction) && !usedIds.has(r.programId))
    .sort((a, b) => b.fitScore - a.fitScore);

  // Swap: replace as many non-preferred programs as possible with preferred extras.
  const swapCount      = Math.min(top10Other.length, extraPreferred.length);
  const swappedIn      = extraPreferred.slice(0, swapCount);
  const remainingOther = top10Other.slice(swapCount).map(r => ({
    ...r,
    isLanguageFallback: true,
  }));

  const finalTop10 = [
    ...top10Preferred,
    ...swappedIn,
    ...remainingOther,
  ];

  // Build notice if any non-preferred programs remain in the final list.
  let languageFallbackNotice = null;
  if (remainingOther.length > 0) {
    const localLang       = detectFallbackLanguage(remainingOther);
    // Only show requirement text if fallback is a non-English language
    const requirementText = isEnglishPool(localLang)
      ? null
      : getLocalLanguageRequirementText(destinationCountry);

    const preferredCount  = finalTop10.length - remainingOther.length;
    const fallbackCount   = remainingOther.length;

    languageFallbackNotice = {
      preferredLanguage: preferred,
      localLanguage:    localLang || 'local language',
      englishCount:     preferredCount,   // kept for frontend compatibility
      localCount:       fallbackCount,
      requirementText,
    };
  }

  return { top10: finalTop10, languageFallbackNotice, noRecNotice: null };
}

/**
 * Build a noRecNotice when a country returns zero recommendations.
 * Called from the country loop when top10 is empty.
 */
function buildNoRecNotice(destinationCountry, scoredResultsAll, preferredLanguage) {
  const preferred = (preferredLanguage || 'English').trim();

  // Detect what language programs DO exist in this country (from pre-budget pool).
  const localLang       = detectLocalLanguage(scoredResultsAll);
  const requirementText = localLang ? getLocalLanguageRequirementText(destinationCountry) : null;

  if (localLang) {
    return {
      localLanguage:    localLang,
      requirementText,
      message: `No ${preferred}-taught programmes were found in ${destinationCountry} ` +
               `matching your field and criteria. Most programmes here are delivered ` +
               `in ${localLang}.` +
               (requirementText
                 ? ` To apply to ${localLang}-medium programmes, you would need to meet the following requirements.`
                 : ''),
    };
  }

  return {
    localLanguage: null,
    requirementText: null,
    message: `No programmes were found in ${destinationCountry} matching your ` +
             `field, tier, and budget criteria.`,
  };
}

module.exports = {
  isEnglishPool,
  applyLanguageLayer,
  buildNoRecNotice,
  detectLocalLanguage,
  detectFallbackLanguage,
  getLocalLanguageRequirementText,
};

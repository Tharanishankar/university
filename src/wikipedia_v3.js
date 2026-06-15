// src/wikipedia_v3.js
import axios from 'axios';
import { logger } from './utils/logger.js';
import { isNonUniversity, getRejectionReason } from './utils/nonUniversityPatterns.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

const WIKI_HEADERS = {
  'User-Agent': 'UniversityDBCrawler/3.0 (https://github.com/sajeedahmed1981/university-db-crawler; sajeedahmed1981@gmail.com)',
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip, deflate',
};

const GERMAN_STATES = [
  'Baden-Württemberg', 'Bavaria', 'Berlin', 'Brandenburg', 'Bremen',
  'Hamburg', 'Hesse', 'Lower Saxony', 'Mecklenburg-Vorpommern',
  'North Rhine-Westphalia', 'Rhineland-Palatinate', 'Saarland',
  'Saxony', 'Saxony-Anhalt', 'Schleswig-Holstein', 'Thuringia',
];

const UK_NATIONS = ['England', 'Scotland', 'Wales', 'Northern Ireland'];

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California',
  'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
  'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri',
  'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
  'District of Columbia'
];

const INDIAN_STATES = [
  // 28 states
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // 8 union territories
  'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Chandigarh',
  'Puducherry', 'Andaman and Nicobar Islands',
  'Dadra and Nagar Haveli', 'Lakshadweep',
];

const CANADIAN_PROVINCES = [
  // 10 provinces
  'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick',
  'Newfoundland and Labrador', 'Nova Scotia', 'Ontario',
  'Prince Edward Island', 'Quebec', 'Saskatchewan',
  // 3 territories
  'Northwest Territories', 'Nunavut', 'Yukon',
];

const AUSTRALIAN_STATES = [
  // 6 states
  'New South Wales', 'Queensland', 'South Australia', 'Tasmania',
  'Victoria', 'Western Australia',
  // 2 internal territories
  'Australian Capital Territory', 'Northern Territory',
];

export function getRegions(country) {
  if (country === 'United Kingdom') return UK_NATIONS;
  if (country === 'USA') return US_STATES;
  if (country === 'India') return INDIAN_STATES;
  if (country === 'Canada') return CANADIAN_PROVINCES;
  if (country === 'Australia') return AUSTRALIAN_STATES;
  return GERMAN_STATES;
}

// Broader keyword list — accepts names without "University" if they sound institutional
const VALID_KEYWORDS_COMMON = [
  'university', 'college', 'institute of', 'school of',
  'academy', 'conservatoire', 'conservatory',
];

const VALID_KEYWORDS_DE = [
  'universität', 'hochschule', 'fachhochschule', 'technische hochschule',
];

// Known standalone institutions that don't contain "university" but are real degree-granters
const KNOWN_VALID_NAMES_DE = [
  'charité', 'esmt berlin', 'hertie school', 'wittenberg', 'witten/herdecke',
  'jacobs university', 'frankfurt school',
];

const KNOWN_VALID_NAMES_UK = [
  'imperial college', 'lse', 'london business school', 'oxford', 'cambridge',
  'royal college', 'soas',
];

const KNOWN_VALID_NAMES_US = [
  'mit', 'caltech', 'stanford', 'harvard', 'yale', 'princeton',
  'columbia', 'dartmouth', 'brown', 'cornell', 'juilliard',
  'berklee', 'babson', 'olin',
];

const KNOWN_VALID_NAMES_IN = [
  'iit ', 'iim ', 'aiims', 'iisc', 'bits pilani', 'isi ',
  'nit ', 'nift', 'iiit', 'iiser', 'nift', 'icfai', 'xlri',
  'isb hyderabad', 'srcc', 'lady shri ram', 'st. stephen',
];

const KNOWN_VALID_NAMES_CA = [
  'mcgill', 'banff centre', 'ivey', 'rotman', 'schulich',
  'desautels', 'oise', 'ocad', 'ryerson', 'tmu ',
  'nscad', 'emily carr', 'sheridan',
];

const KNOWN_VALID_NAMES_AU = [
  'anu', 'unsw', 'rmit', 'qut', 'uts ',
  'monash', 'unimelb', 'sydney', 'tafe ',
  'cqu', 'jcu', 'acu',
];

function isLikelyUniversity(title, country) {
  if (isNonUniversity(title)) return false;

  const lowered = title.toLowerCase();

  // Allow known standalone institutions
  const knownList =
    country === 'Germany'   ? KNOWN_VALID_NAMES_DE :
    country === 'USA'       ? KNOWN_VALID_NAMES_US :
    country === 'India'     ? KNOWN_VALID_NAMES_IN :
    country === 'Canada'    ? KNOWN_VALID_NAMES_CA :
    country === 'Australia' ? KNOWN_VALID_NAMES_AU :
    KNOWN_VALID_NAMES_UK;
  if (knownList.some(kw => lowered.includes(kw))) return true;

  // Must contain at least one institutional keyword
  const validKeywords = country === 'Germany'
    ? [...VALID_KEYWORDS_COMMON, ...VALID_KEYWORDS_DE]
    : VALID_KEYWORDS_COMMON;

  return validKeywords.some(kw => lowered.includes(kw));
}

async function getCategoryMembers(categoryTitle, cmtype = 'page') {
  const members = [];
  let cmcontinue = null;
  do {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${categoryTitle}`,
      cmtype,
      cmlimit: 500,
      format: 'json',
      ...(cmcontinue ? { cmcontinue } : {}),
    };
    try {
      const response = await axios.get(WIKI_API, { params, headers: WIKI_HEADERS, timeout: 15000 });
      await new Promise(r => setTimeout(r, 500));
      const data = response.data;
      members.push(...(data.query?.categorymembers || []));
      cmcontinue = data.continue?.cmcontinue ?? null;
      logger.info('Wikipedia API call complete', {
        category: categoryTitle,
        membersFound: members.length,
      });
    } catch (err) {
      logger.warn('Wikipedia request error', { category: categoryTitle, error: err.message });
      break;
    }
  } while (cmcontinue);
  return members;
}

/**
 * Fetches the first paragraph of a Wikipedia article for city extraction.
 */
async function getPageSummary(title) {
  try {
    const params = {
      action: 'query',
      prop: 'extracts',
      exintro: true,
      explaintext: true,
      titles: title,
      format: 'json',
    };
    const response = await axios.get(WIKI_API, { params, headers: WIKI_HEADERS, timeout: 10000 });
    const pages = response.data.query?.pages || {};
    const firstPage = Object.values(pages)[0];
    return firstPage?.extract || null;
  } catch (err) {
    return null;
  }
}

/**
 * Regex-extracts city from a Wikipedia summary like "located in Berlin, Germany"
 */
function extractCityFromSummary(summary, country) {
  if (!summary) return null;
  const patterns = [
    new RegExp(`in\\s+([A-ZÄÖÜ][a-zA-ZäöüßÄÖÜ\\s\\-]+?),?\\s+${country}`),
    new RegExp(`based in ([A-ZÄÖÜ][a-zA-ZäöüßÄÖÜ\\s\\-]+)`),
    new RegExp(`located in ([A-ZÄÖÜ][a-zA-ZäöüßÄÖÜ\\s\\-]+)`),
  ];
  for (const pattern of patterns) {
    const match = summary.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function getRootCategories(regionName, country) {
  const slug = regionName.replace(/\s+/g, '_');
  if (country === 'Germany') {
    return [
      `Universities_and_colleges_in_${slug}`,
      `Universities_in_${slug}`,
      `Hochschulen_in_${slug}`,
    ];
  }
  if (country === 'India') {
    return [
      `Universities_and_colleges_in_${slug}`,
      `Universities_in_${slug}`,
      `Education_in_${slug}`,
    ];
  }
  if (country === 'USA') {
    return [
      `Universities_and_colleges_in_${slug}`,
      `Colleges_and_universities_in_${slug}`,
    ];
  }
  return [
    `Universities_and_colleges_in_${slug}`,
    `Universities_in_${slug}`,
  ];
}

export async function getUniversitiesFromWikipedia(regionName, country = 'Germany') {
  const seenTitles = new Set();
  const universities = [];
  const rootCategories = getRootCategories(regionName, country);

  let workingCategory = null;
  let rootPages = [];
  let level1Subcats = [];

  for (const cat of rootCategories) {
    const pages = await getCategoryMembers(cat, 'page');
    const subcats = await getCategoryMembers(cat, 'subcat');
    if (pages.length > 0 || subcats.length > 0) {
      workingCategory = cat;
      rootPages = pages;
      level1Subcats = subcats;
      logger.info('Wikipedia category matched', { region: regionName, category: cat, pages: pages.length, subcats: subcats.length });
      break;
    }
  }

  if (!workingCategory) {
    logger.warn('No Wikipedia category found for region', { region: regionName, country });
    return [];
  }

  const allCandidatePages = [...rootPages];

  // Level 1 subcategories
  for (const subcat of level1Subcats) {
    const subcatName = subcat.title.replace(/^Category:/, '');
    if (isNonUniversity(subcatName)) {
      logger.debug('Skipping non-university subcategory', { subcatName });
      continue;
    }
    const subcatPages = await getCategoryMembers(subcatName, 'page');
    allCandidatePages.push(...subcatPages);

    // Level 2 (one more level deep)
    const level2Subcats = await getCategoryMembers(subcatName, 'subcat');
    for (const subcat2 of level2Subcats) {
      const subcat2Name = subcat2.title.replace(/^Category:/, '');
      const subcat2Pages = await getCategoryMembers(subcat2Name, 'page');
      allCandidatePages.push(...subcat2Pages);
    }
  }

  // Filter + enrich each candidate
  let rejectedNoiseCount = 0;
  let rejectedKeywordCount = 0;

  for (const page of allCandidatePages) {
    if (seenTitles.has(page.title)) continue;
    seenTitles.add(page.title);

    if (isNonUniversity(page.title)) {
      rejectedNoiseCount++;
      logger.debug('Rejected at Stage 1 noise filter', {
        title: page.title,
        reason: getRejectionReason(page.title),
      });
      continue;
    }

    if (!isLikelyUniversity(page.title, country)) {
      rejectedKeywordCount++;
      continue;
    }

    // Fetch summary for city + audit trail (rate-limited 200ms between)
    const summary = await getPageSummary(page.title);
    const city = extractCityFromSummary(summary, country);

    universities.push({
      name: page.title,
      state: regionName,
      country,
      city,
      wikipedia_summary: summary?.substring(0, 500) || null,
    });

    await new Promise(r => setTimeout(r, 1000));
  }

  logger.info('Wikipedia v3 found universities', {
    region: regionName,
    country,
    found: universities.length,
    rejectedNoise: rejectedNoiseCount,
    rejectedKeywordMismatch: rejectedKeywordCount,
  });

  return universities;
}

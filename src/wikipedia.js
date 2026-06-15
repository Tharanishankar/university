import axios from 'axios';
import { logger } from './utils/logger.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

const WIKI_HEADERS = {
  'User-Agent': 'UniversityDBCrawler/2.0 (https://github.com/sajeedahmed1981/university-db-crawler; sajeedahmed1981@gmail.com) axios/1.0',
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip, deflate',
};

// Germany — 16 Bundesländer (English names used in Wikipedia categories)
const GERMAN_STATES = [
  'Baden-Württemberg', 'Bavaria', 'Berlin', 'Brandenburg', 'Bremen',
  'Hamburg', 'Hesse', 'Lower Saxony', 'Mecklenburg-Vorpommern',
  'North Rhine-Westphalia', 'Rhineland-Palatinate', 'Saarland',
  'Saxony', 'Saxony-Anhalt', 'Schleswig-Holstein', 'Thuringia',
];

// UK — 4 nations (Wikipedia uses these as top-level regions)
const UK_NATIONS = [
  'England', 'Scotland', 'Wales', 'Northern Ireland',
];

export function getRegions(country) {
  if (country === 'UK') return UK_NATIONS;
  return GERMAN_STATES; // default Germany
}

function isUniversityTitle(title, country) {
  const common = title.includes('University') || title.includes('College');
  if (country === 'Germany') {
    return common ||
      title.includes('Universität') ||
      title.includes('Hochschule') ||
      title.includes('Fachhochschule') ||
      title.includes('Technische Hochschule') ||
      title.includes('Institute of Technology');
  }
  // UK
  return common ||
    title.includes('School of') ||
    title.includes('Institute of') ||
    title.includes('Academy');
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
      const data = response.data;
      members.push(...(data.query?.categorymembers || []));
      cmcontinue = data.continue?.cmcontinue ?? null;
    } catch (err) {
      logger.warn('Wikipedia request error', { category: categoryTitle, error: err.message });
      break;
    }
  } while (cmcontinue);

  return members;
}

// Wikipedia category name patterns differ by country
function getRootCategories(regionName, country) {
  const slug = regionName.replace(/\s+/g, '_');
  if (country === 'Germany') {
    return [
      `Universities_and_colleges_in_${slug}`,
      `Universities_in_${slug}`,
      `Hochschulen_in_${slug}`,
    ];
  }
  // UK
  return [
    `Universities_and_colleges_in_${slug}`,
    `Universities_in_${slug}`,
  ];
}

export async function getUniversitiesFromWikipedia(regionName, country = 'Germany') {
  const seenTitles = new Set();
  const universities = [];

  const rootCategories = getRootCategories(regionName, country);

  // Try each category pattern — use the first that returns results
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
    logger.warn('No Wikipedia category found for region', { region: regionName, country, tried: rootCategories });
    return [];
  }

  // Level 0 — pages directly in root category
  for (const page of rootPages) {
    if (isUniversityTitle(page.title, country) && !seenTitles.has(page.title)) {
      seenTitles.add(page.title);
      universities.push({ name: page.title, state: regionName, country });
    }
  }

  // Level 1 — subcategories of root
  for (const subcat of level1Subcats) {
    const subcatName = subcat.title.replace(/^Category:/, '');
    const subcatPages = await getCategoryMembers(subcatName, 'page');
    for (const page of subcatPages) {
      if (isUniversityTitle(page.title, country) && !seenTitles.has(page.title)) {
        seenTitles.add(page.title);
        universities.push({ name: page.title, state: regionName, country });
      }
    }

    // Level 2 — subcategories of subcategories
    const level2Subcats = await getCategoryMembers(subcatName, 'subcat');
    for (const subcat2 of level2Subcats) {
      const subcat2Name = subcat2.title.replace(/^Category:/, '');
      const subcat2Pages = await getCategoryMembers(subcat2Name, 'page');
      for (const page of subcat2Pages) {
        if (isUniversityTitle(page.title, country) && !seenTitles.has(page.title)) {
          seenTitles.add(page.title);
          universities.push({ name: page.title, state: regionName, country });
        }
      }
    }
  }

  logger.info('Wikipedia found universities', { region: regionName, country, count: universities.length });
  return universities;
}

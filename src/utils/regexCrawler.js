import axios from 'axios';
import https from 'https';
import { logger } from './logger.js';

// Patterns shared across all countries (Bologna-compliant degrees + universal)
const SHARED_PATTERNS = [
  /\b(B\.Sc\.|BSc)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(M\.Sc\.|MSc)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(B\.A\.|BA)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(M\.A\.|MA)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(MBA)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(LLB|LL\.B\.)\s*(?:Hons\.?)?\s*(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)?(?:\s*[-–(]|\s*\n|\s*<)/g,
  /\b(LLM|LL\.M\.)\s*(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)?(?:\s*[-–(]|\s*\n|\s*<)/g,
  /\b(Ph\.D\.|PhD)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
];

// Germany-specific patterns (pre-Bologna + Bologna)
const GERMANY_PATTERNS = [
  ...SHARED_PATTERNS,
  /\b(B\.Eng\.|BEng)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(M\.Eng\.|MEng)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(Diplom)\s+(?:in\s+|[-–]\s*)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(Staatsexamen)\b/g,
  /\b(B\.Mus\.|BMus)\b/g,
  /\b(M\.Mus\.|MMus)\s*(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)?(?:\s*[-–(]|\s*\n|\s*<)/g,
];

// UK-specific patterns
const UK_PATTERNS = [
  ...SHARED_PATTERNS,
  /\b(B\.Eng\.|BEng)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(M\.Eng\.|MEng)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(MBChB)\b/g,
  /\b(BDS)\b/g,
  /\b(B\.Pharm|BPharm)\b/g,
  /\b(B\.Arch|BArch)\b/g,
  /\b(PGDip)\s+(?:in\s+)?([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(Foundation\s+Year)\s+in\s+([A-Z][a-zA-Z\s&()\/]+?)(?:\s*[-–(]|\s*\n|\s*<|\s*,(?!\s*[A-Z]))/g,
  /\b(B\.Mus\.|BMus)\b/g,
];

const DEGREE_CATEGORY = {
  // Shared UG
  'B.Sc.': 'UG', 'BSc': 'UG', 'B.A.': 'UG', 'BA': 'UG',
  'LLB': 'UG', 'LL.B.': 'UG', 'B.Eng.': 'UG', 'BEng': 'UG',
  'MBChB': 'UG', 'BDS': 'UG', 'B.Pharm': 'UG', 'BPharm': 'UG',
  'B.Arch': 'UG', 'BArch': 'UG', 'B.Mus.': 'UG', 'BMus': 'UG',
  'Foundation Year': 'UG',
  // Shared PG
  'M.Sc.': 'PG', 'MSc': 'PG', 'M.A.': 'PG', 'MA': 'PG',
  'MBA': 'PG', 'LLM': 'PG', 'LL.M.': 'PG',
  'M.Eng.': 'PG', 'MEng': 'PG', 'PGDip': 'PG',
  'M.Mus.': 'PG', 'MMus': 'PG',
  // Germany pre-Bologna
  'Diplom': 'PG',
  'Staatsexamen': 'UG',
  // Doctoral
  'Ph.D.': 'PhD', 'PhD': 'PhD',
};

const STANDALONE_DEGREES = new Set([
  'MBChB', 'BDS', 'B.Pharm', 'BPharm', 'B.Arch', 'BArch',
  'B.Mus.', 'BMus', 'M.Mus.', 'MMus', 'Staatsexamen',
]);

const axiosConfig = {
  timeout: 30000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UniversityBot/2.0)' },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 5,
};

function getFieldForDegree(degree) {
  const fields = {
    'MBChB': 'Medicine', 'BDS': 'Dentistry',
    'B.Pharm': 'Pharmacy', 'BPharm': 'Pharmacy',
    'B.Arch': 'Architecture', 'BArch': 'Architecture',
    'B.Mus.': 'Music', 'BMus': 'Music',
    'M.Mus.': 'Music', 'MMus': 'Music',
    'Staatsexamen': 'Law or Medicine or Teaching',
  };
  return fields[degree] || degree;
}

export async function fetchAndExtractPrograms(websiteUrl, country = 'Germany') {
  const programs = new Map();
  const patterns = country === 'UK' ? UK_PATTERNS : GERMANY_PATTERNS;

  const urlsToTry = [
    websiteUrl,
    `${websiteUrl}/programs`,
    `${websiteUrl}/academics`,
    `${websiteUrl}/courses`,
    `${websiteUrl}/departments`,
    `${websiteUrl}/schools`,
    `${websiteUrl}/admissions`,
    `${websiteUrl}/studium`,      // German: "studies"
    `${websiteUrl}/studiengaenge`, // German: "degree programmes"
  ].filter(Boolean);

  for (const url of urlsToTry) {
    try {
      const response = await axios.get(url, axiosConfig);
      const html = response.data;
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const degree = match[1];
          const specialization = match[2]?.trim();

          if (STANDALONE_DEGREES.has(degree)) {
            if (!programs.has(degree)) {
              programs.set(degree, {
                name: degree,
                degree_level: degree,
                field_of_study: getFieldForDegree(degree),
                degree_category: DEGREE_CATEGORY[degree] || 'Other',
              });
            }
          } else if (specialization && specialization.length > 3 && specialization.length < 80) {
            const cleanSpec = specialization.replace(/\s+/g, ' ').trim();
            const key = `${degree}_${cleanSpec.toLowerCase()}`;
            if (!programs.has(key)) {
              programs.set(key, {
                name: `${degree} ${cleanSpec}`,
                degree_level: degree,
                field_of_study: cleanSpec,
                degree_category: DEGREE_CATEGORY[degree] || 'Other',
              });
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return Array.from(programs.values());
}

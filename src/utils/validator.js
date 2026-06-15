import axios from 'axios';
import { logger } from './logger.js';

const axiosConfig = {
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UniversityBot/1.0)' },
  maxRedirects: 5,
  httpsAgent: new (await import('https')).Agent({ rejectUnauthorized: false }),
};

export async function isWebsiteAlive(url) {
  try {
    const response = await axios.get(url, { ...axiosConfig, timeout: 10000 });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

export async function fetchHTML(url) {
  try {
    const response = await axios.get(url, { ...axiosConfig, timeout: 30000 });
    return response.data;
  } catch (error) {
    logger.warn('Failed to fetch HTML', { url, error: error.message });
    return null;
  }
}

export function hasActivePrograms(html) {
  const keywords = [
    'admission', 'program', 'course', 'apply', 'curriculum',
    'undergraduate', 'postgraduate', 'bachelor', 'master', 'phd',
    'b.tech', 'm.tech', 'mba', 'bca', 'mca', 'b.sc', 'm.sc'
  ];
  const lowerHtml = html.toLowerCase();
  return keywords.some(k => lowerHtml.includes(k));
}

const REJECTED_PROGRAM_NAMES = new Set([
  'engineering', 'science', 'arts', 'commerce', 'management',
  'ug courses', 'pg courses', 'under graduate', 'post graduate',
  'ug programs', 'pg programs', 'various', 'multiple',
  'undergraduate', 'postgraduate', 'programs', 'courses',
  'integrated courses', 'professional courses',
  'other', 'others',
]);

export function validateExtractedPrograms(programs) {
  return (programs || []).filter(p => {
    const name = (p.name || '').trim();
    if (name.length < 10) return false;
    if (!name.includes(' ')) return false;
    if (REJECTED_PROGRAM_NAMES.has(name.toLowerCase())) return false;
    const fos = (p.field_of_study || '').toLowerCase();
    if (!p.field_of_study || fos === 'various' || fos === 'multiple') return false;
    return true;
  });
}

export function findPDFLinks(html, baseUrl) {
  const pdfRegex = /href=["']([^"']*\.pdf[^"']*)/gi;
  const links = [];
  let match;
  while ((match = pdfRegex.exec(html)) !== null) {
    const href = match[1];
    const fullUrl = href.startsWith('http') ? href : `${baseUrl}/${href}`;
    const isProspectus = /prospectus|brochure|handbook|admission|fees/i.test(href);
    if (isProspectus) links.push(fullUrl);
  }
  return links.slice(0, 3);
}

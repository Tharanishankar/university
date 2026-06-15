import { getNextQueueItem, markQueueDone, markQueueFailed, markQueueNeedsRetry,
  upsertUniversity, upsertProgram, upsertCollege, upsertTuitionFee,
  upsertAdmissionRequirement, upsertEntranceTest, addToQueue, supabase } from '../supabase.js';
import { extractUniversityData } from '../claude.js';
import { fetchHTML, hasActivePrograms, findPDFLinks, validateExtractedPrograms } from '../utils/validator.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { requeueStuckItems } from '../utils/queue.js';

const PROGRAM_KEYWORDS = [
  'program', 'course', 'department', 'school', 'faculty',
  'undergraduate', 'postgraduate', 'ug', 'pg',
  'btech', 'b-tech', 'b.tech', 'mtech', 'm-tech', 'm.tech', 'mba',
  'admissions', 'academics', 'engineering', 'science', 'arts', 'commerce',
  'law', 'medicine', 'pharmacy', 'design', 'architecture',
  'management', 'technology', 'studies', 'stream',
];

const MAX_SUBPAGES = 20;
const MAX_DEPTH = 3;

function extractInternalLinks(html, baseUrl) {
  const origin = new URL(baseUrl).origin;
  // Match full anchor tags to capture both href and link text
  const anchorRegex = /<a\s[^>]*href=["']([^"'#?][^"']*)[^>]*>([^<]*)<\/a>/gi;
  const hrefOnlyRegex = /href=["']([^"'#?][^"']*)/gi;
  const seen = new Set();
  const links = [];

  const tryAdd = (href, linkText = '') => {
    try {
      const url = href.startsWith('http') ? new URL(href) : new URL(href, baseUrl);
      if (url.origin !== origin) return;
      const normalized = url.origin + url.pathname;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      const path = url.pathname.toLowerCase();
      const text = linkText.toLowerCase();
      if (PROGRAM_KEYWORDS.some(kw => path.includes(kw) || text.includes(kw))) {
        links.push(normalized);
      }
    } catch {
      // skip malformed URLs
    }
  };

  let match;
  while ((match = anchorRegex.exec(html)) !== null) tryAdd(match[1].trim(), match[2].trim());
  // second pass for any hrefs not captured by anchor regex (e.g. JS-rendered text)
  while ((match = hrefOnlyRegex.exec(html)) !== null) tryAdd(match[1].trim());

  return links;
}

async function fetchSitemapUrls(baseUrl) {
  const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
  const xml = await fetchHTML(sitemapUrl);
  if (!xml) return [];
  const locRegex = /<loc>([^<]+)<\/loc>/gi;
  const urls = [];
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1].trim();
    const path = url.toLowerCase();
    if (PROGRAM_KEYWORDS.some(kw => path.includes(kw))) urls.push(url);
  }
  logger.info('Sitemap URLs matching program keywords', { baseUrl, count: urls.length });
  return urls;
}

async function deepCrawl(baseUrl, universityName, useSitemap = false) {
  const visited = new Set([baseUrl]);
  const htmlChunks = [];

  const homepageHtml = await fetchHTML(baseUrl);
  if (!homepageHtml) return null;
  htmlChunks.push(homepageHtml);

  let seedLinks;
  if (useSitemap) {
    const sitemapUrls = await fetchSitemapUrls(baseUrl);
    seedLinks = sitemapUrls.length > 0
      ? sitemapUrls
      : extractInternalLinks(homepageHtml, baseUrl);
    logger.info('Deep crawl (sitemap mode) seed links', { university: universityName, count: seedLinks.length });
  } else {
    seedLinks = extractInternalLinks(homepageHtml, baseUrl);
    logger.info('Deep crawl level 1 links found', { university: universityName, count: seedLinks.length });
  }

  let frontier = seedLinks;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    if (visited.size - 1 >= MAX_SUBPAGES) break;

    const nextFrontier = [];

    for (const url of frontier) {
      if (visited.size - 1 >= MAX_SUBPAGES) break;
      if (visited.has(url)) continue;
      visited.add(url);

      const html = await fetchHTML(url);
      if (!html) continue;
      htmlChunks.push(html);

      if (depth < MAX_DEPTH) {
        const childLinks = extractInternalLinks(html, baseUrl);
        for (const link of childLinks) {
          if (!visited.has(link)) nextFrontier.push(link);
        }
      }
    }

    logger.info(`Deep crawl depth ${depth} complete`, {
      university: universityName,
      subpagesFetched: visited.size - 1,
      nextFrontierSize: nextFrontier.length,
    });

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  logger.info('Deep crawl complete', { university: universityName, totalPages: visited.size });
  return htmlChunks.join('\n');
}

async function saveUniversityData(item, extracted) {
  const university = await upsertUniversity({
    name: item.university_name,
    country: 'India',
    state: item.state,
    type: item.university_type,
    website: item.university_url,
    accreditation_body: 'UGC',
    naac_grade: item.naac_grade,
    is_active: true,
    last_verified: new Date().toISOString(),
  });

  for (const college of extracted.colleges || []) {
    await upsertCollege({
      university_id: university.id,
      name: college.name,
      website: college.website,
    });
  }

  for (const program of extracted.programs) {
    const prog = await upsertProgram({
      university_id: university.id,
      name: program.name,
      degree_level: program.degree_level,
      field_of_study: program.field_of_study,
      duration_years: program.duration_years,
      delivery_mode: program.delivery_mode,
      language_of_instruction: program.language,
      is_active: true,
    });

    if (prog) {
      for (const fee of extracted.tuition_fees || []) {
        await upsertTuitionFee({ program_id: prog.id, ...fee });
      }
      for (const req of extracted.admission_requirements || []) {
        await upsertAdmissionRequirement({ program_id: prog.id, ...req });
      }
      for (const test of extracted.entrance_tests || []) {
        await upsertEntranceTest({ program_id: prog.id, ...test });
      }
    }
  }

  return university;
}

export async function runWebsiteCrawler() {
  logger.info('Website crawler started');
  await requeueStuckItems();

  let processedCount = 0;

  while (true) {
    if (config.crawler.testMode && processedCount >= config.crawler.testLimit) {
      logger.info('Test mode limit reached', { processed: processedCount });
      break;
    }

    const item = await getNextQueueItem('website');

    if (!item) {
      logger.info('Queue empty — waiting 60 seconds');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const metadata = JSON.parse(item.metadata || '{}');
    const isDeepCrawlRetry = !!metadata.needs_deep_crawl;

    logger.info('Processing university', {
      name: item.university_name,
      url: item.university_url,
      mode: isDeepCrawlRetry ? 'needs_deep_crawl (sitemap)' : 'normal',
    });

    try {
      const html = await deepCrawl(item.university_url, item.university_name, isDeepCrawlRetry);

      if (!html) {
        await markQueueFailed(item.id, 'Could not fetch website HTML');
        continue;
      }

      if (!hasActivePrograms(html)) {
        if (isDeepCrawlRetry) {
          // Already tried sitemap — accept 0 programs rather than retrying forever
          logger.warn('No active programs after deep crawl — marking done with 0 programs', { name: item.university_name });
          await upsertUniversity({
            name: item.university_name,
            country: 'India',
            state: item.state,
            type: item.university_type,
            website: item.university_url,
            accreditation_body: 'UGC',
            naac_grade: item.naac_grade,
            is_active: true,
            last_verified: new Date().toISOString(),
          });
          await markQueueDone(item.id);
          processedCount++;
        } else {
          await markQueueFailed(item.id, 'No active programs found on website');
        }
        continue;
      }

      const extracted = await extractUniversityData(
        html,
        item.university_name,
        item.university_url
      );

      const validPrograms = validateExtractedPrograms(extracted.programs);
      const rejectedCount = (extracted.programs || []).length - validPrograms.length;

      if (rejectedCount > 0) {
        logger.warn('Filtered invalid/generic program names', {
          name: item.university_name,
          rejected: rejectedCount,
          kept: validPrograms.length,
        });
      }

      if (validPrograms.length === 0) {
        if (isDeepCrawlRetry) {
          // Already tried sitemap — give up
          logger.warn('No specific programs after sitemap crawl — marking failed', { name: item.university_name });
          await markQueueFailed(item.id, 'No specific program names found after deep crawl and sitemap retry');
        } else {
          // First failure — re-queue at highest priority with sitemap flag
          logger.warn('No specific programs found — re-queuing for sitemap deep crawl', { name: item.university_name });
          await markQueueFailed(item.id, 'needs_deep_crawl: no specific programs on first pass');
          await addToQueue([{
            university_name: item.university_name,
            university_url: item.university_url,
            state: item.state,
            university_type: item.university_type,
            naac_grade: item.naac_grade,
            worker_type: 'website',
            status: 'pending',
            priority: 10,
            retry_count: 0,
            metadata: JSON.stringify({ ...metadata, needs_deep_crawl: true }),
          }]);
        }
        continue;
      }

      extracted.programs = validPrograms;

      const university = await saveUniversityData(item, extracted);

      const pdfLinks = findPDFLinks(html, item.university_url);
      if (pdfLinks.length > 0) {
        await addToQueue(pdfLinks.map(url => ({
          university_name: item.university_name,
          university_url: url,
          state: item.state,
          worker_type: 'pdf',
          status: 'pending',
          priority: item.priority,
          retry_count: 0,
          metadata: JSON.stringify({ parent_university_id: university.id }),
        })));
      }

      await markQueueDone(item.id);
      processedCount++;
      logger.success('University processed', {
        name: item.university_name,
        programs: extracted.programs.length,
        colleges: extracted.colleges?.length || 0,
      });

    } catch (error) {
      logger.error('Processing failed', {
        name: item.university_name,
        error: error.message,
      });
      await markQueueNeedsRetry(item.id, (item.retry_count || 0) + 1);
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }
}

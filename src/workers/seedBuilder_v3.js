// src/workers/seedBuilder_v3.js
import { getUniversitiesFromWikipedia, getRegions } from '../wikipedia_v3.js';
import { addToQueue } from '../supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

/**
 * Light normalization for exact-name duplicate detection.
 * Does NOT strip keywords — that was the v2 bug.
 */
function lightNormalize(name) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isExactDuplicate(name, seenSet) {
  return seenSet.has(lightNormalize(name));
}

export async function runSeedBuilderV3() {
  const country = config.crawler.country;
  const regions = getRegions(country);

  logger.info('Seed builder v3 starting', { country, totalRegions: regions.length });

  const allUniversities = [];
  const seenNames = new Set();
  let duplicateCount = 0;

  const regionsToProcess = config.crawler.testMode
    ? regions.slice(0, 2)
    : regions;

  for (const region of regionsToProcess) {
    logger.info('Scraping Wikipedia', { region, country });

    try {
      const universities = await getUniversitiesFromWikipedia(region, country);

      for (const uni of universities) {
        if (isExactDuplicate(uni.name, seenNames)) {
          duplicateCount++;
          continue;
        }
        seenNames.add(lightNormalize(uni.name));
        allUniversities.push(uni);
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (error) {
      logger.error('Region scrape failed', { region, error: error.message });
    }
  }

  logger.info('Seed builder v3 complete', {
    country,
    unique: allUniversities.length,
    duplicates: duplicateCount,
  });

  if (allUniversities.length === 0) {
    logger.error('No universities found — check Wikipedia categories', { country });
    return;
  }

  const queueItems = allUniversities.map(uni => ({
    university_name: uni.name,
    university_url: null,
    state: uni.state,
    worker_type: 'enricher_v3',
    status: 'pending',
    priority: 5,
    retry_count: 0,
    metadata: JSON.stringify({
      country,
      city: uni.city,
      wikipedia_summary: uni.wikipedia_summary,
    }),
  }));

  const chunkSize = 50;
  for (let i = 0; i < queueItems.length; i += chunkSize) {
    await addToQueue(queueItems.slice(i, i + chunkSize));
  }

  logger.success('Queue populated', { country, count: queueItems.length });
}

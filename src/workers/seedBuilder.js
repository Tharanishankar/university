import { getUniversitiesFromWikipedia, getRegions } from '../wikipedia.js';
import { addToQueue } from '../supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/university|institute|of|technology|the|and|hochschule|universität|fachhochschule/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function isDuplicate(name, existingNames) {
  const normalized = normalizeName(name);
  return existingNames.some(existing => {
    const normalizedExisting = normalizeName(existing);
    return normalizedExisting === normalized ||
      (normalized.length > 8 && normalizedExisting.includes(normalized)) ||
      (normalizedExisting.length > 8 && normalized.includes(normalizedExisting));
  });
}

export async function runSeedBuilder() {
  const country = config.crawler.country;
  const regions = getRegions(country);

  logger.info('Seed builder v2 starting', { country, totalRegions: regions.length });

  const allUniversities = [];
  const seenNames = [];

  const regionsToProcess = config.crawler.testMode
    ? regions.slice(0, 2)
    : regions;

  for (const region of regionsToProcess) {
    logger.info('Getting universities from Wikipedia', { region, country });

    try {
      const universities = await getUniversitiesFromWikipedia(region, country);

      for (const uni of universities) {
        if (isDuplicate(uni.name, seenNames)) {
          logger.info('Skipping duplicate', { name: uni.name });
          continue;
        }
        seenNames.push(uni.name);
        allUniversities.push(uni);
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (error) {
      logger.error('Failed to get universities for region', { region, error: error.message });
    }
  }

  logger.info('Total unique universities found', { country, count: allUniversities.length });

  if (allUniversities.length === 0) {
    logger.error('No universities found — check Wikipedia API and category names', { country });
    return;
  }

  const queueItems = allUniversities.map(uni => ({
    university_name: uni.name,
    university_url: null,
    state: uni.state,
    worker_type: 'enricher',
    status: 'pending',
    priority: 5,
    retry_count: 0,
    metadata: JSON.stringify({ country }),
  }));

  const chunkSize = 50;
  for (let i = 0; i < queueItems.length; i += chunkSize) {
    await addToQueue(queueItems.slice(i, i + chunkSize));
  }

  logger.success('Queue populated', { country, count: queueItems.length });
}

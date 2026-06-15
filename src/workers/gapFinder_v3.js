// src/workers/gapFinder_v3.js
import { supabase, addToQueue } from '../supabase.js';
import { findMissingUniversities } from '../perplexity_v3.js';
import { getRegions } from '../wikipedia_v3.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { isNonUniversity } from '../utils/nonUniversityPatterns.js';

function lightNormalize(name) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Get all universities already known for a country, grouped by state.
 * Includes both DB rows AND pending queue items, so we don't add dupes.
 */
async function getExistingNamesByState(country) {
  const byState = new Map();

  // From universities table
  const { data: dbUnis } = await supabase
    .from('universities')
    .select('name, state')
    .eq('country', country);

  for (const uni of dbUnis || []) {
    const state = uni.state || 'unknown';
    if (!byState.has(state)) byState.set(state, new Set());
    byState.get(state).add(lightNormalize(uni.name));
  }

  // From pending queue items (just-seeded but not yet enriched)
  const { data: queueItems } = await supabase
    .from('crawler_queue')
    .select('university_name, state, metadata')
    .in('status', ['pending', 'processing']);

  for (const item of queueItems || []) {
    const meta = JSON.parse(item.metadata || '{}');
    if (meta.country !== country) continue;
    const state = item.state || 'unknown';
    if (!byState.has(state)) byState.set(state, new Set());
    byState.get(state).add(lightNormalize(item.university_name));
  }

  return byState;
}

export async function runGapFinderV3() {
  const country = config.crawler.country;
  const regions = getRegions(country);

  logger.info('Gap finder v3 starting', { country, regions: regions.length });

  const existingByState = await getExistingNamesByState(country);

  let totalAdded = 0;
  let totalRejected = 0;
  const newQueueItems = [];

  for (const region of regions) {
    const existing = existingByState.get(region) || new Set();
    const existingArray = Array.from(existing);

    const mode = existingArray.length === 0 ? 'discover_all' : 'find_gaps';
    logger.info('Checking for gaps', {
      region,
      country,
      existingCount: existingArray.length,
      mode,
    });

    // Call Perplexity — when existingCount = 0, prompt asks for ALL universities;
    // when > 0, prompt asks what's missing from the supplied list.
    const missing = await findMissingUniversities(region, country, existingArray);

    if (missing.length === 0) {
      logger.info('No gaps found', { region });
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    logger.info('Gaps reported by Perplexity', {
      region,
      count: missing.length,
      names: missing.map(m => m.name),
    });

    // Validate each missing entry
    for (const candidate of missing) {
      const normalizedName = lightNormalize(candidate.name);

      // Defensive: reject if name matches non-university pattern (Perplexity hallucination)
      if (isNonUniversity(candidate.name)) {
        logger.warn('Gap finder rejected pattern match', {
          name: candidate.name,
          region,
        });
        totalRejected++;
        continue;
      }

      // Defensive: reject if already in existing set (Perplexity returned a dupe)
      if (existing.has(normalizedName)) {
        logger.debug('Gap finder skipped existing', { name: candidate.name });
        continue;
      }

      // Add to queue with gap_finder source for audit
      newQueueItems.push({
        university_name: candidate.name,
        university_url: null,
        state: region,
        worker_type: 'enricher_v3',
        status: 'pending',
        priority: 5,
        retry_count: 0,
        metadata: JSON.stringify({
          country,
          city: candidate.city || null,
          source: 'gap_finder',
          gap_finder_type: candidate.type || null,
          gap_finder_confidence: candidate.confidence || null,
        }),
      });

      existing.add(normalizedName);
      totalAdded++;
    }

    // Polite delay between regions
    await new Promise(r => setTimeout(r, 3000));
  }

  if (newQueueItems.length === 0) {
    logger.info('Gap finder complete — no new universities found', { country });
    return;
  }

  // Bulk insert in chunks
  const chunkSize = 50;
  for (let i = 0; i < newQueueItems.length; i += chunkSize) {
    await addToQueue(newQueueItems.slice(i, i + chunkSize));
  }

  logger.success('Gap finder complete', {
    country,
    added: totalAdded,
    rejected: totalRejected,
  });
}

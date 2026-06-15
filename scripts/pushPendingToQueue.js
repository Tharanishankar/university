// scripts/pushPendingToQueue.js
//
// One-shot script: finds all universities with crawl_status='pending'
// for a given country and pushes them into crawler_queue with the
// exact metadata shape that seedBuilder_v3 produces, so enricher_v3
// can process them normally.

import { supabase, addToQueue } from '../src/supabase.js';
import { logger } from '../src/utils/logger.js';
import { config } from '../src/config.js';

export async function runPushPendingToQueue() {
  const country = config.crawler.country;
  logger.info('Push pending to queue starting', { country });

  const { data, error } = await supabase
    .from('universities')
    .select('name, state, country, city')
    .eq('country', country)
    .eq('crawl_status', 'pending')
    .eq('is_active', true);

  if (error) {
    logger.error('Failed to fetch pending universities', { error: error.message });
    return;
  }

  const universities = data || [];

  if (universities.length === 0) {
    logger.info('No pending universities to push', { country });
    return;
  }

  const queueItems = universities.map(u => ({
    university_name: u.name,
    university_url: null,
    state: u.state,
    worker_type: 'enricher_v3',
    status: 'pending',
    priority: 5,
    retry_count: 0,
    metadata: JSON.stringify({
      country: u.country,
      city: u.city,
      wikipedia_summary: '',
    }),
  }));

  // Bulk insert in chunks to match seedBuilder_v3 pattern
  const chunkSize = 50;
  for (let i = 0; i < queueItems.length; i += chunkSize) {
    await addToQueue(queueItems.slice(i, i + chunkSize));
  }

  logger.success('Push pending to queue complete', {
    pushed: queueItems.length,
    country,
  });
}

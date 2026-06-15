import { getNextQueueItem, markQueueDone, markQueueFailed,
  upsertTuitionFee, upsertEntranceTest, supabase } from '../supabase.js';
import { searchAggregatorData } from '../claude.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { addToQueue } from '../supabase.js';

export async function seedAggregatorQueue() {
  const { data: universities } = await supabase
    .from('universities')
    .select('id, name')
    .eq('country', 'India');

  const items = (universities || []).map(uni => ({
    university_name: uni.name,
    university_url: `search:${uni.name}`,
    worker_type: 'aggregator',
    status: 'pending',
    priority: 5,
    retry_count: 0,
    metadata: JSON.stringify({
      university_id: uni.id,
      queries: [
        `site:shiksha.com ${uni.name} courses fees`,
        `site:careers360.com ${uni.name} programs`,
      ],
    }),
  }));

  const chunkSize = 50;
  for (let i = 0; i < items.length; i += chunkSize) {
    await addToQueue(items.slice(i, i + chunkSize));
  }

  logger.info('Aggregator queue seeded', { count: items.length });
}

export async function runAggregatorScraper() {
  logger.info('Aggregator scraper started');
  await seedAggregatorQueue();

  while (true) {
    const item = await getNextQueueItem('aggregator');

    if (!item) {
      logger.info('Aggregator queue empty — waiting 60 seconds');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const metadata = JSON.parse(item.metadata || '{}');
    const { university_id: universityId, queries = [] } = metadata;

    logger.info('Processing aggregator search', {
      name: item.university_name,
      queries,
    });

    try {
      const extracted = await searchAggregatorData(item.university_name, queries);

      if (universityId) {
        const { data: programs } = await supabase
          .from('programs')
          .select('id')
          .eq('university_id', universityId)
          .limit(50);

        for (const program of programs || []) {
          for (const fee of extracted.tuition_fees || []) {
            await upsertTuitionFee({ program_id: program.id, ...fee });
          }
          for (const test of extracted.entrance_tests || []) {
            await upsertEntranceTest({ program_id: program.id, ...test });
          }
        }
      }

      await markQueueDone(item.id);
      logger.success('Aggregator search processed', {
        name: item.university_name,
        fees: extracted.tuition_fees?.length || 0,
        tests: extracted.entrance_tests?.length || 0,
      });

    } catch (error) {
      logger.error('Aggregator failed', { name: item.university_name, error: error.message });
      await markQueueFailed(item.id, error.message);
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }
}

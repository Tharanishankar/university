import { supabase, addToQueue, getQueueStats } from '../supabase.js';
import { logger } from './logger.js';

export async function initializeQueue() {
  const stats = await getQueueStats();
  const totalPending = Object.entries(stats)
    .filter(([k]) => k.includes('pending'))
    .reduce((sum, [, v]) => sum + v, 0);

  if (totalPending > 0) {
    logger.info('Queue already initialized', stats);
    return;
  }

  logger.info('Queue empty — seed builder needs to run first');
}

export async function requeueStuckItems() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('crawler_queue')
    .update({ status: 'pending', started_at: null })
    .eq('status', 'processing')
    .lt('started_at', tenMinutesAgo);
  if (error) logger.error('Failed to requeue stuck items', { error });
}

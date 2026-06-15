import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey
);

export async function getNextQueueItem(workerType) {
  const { data, error } = await supabase
    .from('crawler_queue')
    .select('*')
    .eq('status', 'pending')
    .eq('worker_type', workerType)
    .order('priority', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  await supabase
    .from('crawler_queue')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', data.id);
  return data;
}

export async function markQueueDone(id) {
  await supabase
    .from('crawler_queue')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', id);
}

export async function markQueueFailed(id, reason) {
  await supabase
    .from('crawler_queue')
    .update({
      status: 'failed',
      error_message: reason,
      completed_at: new Date().toISOString()
    })
    .eq('id', id);
}

export async function markQueueNeedsRetry(id, retryCount) {
  await supabase
    .from('crawler_queue')
    .update({
      status: retryCount >= config.crawler.maxRetries ? 'failed' : 'pending',
      retry_count: retryCount,
      started_at: null
    })
    .eq('id', id);
}

export async function upsertUniversity(data) {
  const { data: result, error } = await supabase
    .from('universities')
    .upsert(data, { onConflict: 'name,country' })
    .select()
    .single();
  if (error) throw error;
  return result;
}

export async function upsertProgram(data) {
  const { error } = await supabase
    .from('programs')
    .upsert(data, { onConflict: 'university_id,name,degree_level' });
  if (error) throw error;
}

export async function upsertCollege(data) {
  const { error } = await supabase
    .from('colleges')
    .upsert(data, { onConflict: 'university_id,name' });
  if (error) throw error;
}

export async function upsertTuitionFee(data) {
  const { error } = await supabase
    .from('tuition_fees')
    .upsert(data, { onConflict: 'program_id,student_category,academic_year' });
  if (error) throw error;
}

export async function upsertAdmissionRequirement(data) {
  const { error } = await supabase
    .from('admission_requirements')
    .upsert(data, { onConflict: 'program_id,requirement_type,subject_group' });
  if (error) throw error;
}

export async function upsertEntranceTest(data) {
  const { error } = await supabase
    .from('entrance_tests')
    .upsert(data, { onConflict: 'program_id,test_name' });
  if (error) throw error;
}

export async function addToQueue(items) {
  const { error } = await supabase
    .from('crawler_queue')
    .insert(items);
  if (error) throw error;
}

export async function getQueueStats() {
  const { data } = await supabase
    .from('crawler_queue')
    .select('status, worker_type')
  const stats = {};
  for (const row of data || []) {
    const key = `${row.worker_type}_${row.status}`;
    stats[key] = (stats[key] || 0) + 1;
  }
  return stats;
}

export async function upsertCampus(data) {
  const { data: result, error } = await supabase
    .from('campuses')
    .upsert(data, { onConflict: 'university_id,city,country' })
    .select()
    .single();
  if (error) throw error;
  return result;
}

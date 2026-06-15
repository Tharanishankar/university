// src/utils/peerFallback.js
import { supabase } from '../supabase.js';
import { logger } from './logger.js';

const VAGUE_TERMS = ['varies', 'depends', 'not available', 'not specified', 'unclear', 'tbd', 'n/a'];

/**
 * Returns true if a string value is too vague to save.
 */
export function isVague(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const lowered = value.toLowerCase().trim();
  if (lowered === '') return true;
  return VAGUE_TERMS.some(term => lowered.includes(term));
}

/**
 * Find a peer university's fee for a given tier + country + program.
 * Returns the peer's annual_fee + currency, or null if no peer found.
 */
export async function findPeerFee(country, tier, fieldOfStudy, studentCategory) {
  if (!tier) return null;

  try {
    const { data, error } = await supabase
      .from('tuition_fees')
      .select(`
        annual_fee, currency, academic_year,
        program:program_id (
          field_of_study,
          university:university_id (country, global_tier)
        )
      `)
      .eq('student_category', studentCategory)
      .eq('is_estimated', false)
      .not('annual_fee', 'is', null)
      .limit(50);

    if (error || !data) return null;

    // Filter to same country + tier + similar field
    const matches = data.filter(row =>
      row.program?.university?.country === country &&
      row.program?.university?.global_tier === tier &&
      (
        !fieldOfStudy ||
        row.program?.field_of_study?.toLowerCase().includes(fieldOfStudy.toLowerCase()) ||
        fieldOfStudy.toLowerCase().includes(row.program?.field_of_study?.toLowerCase() || '')
      )
    );

    if (matches.length === 0) return null;

    // Average the peer fees for stability
    const avgFee = Math.round(
      matches.reduce((sum, m) => sum + Number(m.annual_fee), 0) / matches.length
    );

    return {
      annual_fee: avgFee,
      currency: matches[0].currency,
      academic_year: matches[0].academic_year,
      peer_count: matches.length,
    };
  } catch (err) {
    logger.warn('Peer fallback lookup failed', { error: err.message });
    return null;
  }
}

/**
 * Find peer admission requirement for a given tier + country + field.
 */
export async function findPeerAdmissionRequirement(country, tier, fieldOfStudy) {
  if (!tier) return null;

  try {
    const { data, error } = await supabase
      .from('admission_requirements')
      .select(`
        subject_group, min_percentage, notes,
        program:program_id (
          field_of_study,
          university:university_id (country, global_tier)
        )
      `)
      .not('min_percentage', 'is', null)
      .limit(50);

    if (error || !data) return null;

    const matches = data.filter(row =>
      row.program?.university?.country === country &&
      row.program?.university?.global_tier === tier &&
      (
        !fieldOfStudy ||
        row.program?.field_of_study?.toLowerCase().includes(fieldOfStudy.toLowerCase())
      )
    );

    if (matches.length === 0) return null;

    return {
      subject_group: matches[0].subject_group,
      min_percentage: matches[0].min_percentage,
      notes: `Estimated from ${matches.length} peer institutions in same tier`,
      peer_count: matches.length,
    };
  } catch (err) {
    logger.warn('Peer admission fallback failed', { error: err.message });
    return null;
  }
}

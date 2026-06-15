import { supabase } from '../supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export async function runSiblingAugmentor() {
  logger.info('Sibling augmentor started');

  while (true) {
    // Find programs missing fees
    const { data: programsMissingFees } = await supabase
      .from('programs')
      .select('id, name, degree_level, university_id')
      .not('id', 'in',
        supabase.from('tuition_fees').select('program_id')
      )
      .limit(50);

    if (!programsMissingFees || programsMissingFees.length === 0) {
      logger.info('No programs missing fees — waiting 5 minutes');
      await new Promise(r => setTimeout(r, 300000));
      continue;
    }

    logger.info('Found programs missing fees', { count: programsMissingFees.length });

    for (const program of programsMissingFees) {
      try {
        // Find sibling programs (same university, same degree_level) that have fees
        const { data: siblings } = await supabase
          .from('programs')
          .select(`
            id, name,
            tuition_fees (student_category, annual_fee, currency, academic_year)
          `)
          .eq('university_id', program.university_id)
          .eq('degree_level', program.degree_level)
          .neq('id', program.id)
          .not('tuition_fees', 'is', null);

        if (!siblings || siblings.length === 0) continue;

        const sibling = siblings[0];
        if (!sibling.tuition_fees || sibling.tuition_fees.length === 0) continue;

        for (const fee of sibling.tuition_fees) {
          await supabase.from('tuition_fees').upsert({
            program_id: program.id,
            student_category: fee.student_category,
            annual_fee: fee.annual_fee,
            currency: fee.currency,
            academic_year: fee.academic_year,
          }, { onConflict: 'program_id,student_category,academic_year' });
        }

        logger.info('Augmented fees from sibling', {
          program: program.name,
          sibling: sibling.name,
        });

      } catch (error) {
        continue;
      }
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }
}

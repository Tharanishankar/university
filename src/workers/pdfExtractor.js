import { createRequire } from 'module';
import axios from 'axios';
import { getNextQueueItem, markQueueDone, markQueueFailed,
  upsertTuitionFee, upsertAdmissionRequirement, upsertEntranceTest,
  supabase } from '../supabase.js';
import { extractFromPDF } from '../claude.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export async function runPDFExtractor() {
  logger.info('PDF extractor started');

  while (true) {
    const item = await getNextQueueItem('pdf');

    if (!item) {
      logger.info('PDF queue empty — waiting 60 seconds');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    logger.info('Processing PDF', { url: item.university_url });

    try {
      const response = await axios.get(item.university_url, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const pdfData = await pdfParse(Buffer.from(response.data));
      const extracted = await extractFromPDF(pdfData.text, item.university_name);

      const metadata = JSON.parse(item.metadata || '{}');
      const universityId = metadata.parent_university_id;

      if (universityId && extracted.tuition_fees) {
        const { data: programs } = await supabase
          .from('programs')
          .select('id')
          .eq('university_id', universityId)
          .limit(50);

        for (const program of programs || []) {
          for (const fee of extracted.tuition_fees || []) {
            await upsertTuitionFee({ program_id: program.id, ...fee });
          }
          for (const req of extracted.admission_requirements || []) {
            await upsertAdmissionRequirement({ program_id: program.id, ...req });
          }
          for (const test of extracted.entrance_tests || []) {
            await upsertEntranceTest({ program_id: program.id, ...test });
          }
        }
      }

      await markQueueDone(item.id);
      logger.success('PDF processed', { url: item.university_url });

    } catch (error) {
      logger.error('PDF processing failed', { error: error.message });
      await markQueueFailed(item.id, error.message);
    }

    await new Promise(r => setTimeout(r, config.crawler.delayMs));
  }
}

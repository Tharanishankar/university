// scripts/runWorker.js
import { runSeedBuilder } from '../src/workers/seedBuilder.js';
import { runEnricher } from '../src/workers/enricher.js';
import { runSeedBuilderV3 } from '../src/workers/seedBuilder_v3.js';
import { runGapFinderV3 } from '../src/workers/gapFinder_v3.js';
import { runEnricherV3 } from '../src/workers/enricher_v3.js';
import { runProgramBackfillV3 } from '../src/workers/programBackfill_v3.js';
import { runAdmissionBackfillV3 } from '../src/workers/admissionBackfill_v3.js';
import { runPushPendingToQueue } from './pushPendingToQueue.js';
import { runProgramUrlValidatorV3 } from '../src/workers/programUrlValidator_v3.js';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

const workerType = process.argv[2];

// Parse --country=X argument (overrides env var if present)
const countryArg = process.argv.find(a => a.startsWith('--country='));
if (countryArg) {
  config.crawler.country = countryArg.split('=')[1];
}

// Parse --test for test mode
if (process.argv.includes('--test')) {
  config.crawler.testMode = true;
}

const v3Workers = ['seed_v3', 'gap_finder_v3', 'enricher_v3', 'program_backfill_v3', 'admission_backfill_v3', 'push_pending', 'validate_urls'];
if (v3Workers.includes(workerType)) {
  if (!config.crawler.country) {
    logger.error('--country argument is required for v3 workers', {
      workerType,
      example: `node scripts/runWorker.js ${workerType} --country=Germany`,
    });
    process.exit(1);
  }
  const SUPPORTED = ['Germany', 'United Kingdom', 'USA', 'India', 'Canada', 'Australia'];
  if (!SUPPORTED.includes(config.crawler.country)) {
    logger.error('Unsupported country', {
      country: config.crawler.country,
      supported: SUPPORTED,
    });
    process.exit(1);
  }
}

logger.info('Worker starting', {
  type: workerType,
  country: config.crawler.country,
  testMode: config.crawler.testMode,
});

(async () => {
  try {
    switch (workerType) {
      case 'seed':            await runSeedBuilder(); break;
      case 'enricher':        await runEnricher(); break;
      case 'seed_v3':         await runSeedBuilderV3(); break;
      case 'gap_finder_v3':   await runGapFinderV3(); break;
      case 'enricher_v3':     await runEnricherV3(); break;
      case 'program_backfill_v3': await runProgramBackfillV3(); break;
      case 'admission_backfill_v3': await runAdmissionBackfillV3(); break;
      case 'push_pending': await runPushPendingToQueue(); break;
      case 'validate_urls': await runProgramUrlValidatorV3(); break;
      default:
        logger.error('Unknown worker type', { workerType });
        logger.info('Valid types: seed, enricher, seed_v3, gap_finder_v3, enricher_v3, program_backfill_v3, admission_backfill_v3, push_pending, validate_urls');
        logger.info('validate_urls flags: --mode=check (default) | --mode=backfill, --retry-failed (check mode only)');
        process.exit(1);
    }
  } catch (err) {
    logger.error('Worker crashed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
})();

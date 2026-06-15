// src/workers/programUrlValidator_v3.js
//
// Two modes, dispatched by --mode:
//
//   --mode=check (default)
//     HTTP-validate every program_url for a given country (HEAD with
//     GET fallback on 405/403) and persist the result to
//     programs.url_status + programs.url_checked_at.
//
//   --mode=backfill
//     For programs whose URL is broken or missing, run a
//     Brave Search → HTTP validate → fetch page content → Sonnet
//     pipeline to pick the official program URL and write it back.
//
// Both modes accept --country=<Germany|"United Kingdom"|USA|India>.
// Check mode also accepts --retry-failed (re-validate previously
// failed URLs only). Backfill mode also accepts --retry-not-found
// (target programs that landed on homepage fallback or invalid).

// ==========================================================
// IMPORTS
// ==========================================================
import axios from 'axios';
import pLimit from 'p-limit';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// ==========================================================
// STATUS & TIER REFERENCE
// ==========================================================
/**
 * URL Status Values (`programs.url_status` column):
 *   - '200', '301', '404', '500', etc — HTTP status code as text
 *   - 'TIMEOUT'   — request exceeded HTTP_TIMEOUT_MS
 *   - 'DNS_FAIL'  — could not resolve hostname (ENOTFOUND / EAI_AGAIN)
 *   - 'CONN_ERR'  — connection refused / reset (ECONNREFUSED / ECONNRESET)
 *   - 'SSL_ERR'   — expired / invalid certificate
 *   - 'ERROR'     — any other network / HTTP-client error
 *
 * URL Backfill Status Values (`programs.url_backfill_status` column):
 *   - 'replaced'          — a URL was written. Use url_backfill_tier
 *                           to tell which tier produced it.
 *   - 'invalid_candidate' — RPC row had no university_website to fall
 *                           back to. Practically unreachable because
 *                           the RPC filters website IS NOT NULL.
 *   - 'error'             — unexpected exception during processing.
 *
 * URL Backfill Tier Values (`programs.url_backfill_tier` column):
 *   - 1    — Exact program page (Sonnet matched TIER_1)
 *   - 2    — Department / subject page (Sonnet matched TIER_2)
 *   - 3    — University homepage fallback (no Sonnet match survived).
 *            Written WITHOUT HTTP validation — many university
 *            homepages sit behind Cloudflare bot protection that 403s
 *            server-side checks. Trusted from enrichment.
 *   - null — Status is 'invalid_candidate' or 'error'.
 */

// ==========================================================
// CONSTANTS
// ==========================================================

// --- HTTP ---
const HTTP_TIMEOUT_MS = 10000;
// Standard Chrome desktop UA — university sites block bot-identifying UAs with 403.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HTTP_HEADERS = { 'User-Agent': CHROME_UA };

// --- Brave ---
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_TOP_N = 10;
const BRAVE_RETRY_DELAY_MS = 5000;

// --- Sonnet ---
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const SONNET_MAX_TOKENS = 200;
const SONNET_TEMPERATURE = 0;
const PAGE_CONTENT_CHARS = 1500;

// --- Concurrency ---
const CHECK_CONCURRENCY = 20;        // check mode HTTP fan-out
const BACKFILL_CONCURRENCY = 5;      // well under Brave's 50/sec
const BATCH_DELAY_MS = 200;
const RPC_MAX_ROWS = 100000;
const VALIDATE_TOP_N = 5;            // HTTP-validate only the top N Brave candidates

// --- Logging / audit knobs ---
const PROGRESS_INTERVAL = 100;       // check mode: log every N programs
const DETAIL_LOG_LIMIT = 5;          // backfill mode: verbose logs for first N programs
const FAILED_STATUSES = ['403', '404', 'TIMEOUT', 'ERROR', '500', '400']; // --retry-failed target set

// Shared axios config (derived from HTTP_* constants above)
const axiosConfig = {
  timeout: HTTP_TIMEOUT_MS,
  maxRedirects: 5,
  validateStatus: () => true, // never throw on non-2xx — we want to record it
  headers: HTTP_HEADERS,
};

// ==========================================================
// LOGGER SETUP
// ==========================================================

const NEXT_STEP_SEPARATOR = '=========================================================';

/**
 * Emit a uniformly-formatted "next step" block to stdout, intended for
 * Railway operators to read and update the service start command.
 * @param {...string} lines - Plain lines (no key/value pairs).
 */
function logNextStepHint(...lines) {
  logger.info(NEXT_STEP_SEPARATOR);
  for (const line of lines) logger.info(line);
  logger.info(NEXT_STEP_SEPARATOR);
}

// ==========================================================
// HELPER FUNCTIONS — HTTP VALIDATION
// ==========================================================

/**
 * Send a single HEAD or GET and translate the result into a stable
 * status string ("200", "404", "TIMEOUT", "DNS_FAIL", "CONN_ERR",
 * "SSL_ERR", or "ERROR"). Never throws.
 * @param {string} url
 * @param {string} method - 'HEAD' or 'GET'
 * @returns {Promise<string>}
 */
async function fetchStatus(url, method) {
  try {
    const response = await axios.request({ ...axiosConfig, url, method });
    return String(response.status);
  } catch (err) {
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
      return 'TIMEOUT';
    }
    if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return 'DNS_FAIL';
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return 'CONN_ERR';
    if (
      err.code === 'CERT_HAS_EXPIRED' ||
      err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    ) {
      return 'SSL_ERR';
    }
    return 'ERROR';
  }
}

/**
 * Validate a URL: HEAD first, fall back to GET on 405 / 403 (many .edu
 * sites refuse HEAD). Returns the status string. Does not persist.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function validateUrl(url) {
  let status = await fetchStatus(url, 'HEAD');
  if (status === '405' || status === '403') {
    status = await fetchStatus(url, 'GET');
  }
  return status;
}

/**
 * Check-mode wrapper: validate one program's URL and write the result
 * to programs.url_status + programs.url_checked_at.
 * @param {{ id: string, program_url: string }} program
 * @returns {Promise<string>} - the status string that was persisted
 */
async function validateOneUrl(program) {
  const status = await validateUrl(program.program_url);

  const checkedAt = new Date().toISOString();
  const { error } = await supabase
    .from('programs')
    .update({ url_status: status, url_checked_at: checkedAt })
    .eq('id', program.id);

  if (error) {
    logger.warn('Failed to persist url_status', {
      program_id: program.id,
      error: error.message,
    });
  }

  return status;
}

// ==========================================================
// HELPER FUNCTIONS — BRAVE SEARCH
// ==========================================================

/**
 * Call Brave Web Search. Returns up to BRAVE_TOP_N results as
 * `[{ url, title, description }]`. Retries once on 429 with a
 * BRAVE_RETRY_DELAY_MS backoff. Fatal `process.exit(1)` on 401.
 * Warns and returns empty array on 5xx / other non-200 / network error.
 * @param {string} query
 * @param {string} apiKey
 * @returns {Promise<Array<{ url: string, title: string, description: string }>>}
 */
async function searchBrave(query, apiKey) {
  const request = () =>
    axios.get(BRAVE_ENDPOINT, {
      params: { q: query, count: BRAVE_TOP_N },
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json',
      },
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true,
    });

  let response;
  try {
    response = await request();
  } catch (err) {
    logger.warn('Brave search network error', { query, error: err.message });
    return [];
  }

  // 429 — wait BRAVE_RETRY_DELAY_MS and retry once
  if (response.status === 429) {
    logger.warn('Brave search 429 — retrying after 5s', { query });
    await new Promise(r => setTimeout(r, BRAVE_RETRY_DELAY_MS));
    try {
      response = await request();
    } catch (err) {
      logger.warn('Brave search retry network error', { query, error: err.message });
      return [];
    }
  }

  if (response.status === 401) {
    logger.error('Brave search 401 — invalid API key, exiting', { query });
    process.exit(1);
  }

  if (response.status >= 500) {
    logger.warn('Brave search 5xx — returning empty results', {
      query,
      status: response.status,
    });
    return [];
  }

  if (response.status !== 200) {
    logger.warn('Brave search non-200', { query, status: response.status });
    return [];
  }

  const results = response.data?.web?.results || [];
  return results.slice(0, BRAVE_TOP_N).map(r => ({
    url: r.url,
    title: r.title || '',
    description: r.description || '',
  }));
}

/**
 * Fetch a URL and extract `<title>` plus the first PAGE_CONTENT_CHARS
 * of cleaned body text (scripts / styles / nav / header / footer
 * stripped). Returns `{ title: '', content: '' }` on any failure.
 * @param {string} url
 * @returns {Promise<{ title: string, content: string }>}
 */
async function fetchPageContent(url) {
  try {
    const response = await axios.get(url, {
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: HTTP_HEADERS,
      responseType: 'text',
    });

    if (response.status >= 400 || !response.data) {
      return { title: '', content: '' };
    }

    const html = String(response.data);
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, noscript').remove();

    const title = ($('title').first().text() || '').trim().substring(0, 200);
    const content = ($('body').text() || '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, PAGE_CONTENT_CHARS);

    return { title, content };
  } catch (err) {
    logger.warn('Failed to fetch page content', { url, error: err.message });
    return { title: '', content: '' };
  }
}

// ==========================================================
// HELPER FUNCTIONS — SONNET
// ==========================================================

/**
 * Build the tiered Sonnet prompt with all candidate context.
 * @param {object} program - row from get_programs_for_url_backfill RPC
 * @param {Array<object>} candidates - each has url, title, description, pageTitle, pageContent
 * @returns {string}
 */
function buildSonnetPrompt(program, candidates) {
  const candidateBlocks = candidates
    .map((c, i) =>
      `[CANDIDATE ${i + 1}]
URL: ${c.url}
Page title: ${c.pageTitle}
Search snippet: ${c.description}
Page content excerpt: ${c.pageContent}`
    )
    .join('\n\n');

  return `You are matching a university program to its official URL.

Program to match:
- Program name: ${program.program_name}
- University: ${program.university_name}
- City: ${program.university_city}
- Country: ${program.university_country}
- University main website: ${program.university_website}

Below are candidate URLs returned by web search. Each has been verified to return HTTP 200. For each, you can see the page title, search snippet, and an excerpt of the page content.

Your task: Identify the best URL match for this program. You have three options:

TIER_1 — Exact program page:
A URL that is the dedicated page for THIS specific program (matches program name precisely, includes program-specific details like modules, fees, entry requirements, or application info).

TIER_2 — Department or subject page:
A URL on the university's own domain that lists or describes this subject area but is NOT a specific program page. Examples: "/study/subjects/law", "/department/computer-science", "/courses/business". This is a fallback when no specific program page exists in the candidates.

NONE — No match:
The candidates contain nothing on the university's own domain that matches this program area (e.g., only aggregator/third-party sites).

Rules:
1. The URL MUST be on the university's own domain (matches or is a subdomain of ${program.university_website}).
2. For TIER_1, the page must be specifically about this program — the same program name, degree level, and subject area.
3. For TIER_2, the page must be about the same subject area but more general (subject list, department page, course catalog).
4. NEVER pick the university homepage as TIER_1 or TIER_2.
5. If multiple TIER_1 candidates exist, prefer the most recent / most authoritative looking one.

Candidates:
${candidateBlocks}

Respond in EXACTLY this format on one line:
TIER_1: <url>
OR
TIER_2: <url>
OR
NONE

No explanation. No other text. Just the tier and URL, or NONE.`;
}

/**
 * Parse a tiered Sonnet response. Returns `{ url, tier }` where tier
 * is 1 or 2, or `{ url: null, tier: null }` for NONE / malformed.
 * @param {string} text - raw Sonnet response (after trim)
 * @returns {{ url: string|null, tier: number|null }}
 */
function parseSonnetTieredResponse(text) {
  if (!text) return { url: null, tier: null };
  const tierMatch = text.match(/TIER_([12])\s*:\s*(https?:\/\/\S+)/i);
  if (!tierMatch) return { url: null, tier: null };
  const tier = Number(tierMatch[1]);
  const url = tierMatch[2].replace(/[.,;:)\]"]+$/, ''); // trim trailing punctuation
  return { url, tier };
}

/**
 * Ask Sonnet to classify the best candidate as TIER_1 / TIER_2 / NONE.
 * Returns `{ url, tier }` — both null on NONE / malformed. Fatal exit
 * on Anthropic 401. Warns and returns `{ null, null }` on other errors.
 * @param {Anthropic} anthropic - SDK client
 * @param {object} program
 * @param {Array<object>} candidates
 * @param {boolean} verbose - if true, log the raw Sonnet text before parsing
 * @returns {Promise<{ url: string|null, tier: number|null }>}
 */
async function pickBestUrlWithSonnet(anthropic, program, candidates, verbose = false) {
  const prompt = buildSonnetPrompt(program, candidates);

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: SONNET_MAX_TOKENS,
      temperature: SONNET_TEMPERATURE,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content?.find(b => b.type === 'text');
    if (!textBlock) return { url: null, tier: null };
    const text = (textBlock.text || '').trim();

    if (verbose) {
      logger.info('Sonnet raw response', {
        program_id: program.program_id,
        raw: text,
      });
    }

    return parseSonnetTieredResponse(text);
  } catch (err) {
    if (err?.status === 401 || /authentication/i.test(err?.message || '')) {
      logger.error('Anthropic auth failure — exiting', { error: err.message });
      process.exit(1);
    }
    logger.warn('Sonnet API error', {
      program_id: program.program_id,
      error: err.message,
    });
    return { url: null, tier: null };
  }
}

// ==========================================================
// HELPER FUNCTIONS — DB PERSISTENCE
// ==========================================================

/**
 * Persist the backfill outcome on a single program row. Always stamps
 * `url_backfill_at` with the current time.
 * @param {string} programId
 * @param {object} fields - any columns to update on `programs`
 * @returns {Promise<void>}
 */
async function persistBackfill(programId, fields) {
  const { error } = await supabase
    .from('programs')
    .update({ ...fields, url_backfill_at: new Date().toISOString() })
    .eq('id', programId);
  if (error) {
    logger.warn('Failed to persist url_backfill_status', {
      program_id: programId,
      error: error.message,
    });
  }
}

// ==========================================================
// MODE: CHECK
// ==========================================================

/**
 * Run the HTTP-only check mode. With --retry-failed, only re-validates
 * programs whose url_status is currently in FAILED_STATUSES.
 * @returns {Promise<void>}
 */
async function runCheckMode() {
  const country = config.crawler.country;
  const retryFailed = process.argv.includes('--retry-failed');
  const rpcName = retryFailed
    ? 'get_programs_with_failed_urls'
    : 'get_programs_with_distinct_urls';

  logger.info('Program URL validator v3 starting', {
    country,
    mode: 'check',
    sub_mode: retryFailed ? 'retry_failed' : 'full',
    concurrency: CHECK_CONCURRENCY,
    timeout_ms: HTTP_TIMEOUT_MS,
    rpc: rpcName,
    failed_statuses: retryFailed ? FAILED_STATUSES : undefined,
  });

  const { data, error } = await supabase
    .rpc(rpcName, { p_country: country })
    .range(0, RPC_MAX_ROWS - 1);

  if (error) {
    logger.error(`RPC ${rpcName} failed`, { error: error.message });
    return;
  }

  const programs = data || [];

  if (programs.length === 0) {
    logger.info('No program URLs to validate', {
      country,
      sub_mode: retryFailed ? 'retry_failed' : 'full',
    });
    logNextStepHint(
      'CHECK COMPLETE — Next step: run backfill mode',
      'Update Railway start command to:',
      `node scripts/runWorker.js validate_urls --country="${country}" --mode=backfill`,
    );
    return;
  }

  if (programs.length === RPC_MAX_ROWS) {
    logger.warn('Hit RPC_MAX_ROWS cap — there may be more programs than fetched', {
      country,
      returned: programs.length,
      cap: RPC_MAX_ROWS,
    });
  }

  logger.info('Programs to validate', { country, total: programs.length });

  const limit = pLimit(CHECK_CONCURRENCY);
  const tally = new Map();
  let completed = 0;

  const tasks = programs.map(prog =>
    limit(async () => {
      const status = await validateOneUrl(prog);
      tally.set(status, (tally.get(status) || 0) + 1);
      completed++;
      if (completed % PROGRESS_INTERVAL === 0) {
        logger.info('URL validation progress', {
          country,
          completed,
          total: programs.length,
          percent: ((completed / programs.length) * 100).toFixed(1),
        });
      }
    })
  );

  await Promise.all(tasks);

  // Sort tally by count descending for log readability
  const statusBreakdown = Object.fromEntries(
    [...tally.entries()].sort((a, b) => b[1] - a[1])
  );

  logger.success('Program URL validation complete', {
    country,
    total: completed,
    statusBreakdown,
  });

  logNextStepHint(
    'CHECK COMPLETE — Next step: run backfill mode',
    'Update Railway start command to:',
    `node scripts/runWorker.js validate_urls --country="${country}" --mode=backfill`,
  );
}

// ==========================================================
// MODE: BACKFILL
// ==========================================================

/**
 * Run the Brave + Sonnet backfill mode. With --retry-not-found, uses
 * `get_programs_for_url_retry` to target programs that landed on
 * homepage fallback or invalid in a previous backfill run.
 * @returns {Promise<void>}
 */
async function runBackfillMode() {
  const country = config.crawler.country;
  const braveKey = process.env.BRAVE_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!braveKey) {
    logger.error('BRAVE_API_KEY is not set — required for backfill mode');
    process.exit(1);
  }
  if (!anthropicKey) {
    logger.error('ANTHROPIC_API_KEY is not set — required for backfill mode');
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // --retry-not-found switches to the post-run RPC that targets programs
  // still missing a real URL after a previous backfill pass.
  const retryNotFound = process.argv.includes('--retry-not-found');
  const rpcName = retryNotFound
    ? 'get_programs_for_url_retry'
    : 'get_programs_for_url_backfill';

  /**
   * Emit the appropriate next-step block. After a non-retry backfill,
   * point operator to the retry pass. After a retry pass, point to the
   * next country.
   */
  const emitBackfillNextStep = () => {
    if (retryNotFound) {
      logNextStepHint(
        `${country.toUpperCase()} COMPLETE`,
        'All programs have URLs (tier 1, 2, or 3). Move to next country.',
        'Update Railway start command to:',
        'node scripts/runWorker.js validate_urls --country="NEXT_COUNTRY" --mode=check',
        '(Replace NEXT_COUNTRY with: Germany, India, USA, or whichever is next)',
      );
    } else {
      logNextStepHint(
        'BACKFILL COMPLETE — Next step: run retry on not_found/invalid',
        'Update Railway start command to:',
        `node scripts/runWorker.js validate_urls --country="${country}" --mode=backfill --retry-not-found`,
      );
    }
  };

  const startMs = Date.now();

  const { data, error } = await supabase
    .rpc(rpcName, { p_country: country })
    .range(0, RPC_MAX_ROWS - 1);

  if (error) {
    logger.error(`RPC ${rpcName} failed`, { error: error.message });
    return;
  }

  const programs = data || [];

  if (programs.length === 0) {
    logger.info('No programs need URL backfill', { country, retry: retryNotFound });
    emitBackfillNextStep();
    return;
  }

  if (programs.length === RPC_MAX_ROWS) {
    logger.warn('Hit RPC_MAX_ROWS cap — there may be more programs than fetched', {
      country,
      returned: programs.length,
      cap: RPC_MAX_ROWS,
    });
  }

  logger.info('URL backfill v3 starting', {
    country,
    total: programs.length,
    mode: 'backfill',
    retry: retryNotFound,
    rpc: rpcName,
    concurrency: BACKFILL_CONCURRENCY,
    model: ANTHROPIC_MODEL,
  });

  const counters = { tier1: 0, tier2: 0, tier3: 0, invalid: 0 };
  let completed = 0;

  /**
   * Tier-3 fallback: save the university homepage as the program URL
   * WITHOUT HTTP-validating it. Many university homepages sit behind
   * Cloudflare bot protection that 403s our server-side HEAD/GET
   * requests but serves fine to browsers — validating here caused ~270
   * false-negative invalid_candidate rows on UK alone. The homepage was
   * already validated during enrichment, so we trust it. The source tag
   * `homepage_fallback_unchecked` makes the audit trail explicit.
   *
   * The only failure mode is a missing/empty university_website, which
   * the RPC already filters out — included here as a defensive belt.
   */
  async function tryHomepageFallback(program, candidatesCount) {
    const now = new Date().toISOString();
    const homepage = program.university_website;

    if (!homepage || !String(homepage).trim()) {
      await persistBackfill(program.program_id, {
        url_backfill_status: 'invalid_candidate',
        url_backfill_tier: null,
        url_backfill_candidates_count: candidatesCount,
      });
      counters.invalid++;
      return;
    }

    await persistBackfill(program.program_id, {
      program_url: homepage,
      url_status: '200', // trusted from enrichment, not re-checked here
      url_checked_at: now,
      url_backfill_status: 'replaced',
      url_backfill_source: 'homepage_fallback_unchecked',
      url_backfill_tier: 3,
      url_backfill_candidates_count: candidatesCount,
    });
    counters.tier3++;
  }

  /**
   * Per-program backfill flow with tiered fallback.
   * @param {object} program - row from the backfill RPC
   * @param {number} index - 0-based position among programs (for verbose log gating)
   */
  async function processOne(program, index) {
    const verbose = index < DETAIL_LOG_LIMIT;
    let validCandidatesCount = 0;
    try {
      // 1. Brave search
      const query = `${program.program_name} ${program.university_name}`;
      const braveResults = await searchBrave(query, braveKey);

      if (verbose) {
        logger.info('Brave search', {
          query,
          results_count: braveResults.length,
        });
      }

      // 2. No Brave results → homepage fallback
      if (braveResults.length === 0) {
        await tryHomepageFallback(program, 0);
        return;
      }

      // 3. HTTP-validate top VALIDATE_TOP_N candidates, keep 200s
      const topCandidates = braveResults.slice(0, VALIDATE_TOP_N);
      const statuses = await Promise.all(
        topCandidates.map(c => validateUrl(c.url))
      );
      const validCandidates = topCandidates.filter(
        (_c, i) => statuses[i] === '200'
      );
      validCandidatesCount = validCandidates.length;

      if (verbose) {
        logger.info('URL validation', {
          kept: validCandidates.length,
          total: topCandidates.length,
        });
      }

      // 4. No valid candidates after HTTP check → homepage fallback
      if (validCandidates.length === 0) {
        await tryHomepageFallback(program, 0);
        return;
      }

      // 5. Fetch page content for each surviving candidate
      const pageContents = await Promise.all(
        validCandidates.map(c => fetchPageContent(c.url))
      );
      const candidatesForSonnet = validCandidates.map((c, i) => ({
        url: c.url,
        title: c.title,
        description: c.description,
        pageTitle: pageContents[i].title,
        pageContent: pageContents[i].content,
      }));

      // 6. Sonnet classifies into TIER_1 / TIER_2 / NONE
      const { url: pickedUrl, tier: pickedTier } = await pickBestUrlWithSonnet(
        anthropic,
        program,
        candidatesForSonnet,
        verbose
      );

      if (verbose) {
        logger.info('Sonnet picked', {
          picked: pickedUrl || 'NONE',
          tier: pickedTier,
        });
      }

      // 7. Sonnet returned NONE → homepage fallback
      if (!pickedUrl) {
        await tryHomepageFallback(program, validCandidates.length);
        return;
      }

      // 8. Defense-in-depth final HTTP check → fallback on failure
      const finalStatus = await validateUrl(pickedUrl);
      if (finalStatus !== '200') {
        await tryHomepageFallback(program, validCandidates.length);
        return;
      }

      // 9. Success — save with picked tier (1 or 2)
      const now = new Date().toISOString();
      await persistBackfill(program.program_id, {
        program_url: pickedUrl,
        url_status: '200',
        url_checked_at: now,
        url_backfill_status: 'replaced',
        url_backfill_source: 'brave+sonnet',
        url_backfill_tier: pickedTier,
        url_backfill_candidates_count: validCandidates.length,
      });

      if (pickedTier === 1) counters.tier1++;
      else counters.tier2++;
    } catch (err) {
      logger.warn('Backfill failed for program', {
        program_id: program.program_id,
        program_name: program.program_name,
        error: err.message,
      });
      counters.invalid++;
      try {
        await persistBackfill(program.program_id, {
          url_backfill_status: 'error',
          url_backfill_tier: null,
          url_backfill_candidates_count: validCandidatesCount,
        });
      } catch (_persistErr) {
        // already logged by persistBackfill
      }
    }
  }

  // Process in chunks of BACKFILL_CONCURRENCY with BATCH_DELAY_MS between
  for (let i = 0; i < programs.length; i += BACKFILL_CONCURRENCY) {
    const chunk = programs.slice(i, i + BACKFILL_CONCURRENCY);
    await Promise.all(chunk.map((p, j) => processOne(p, i + j)));
    completed += chunk.length;

    if (completed % 50 < BACKFILL_CONCURRENCY) {
      logger.info('URL backfill progress', {
        completed,
        total: programs.length,
        country,
        tier1: counters.tier1,
        tier2: counters.tier2,
        tier3: counters.tier3,
        invalid: counters.invalid,
      });
    }

    if (i + BACKFILL_CONCURRENCY < programs.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const durationSeconds = Math.round((Date.now() - startMs) / 1000);

  logger.success('URL backfill complete', {
    country,
    tier1: counters.tier1,
    tier2: counters.tier2,
    tier3: counters.tier3,
    invalid: counters.invalid,
    total: programs.length,
    duration_seconds: durationSeconds,
    mode: 'backfill',
    retry: retryNotFound,
  });

  emitBackfillNextStep();
}

// ==========================================================
// ENTRY POINT
// ==========================================================

/**
 * Parse --mode from process.argv. Defaults to 'check'. Exits with
 * code 1 if the value isn't recognised.
 * @returns {'check'|'backfill'}
 */
function parseMode() {
  const modeArg = process.argv.find(a => a.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'check';
  if (mode !== 'check' && mode !== 'backfill') {
    logger.error('Invalid --mode value', {
      received: mode,
      valid: ['check', 'backfill'],
    });
    process.exit(1);
  }
  return mode;
}

/**
 * Worker entry point — dispatched from scripts/runWorker.js.
 * @returns {Promise<void>}
 */
export async function runProgramUrlValidatorV3() {
  const mode = parseMode();
  if (mode === 'backfill') {
    await runBackfillMode();
  } else {
    await runCheckMode();
  }
}

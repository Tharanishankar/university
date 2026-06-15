# University DB Crawler

Autonomous crawler that builds a comprehensive database of Indian universities.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Run Supabase migration: paste `supabase/migrations/001_initial_schema.sql` into Supabase SQL editor
3. Install dependencies: `npm install`

## Running locally (test mode — 5 universities only)

npm run seed -- --test
npm run crawl -- --test

## Running full crawl

npm run seed    # builds seed list first (~3-4 hours)
npm run crawl   # then run all workers

## Railway deployment

Push to GitHub. Railway auto-deploys all 4 workers.
Add all .env variables to each Railway service under Variables tab.

## Queue status

Check crawler_queue table in Supabase for progress.

## URL health check (`validate_urls`)

After programs are populated, run this worker to validate and (if
needed) backfill every `program_url`. The worker has two modes and a
two-pass backfill — driven by CLI flags — that together guarantee every
active program ends up with a working URL.

### Per-country workflow

Three commands per country, run in order. After each step the worker
prints a `=== NEXT STEP ===` block telling the operator what command
to run next; update the Railway service start command accordingly.

```bash
# 1. Check — HEAD/GET every program_url, write url_status
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=check

# 2. Backfill — for broken/missing URLs, Brave + Sonnet find a replacement
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=backfill

# 3. Retry — re-attempt only programs that fell back to homepage or stayed invalid
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=backfill --retry-not-found
```

After step 3, every active program with a non-null `universities.website`
has `programs.program_url` populated (tier 1, 2, or 3).

### Mode: `--mode=check` (default)

Validates each program's existing `program_url` and writes the status.

```bash
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=check
```

What it does:

- Calls the `get_programs_with_distinct_urls(p_country)` RPC to fetch
  programs whose `program_url` is set and not the same as
  `universities.website`, scoped to one active country.
- Sends an `HTTP HEAD` request to each URL (10s timeout, 20 concurrent
  via `p-limit`).
- Falls back to `GET` if HEAD returns `405` (Method Not Allowed) or
  `403` (Forbidden) — many .edu sites block HEAD.
- Writes the outcome to `programs.url_status` and
  `programs.url_checked_at`.
- Logs progress every 100 URLs and a final summary tally.

**Interpreting `url_status`:**

| Value | Meaning |
|---|---|
| `200`, `301`, `302`, `404`, `500`, ... | HTTP response code as text |
| `TIMEOUT` | Server did not respond within 10s |
| `DNS_FAIL` | Could not resolve hostname |
| `CONN_ERR` | Connection refused / reset by peer |
| `SSL_ERR` | Expired or invalid certificate |
| `ERROR` | Other network or HTTP-client error |

**Retry only previously-failed URLs:**

```bash
node scripts/runWorker.js validate_urls --country="United Kingdom" --retry-failed
```

With `--retry-failed`, the worker calls `get_programs_with_failed_urls`
instead of the default RPC and only re-validates programs whose
`url_status` is currently one of: `403`, `404`, `TIMEOUT`, `ERROR`,
`500`, `400`. Use this after fixing a UA / network issue without
redoing the rows that already returned `200`.

Run prerequisites: migrations `005_add_program_url_status.sql` and
`006_add_failed_url_rpc.sql` must both be applied (the latter is only
needed for `--retry-failed`).

Supported `--country` values: `Germany`, `United Kingdom`, `USA`, `India`
(must match `universities.country` exactly — quote the multi-word value:
`--country="United Kingdom"`).

### Backfill mode (`--mode=backfill`)

For programs whose URL is broken (404, 403, 500, TIMEOUT, etc.),
missing, or accidentally set to the university's homepage, run the
backfill pipeline to find the correct program URL using Brave Search
+ Anthropic Sonnet.

```bash
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=backfill
```

Pipeline per program (tiered):

1. Search Brave for `{program_name} {university_name}` (top 10 results)
2. HTTP-validate the top 5 candidates (HEAD + GET fallback, must return 200)
3. Fetch HTML for surviving candidates and extract title + 1500-char body excerpt
4. Send candidate set to Sonnet (`claude-sonnet-4-5`, `max_tokens: 200`, `temperature: 0`). Sonnet classifies into one of three outcomes:
   - **TIER_1** — exact dedicated program page
   - **TIER_2** — department or subject page on the university's own domain
   - **NONE** — nothing on the university's domain matches the program area
5. If TIER_1 or TIER_2: defense-in-depth HTTP-validate Sonnet's pick (must be 200)
6. If validation passes: save `program_url` with `url_backfill_tier=1` or `2` and `url_backfill_source='brave+sonnet'`
7. **Tier-3 homepage fallback** — fires when: Brave returns nothing, no candidates survive HTTP validation, Sonnet returns NONE, or Sonnet's pick fails the final HTTP check. We then write `program_url = universities.website` with `url_backfill_tier=3` and `url_backfill_source='homepage_fallback_unchecked'`. **Tier 3 URLs are saved without HTTP validation** because many university homepages use Cloudflare bot protection that blocks server-side checks. The URLs are still valid for browser access — we trust the homepage was already validated during enrichment. The intent is that no active university with a valid homepage leaves any program with a null `program_url`.

**Retry programs that fell back to homepage or stayed invalid:**

```bash
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=backfill --retry-not-found
```

`--retry-not-found` calls the `get_programs_for_url_retry` RPC (migration 008) instead of the default. Use this after a first backfill pass to re-attempt the long tail using fresh Brave indexes or after fixing search-quality issues — programs that landed on tier 3 or invalid get another shot.

**Required env vars (in addition to the Supabase ones):**

| Variable | Purpose |
|---|---|
| `BRAVE_API_KEY` | Brave Web Search subscription token |
| `ANTHROPIC_API_KEY` | Anthropic API key for Sonnet |

Auth failure on either (`401` from Brave, `401` / auth error from Anthropic) is fatal — the worker exits. All other errors are logged per-program and the batch continues.

**`url_backfill_status` values:**

| Value | Meaning |
|---|---|
| `replaced` | A URL was written. Use `url_backfill_tier` to tell which tier produced it. |
| `invalid_candidate` | Brave hits AND homepage all failed HTTP validation — program left without a URL. |
| `error` | Per-program exception (e.g. Brave 5xx, page fetch crash) — see logs. |

**`url_backfill_tier` values (only set when `url_backfill_status='replaced'`):**

| Tier | Source | Meaning |
|---|---|---|
| `1` | `brave+sonnet` | Exact dedicated program page on the university's domain |
| `2` | `brave+sonnet` | Department / subject page on the university's domain (program-list level) |
| `3` | `homepage_fallback_unchecked` | University homepage — used when no Sonnet match survived. **Not HTTP-validated** (Cloudflare false-negative avoidance — see pipeline step 7). |
| `null` | — | Status is `invalid_candidate` or `error` |

**Approximate cost per URL:**

- Brave Search: ~$0.005
- Sonnet (1k input + 100 output tokens): ~$0.015
- ≈ **$0.02 per program** at current pricing. For ~2k UK programs this is ~$40.

**Concurrency:** 5 programs in parallel, 200ms between batches → ~25 programs/sec ceiling (well under Brave's 50/sec quota).

Run prerequisites: migrations `007_add_url_backfill_tracking.sql` and
`008_add_url_backfill_tier.sql` must both be applied. 007 adds the four
`url_backfill_*` columns and the `get_programs_for_url_backfill` RPC.
008 adds `url_backfill_tier` and the `get_programs_for_url_retry` RPC
(used by `--retry-not-found`).

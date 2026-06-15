# University Database — Build Guide

> Audience: engineers running the crawler to populate the Supabase database
> for Dream-Vantage. This document covers **what each component does, when
> to run it, why, and which DB fields it writes.** No code changes required —
> the repo is already wired. Follow the operational sequence below.

---

## 1. What this is

The `university-db-crawler` is a pipeline that turns a country name into
a fully-enriched Supabase database of universities, programs, fees,
admission requirements, entrance tests, intake stats, campuses, and
HTTP-validated program URLs.

It is the **upstream data system** for Dream-Vantage. Dream-Vantage queries
this DB; this crawler is the only thing that writes to it.

Active in production: `Germany`, `United Kingdom`, `USA`, `India`.

---

## 2. Quick-start for a new country

```bash
# 1. Set env vars (Railway service Variables tab or .env locally)
#    PERPLEXITY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
#    CRAWLER_COUNTRY=India (or Germany / "United Kingdom" / USA)

# 2. Run migrations once per Supabase instance (paste into SQL Editor)
#    001_initial_schema.sql → 002 → 003 → 004 → 005 → 006 → 007 → 008
#    Plus: alter table admission_requirements add column if not exists is_estimated boolean default false;

# 3. Run the data pipeline in this exact order:
node scripts/runWorker.js seed_v3              --country=India   # ~30-60 min
node scripts/runWorker.js gap_finder_v3        --country=India   # ~5-10 min
node scripts/runWorker.js enricher_v3          --country=India   # hours (long-running)
node scripts/runWorker.js program_backfill_v3  --country=India   # if many unis have 0 programs
node scripts/runWorker.js admission_backfill_v3 --country=India  # final pass for admission gaps

# 4. Run the URL phase (three commands, in order):
node scripts/runWorker.js validate_urls --country=India --mode=check                       # HTTP-check every program_url
node scripts/runWorker.js validate_urls --country=India --mode=backfill                    # Brave+Sonnet for broken/missing URLs
node scripts/runWorker.js validate_urls --country=India --mode=backfill --retry-not-found  # retry homepage-fallback / invalid rows
```

Every v3 worker requires `--country=<Germany|"United Kingdom"|USA|India>` — it exits
immediately with a clear error otherwise.

---

## 3. Pipeline architecture

```
                ┌─────────────────────────────────────────┐
                │  Wikipedia API (no key, public)         │
                │  Perplexity API (sonar-pro, paid)       │
                └──────────────┬──────────────────────────┘
                               │
   ┌───────────────────────────┼───────────────────────────┐
   │                           │                           │
   ▼                           ▼                           ▼
PHASE 1A                  PHASE 1B                    PHASE 2
seed_v3                   gap_finder_v3              enricher_v3
─────────                 ─────────────              ──────────
Wikipedia →               Perplexity →               crawler_queue
crawler_queue             crawler_queue              → universities
                                                     → programs
                                                     → tuition_fees
                                                     → admission_requirements
                                                     → entrance_tests
                                                     → campuses
                                                     → intake_stats

                                                            │
                                                            ▼
                                                     PHASE 3 (BACKFILLS)
                                                     ─────────────────────
                                                     program_backfill_v3
                                                     admission_backfill_v3

                                                            │
                                                            ▼
                                                     PHASE 4 (URL HEALTH)
                                                     ─────────────────────
                                                     validate_urls --mode=check       (HTTP HEAD/GET)
                                                     validate_urls --mode=backfill    (Brave + Sonnet)
                                                     validate_urls --mode=backfill
                                                                   --retry-not-found  (long-tail retry)
                                                     → programs.url_status
                                                     → programs.url_backfill_status / tier / source
                                                     → programs.program_url (replaced when needed)
```

Each phase reads its inputs from the previous phase's outputs. They do
not run concurrently for the same country — finish one before starting
the next.

---

## 4. Database schema

All tables live in the Supabase `public` schema. UUIDs are generated by
the DB; the crawler never assigns IDs.

### `universities` — the master entity

Primary unique key: `(name, country)`.

| Column | Type | Written by | Purpose |
|---|---|---|---|
| `id` | uuid PK | DB | Internal join key |
| `name` | text | seed_v3 → enricher_v3 | Official university name |
| `country` | text | seed_v3 → enricher_v3 | Germany / United Kingdom / USA / India |
| `state` | text | seed_v3 → enricher_v3 | Bundesland / nation / state |
| `city` | text | enricher_v3 | Main campus city (Perplexity) |
| `type` / `institution_type` | text | enricher_v3 | e.g. `russell_group`, `iit`, `fachhochschule` |
| `website` | text | enricher_v3 | Official URL |
| `accreditation_body` | text | enricher_v3 | UGC, AQAS, QAA, HLC, etc. |
| `naac_grade` | text | enricher_v3 | Repurposed: accreditation_status / tef_rating / NAAC |
| `global_tier` | integer 1-4 | enricher_v3 | Quality tier (see §7 for semantics) — **used by Dream-Vantage** |
| `validation_status` | text | enricher_v3 | `validated` / `rejected_pattern` / `rejected_perplexity` |
| `crawl_status` | text | enricher_v3 | `pending` / `done` / `rejected` / `failed` |
| `is_active` | boolean | enricher_v3 | `false` for rejected unis (kept for audit) |
| `notes` | text | enricher_v3 | Rejection reason, or tier reasoning |
| `affiliated_to` | text | enricher_v3 | Parent uni (for affiliated colleges) |
| `apply_through` | text | enricher_v3 | UCAS, Common App, university portal URL |
| `can_apply_directly` | boolean | enricher_v3 | Whether students apply to the uni directly |
| `wikipedia_summary` | text | seed_v3 | First 500 chars of Wikipedia article |
| `last_verified` | timestamptz | enricher_v3 | When Perplexity last validated this row |
| `created_at` / `updated_at` | timestamptz | DB | Audit timestamps |

### `campuses` — multi-campus support

Unique: `(university_id, city, country)`.

`id`, `university_id` (FK), `name`, `city`, `state`, `country`,
`is_main_campus`, `website`, `created_at`.

### `programs` — degree programs

Unique: `(university_id, name, degree_level)`.

Core columns:
`id`, `university_id` (FK), `campus_id` (FK, optional), `name`,
`degree_level`, `field_of_study`, `duration_years`, `delivery_mode`,
`language_of_instruction`, `program_url`, `is_active`.

URL health columns (added by migrations 005 + 007):
`url_status`, `url_checked_at`, `url_backfill_status`, `url_backfill_at`,
`url_backfill_source`, `url_backfill_candidates_count`, `url_backfill_tier`.

- `url_status`: HTTP code as text (`'200'`, `'404'`...) or named error (`'TIMEOUT'`, `'DNS_FAIL'`, `'CONN_ERR'`, `'SSL_ERR'`, `'ERROR'`).
- `url_backfill_status`: `'replaced'` | `'invalid_candidate'` | `'error'`. Only set when the backfill mode has touched the row.
- `url_backfill_tier`: `1` (exact program page), `2` (department / subject page), `3` (homepage fallback, unchecked), or `null` (status is `invalid_candidate` / `error`).
- `url_backfill_source`: `'brave+sonnet'` (tier 1 / 2) or `'homepage_fallback_unchecked'` (tier 3).
- See §5 Phase 4 for the full pipeline.

### `tuition_fees`

Unique: `(program_id, student_category, academic_year)`.

`id`, `program_id` (FK), `student_category`, `annual_fee`, `currency`,
`academic_year`, `is_estimated`, `source`.

- `is_estimated`: `false` for real Perplexity data, `true` for peer-derived
- `source`: `'perplexity'` | `'peer_fallback'` | `'manual'` | `'estimated_default'`
- See §6 for the peer-fallback mechanics that produce `is_estimated=true` rows.

### `admission_requirements`

Unique: `(program_id, requirement_type, subject_group)`.

`id`, `program_id` (FK), `requirement_type`, `subject_group`,
`min_percentage`, `specific_subjects`, `notes`, `is_estimated`.

- `is_estimated`: `false` = Perplexity-verified, `true` = peer-estimated
- **No `source` column** — the two peer paths (`peer_fallback` from
  enricher_v3 vs `peer_augmented` from admission_backfill_v3) are only
  distinguishable in logs. See §6.1 for the note on adding a `source`
  column if you need analytic separation.

> ⚠️ `admission_requirements.is_estimated` is added manually outside
> the migrations. If you spin up a fresh DB, run:
> `alter table admission_requirements add column if not exists is_estimated boolean default false;`

### `entrance_tests`

Unique: `(program_id, test_name)`.

`id`, `program_id` (FK), `test_name`, `test_region`, `min_score`,
`is_mandatory`, `notes`.

### `intake_stats`

Unique: `(program_id, academic_year)`.

`id`, `program_id` (FK), `academic_year`, `total_seats`,
`applications_received`, `admissions_granted`.

### `crawler_queue` — internal job queue

`id`, `university_name`, `university_url`, `state`, `worker_type`
(`enricher_v3`), `status` (`pending` / `processing` / `done` / `failed`),
`priority`, `retry_count`, `error_message`, `metadata` (jsonb), `started_at`,
`completed_at`, `created_at`.

**`metadata` shape produced by seed_v3 / push_pending / gap_finder_v3:**
```json
{
  "country": "India",
  "city": "Mumbai",
  "wikipedia_summary": "...",
  "source": "gap_finder",                 // gap_finder only
  "gap_finder_type": "private_university", // gap_finder only
  "gap_finder_confidence": "high"          // gap_finder only
}
```

The enricher reads `country`, `city`, and `wikipedia_summary`. The other
fields are audit-only.

### `get_programs_needing_admission` (RPC, not a table)

PostgreSQL function called by `admission_backfill_v3`. Must exist before
that worker runs. Returns flat rows: `id, name, degree_level, field_of_study,
university_name, global_tier, country, institution_type`.

### URL phase RPCs

Four PostgreSQL functions called by `validate_urls`. All take a single
`p_country text` argument.

| Function | Migration | Caller | Returns |
|---|---|---|---|
| `get_programs_with_distinct_urls` | 005 | check, default | programs whose `program_url` is non-null AND ≠ `universities.website` |
| `get_programs_with_failed_urls` | 006 | check, `--retry-failed` | programs whose `url_status` is in (`403`, `404`, `400`, `405`, `500`, `TIMEOUT`, `ERROR`) |
| `get_programs_for_url_backfill` | 007 | backfill, default | programs with broken / missing / homepage-equivalent `program_url` |
| `get_programs_for_url_retry` | 008 | backfill, `--retry-not-found` | programs that landed on homepage fallback or `invalid_candidate` in a prior backfill pass |

All four also filter on `universities.is_active = true` and (for the
backfill RPCs) `universities.website is not null`.

---

## 5. Pipeline components — when and why

### Phase 1A: `seed_v3` — Wikipedia discovery

- **Source file:** `src/workers/seedBuilder_v3.js` + `src/wikipedia_v3.js`
- **When to run:** First. Once per country. Re-running is idempotent (duplicates skipped by name).
- **Why:** Cheap (free, Wikipedia API), broad coverage of well-known universities.
- **What it does:** For each region (state/Bundesland/nation), recurses
  the Wikipedia category tree up to 3 levels deep, filters titles against
  `nonUniversityPatterns.js` (rejects libraries, sports clubs, etc.),
  fetches the first paragraph of each article to extract city, and
  inserts one row per uni into `crawler_queue` with `worker_type='enricher_v3'`.
- **Writes:** `crawler_queue` only. **Does not touch `universities`.**
- **Typical output:** Germany ~500, United Kingdom ~200, USA ~1500-2000, India ~800-1000.
- **Polite delays:** 500ms after each category fetch, 1000ms after each summary fetch.

### Phase 1B: `gap_finder_v3` — Perplexity gap closure

- **Source file:** `src/workers/gapFinder_v3.js`
- **When to run:** After seed_v3 has finished. Catches institutions Wikipedia missed (private unis, specialist schools, business schools, recently-founded, names without "University" — e.g. Charité, Hertie, ESMT, ISB Hyderabad).
- **Why:** Wikipedia's categorisation is incomplete. ~10-20% of real universities are not in the expected categories.
- **What it does:** For each region, builds the existing list (from both `universities` and pending `crawler_queue` items) and asks Perplexity what's missing. If a region has zero existing unis (empty country), Perplexity is asked to list ALL universities in that region (cap 25).
- **Writes:** `crawler_queue` only. Adds `metadata.source='gap_finder'`.
- **Defensive filters:** Hallucinated names matching `nonUniversityPatterns` are rejected; Perplexity duplicates are deduped against the existing set.

### Phase 2: `enricher_v3` — the main worker

- **Source file:** `src/workers/enricher_v3.js` + `src/perplexity_v3.js`
- **When to run:** Continuously, while the queue has items. Long-running.
- **Why:** This is the only worker that writes to the main entity tables. Validates and enriches each candidate via Perplexity, assigns a `global_tier` (1-4), inserts everything downstream.
- **What it does (per queue item):**
  1. Pattern re-check (belt-and-suspenders against bad names that slipped in) — see §6
  2. Call Perplexity with a country-specific prompt (accreditation bodies, entrance tests, currency, degree examples, institution types — see §7)
  3. **Stage 2 validation:** Perplexity returns `is_valid_university: false` → mark as rejected, save row with `is_active=false` + `validation_status='rejected_perplexity'` + reason in `notes`
  4. **If valid:** insert/update `universities` row + `campuses` + `programs` (filtered through `isValidProgramName`, see §6) + `tuition_fees` + `entrance_tests` + `admission_requirements` + `intake_stats`
- **Writes:** Everything. This is the only worker that creates real entities.
- **Peer fallback behaviour (see §6 for full mechanics):**
  - `tuition_fees`: when Perplexity returns null or vague text → calls `findPeerFee()` → if peer found, inserts with `is_estimated=true, source='peer_fallback'`; else skips that fee
  - `admission_requirements`: when Perplexity returns null `min_percentage` → calls `findPeerAdmissionRequirement()` → if peer found, inserts with `is_estimated=true`; else skips that requirement
- **Rejection paths:**
  - Pattern match → `validation_status='rejected_pattern'`
  - Perplexity says no → `validation_status='rejected_perplexity'`
  - No website → marked failed in queue, uni saved with `is_active=false`
  - Network error → returned to queue with retry, eventually fails after `MAX_RETRIES`

### Phase 3a: `program_backfill_v3` — fix universities with 0 programs

- **Source file:** `src/workers/programBackfill_v3.js`
- **When to run:** After enricher_v3 finishes. Optional — only needed if you see universities with no associated programs.
- **Why:** Sometimes Perplexity returns valid uni data but a thin program list. This worker re-asks specifically for the program list (using the updated extraction prompt that requires specific names like "B.Sc. Computer Science" not just "Engineering").
- **What it writes:** Only `programs`, `tuition_fees`, `entrance_tests`, `admission_requirements` for the targeted unis. **Does not touch the universities row.**
- **Peer fallback behaviour: NONE — by design.** Unlike enricher_v3, this worker uses `isVague()` only to **filter out** unusable Perplexity entries; it does not substitute peer data. All inserted rows carry `is_estimated=false, source='perplexity'`. If you need peer-derived rows after this worker, run `admission_backfill_v3` afterwards.
- **Sort order:** By `global_tier ASC` then name — Tier 1 fixed first.

### Phase 3b: `admission_backfill_v3` — fix programs with 0 admission requirements

- **Source file:** `src/workers/admissionBackfill_v3.js`
- **When to run:** After program backfill. Optional but recommended — admission requirements are often the sparsest field after the initial enrich.
- **Why:** Per-program admission lookup is more targeted than the bulk enrich. Plus this worker has a **richer peer cascade** (see §6) than the enricher's peer fallback.
- **How:** Calls the `get_programs_needing_admission(p_country)` RPC, reshapes flat rows into the nested form the loop expects, then for each program:
  1. Ask Perplexity for international entry requirements with UCAS-points → percentage conversion baked into the prompt (e.g. `144pts = 85%`, `128pts = 75%`, `112pts = 65%`, `96pts = 55%`, `80pts = 45%`)
  2. Validate the response: `min_percentage` must be a finite number in `[0, 100]`
  3. If Perplexity returns valid → insert with `is_estimated=false, source='perplexity'` (no `source` column on this table, but the absence of `is_estimated` flags it as Perplexity-derived)
  4. If Perplexity returns null / invalid / out-of-range → fall through to peer cascade (see §6)
  5. If peer cascade also empty → log `source: 'skipped'`, leave the program without admission data
- **Final summary log:** `{ inserted_perplexity, inserted_peer, skipped, country }`
- **Flags:**
  - `--peer-only` — skips Perplexity entirely and goes straight to the peer cascade. Use this for re-runs after a full Perplexity pass has already burned API budget.
  - `--test` — caps run at 3 programs (from `config.crawler.testLimit`)

### Phase 4: `validate_urls` — URL health check + Brave/Sonnet backfill

- **Source file:** `src/workers/programUrlValidator_v3.js`
- **When to run:** After Phase 3 (admission backfill) is finished. Three commands, in order.
- **Why:** Many `program_url` values written by `enricher_v3` either point at the university homepage, a broken page, or a stale URL. This phase HTTP-validates every URL and, where needed, uses Brave Search + Anthropic Sonnet to find and replace the broken ones.
- **Two CLI modes** dispatched by `--mode`:

#### Mode A — `--mode=check` (default)

HTTP-validates the existing `program_url` for every program in the country and writes the result to `programs.url_status` + `programs.url_checked_at`.

- Uses HEAD with GET fallback on 405 / 403 (many .edu sites refuse HEAD)
- Concurrency: 20 in-flight requests via `p-limit`
- Timeout: 10 seconds per URL
- UA: standard Chrome desktop (`Mozilla/5.0 ... Chrome/120.0.0.0 ...`) — anything that identifies as a bot gets 403'd
- Flag: **`--retry-failed`** uses `get_programs_with_failed_urls` instead — re-validates only programs whose `url_status` is currently in (`403`, `404`, `400`, `405`, `500`, `TIMEOUT`, `ERROR`)
- Logs progress every 100 URLs and a final status-code tally
- Cost: free (no external API)

#### Mode B — `--mode=backfill`

For programs whose URL is broken, missing, or set to the university homepage, replaces it with a working URL via Brave + Sonnet.

Per-program pipeline:

1. **Brave search** for `{program_name} {university_name}` — top 10 results
2. **HTTP-validate** the top 5 candidates (HEAD/GET fallback, must return 200)
3. **Fetch page content** for survivors — extract `<title>` + first 1500 chars of cleaned body text
4. **Sonnet classifies** into one of three outcomes:
   - **TIER_1** — exact dedicated program page on the university's own domain
   - **TIER_2** — department / subject page on the university's own domain
   - **NONE** — nothing on the university's domain matches
5. **Final HTTP-validate** Sonnet's pick (defense in depth)
6. **Tier-3 homepage fallback** — fires when Brave returns nothing, no candidates survive HTTP validation, Sonnet returns NONE, or Sonnet's pick fails the final HTTP check. Writes `program_url = universities.website` with `url_backfill_tier=3` and `url_backfill_source='homepage_fallback_unchecked'`. **The homepage is NOT HTTP-validated** — Cloudflare bot protection produces ~270 false-negative 403s on UK alone. The homepage was already validated during enrichment, so we trust it.

- Concurrency: 5 programs in parallel, 200ms between chunks → ~25 programs/sec ceiling (well under Brave's 50/sec)
- Verbose logging for the first 5 programs: Brave query, validation kept-count, raw Sonnet response, picked tier
- Final summary: `{tier1, tier2, tier3, invalid, total, duration_seconds}`
- Flag: **`--retry-not-found`** uses `get_programs_for_url_retry` — targets only programs that landed on tier 3 / invalid in a previous backfill run
- Cost: ~$0.005 / URL Brave + ~$0.015 / URL Sonnet ≈ **$0.02 / program**. UK at ~2k programs ≈ $40.

#### Three-command workflow per country

After the data pipeline (Phases 1–3) finishes, run these three in order. The worker prints a `===` separator block at the end of each command telling the Railway operator exactly what to run next.

```bash
# Step 1 — check every program_url
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=check

# Step 2 — replace broken / missing URLs
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=backfill

# Step 3 — retry the long tail (homepage-fallback and invalid rows)
node scripts/runWorker.js validate_urls --country="United Kingdom" --mode=backfill --retry-not-found
```

After Step 3, every program belonging to an active university with a non-null `universities.website` has `programs.program_url` populated. Distribution will typically be tier 1 majority, with some tier 2 and tier 3.

#### Writes

- Mode A (check): `programs.url_status`, `programs.url_checked_at` only
- Mode B (backfill): `programs.program_url`, `url_status='200'`, `url_checked_at`, `url_backfill_status='replaced'`, `url_backfill_source`, `url_backfill_at`, `url_backfill_tier`, `url_backfill_candidates_count`

### Utility: `push_pending` — requeue stuck universities

- **Source file:** `scripts/pushPendingToQueue.js`
- **When to run:** If `universities.crawl_status = 'pending'` rows accumulate without making it into `crawler_queue` (e.g. after a manual import, or if seed_v3 was interrupted).
- **What it does:** Selects universities with `crawl_status='pending'` and `is_active=true`, inserts them into `crawler_queue` with the same metadata shape seed_v3 produces.
- **Writes:** `crawler_queue` only.

---

## 6. Data quality: source tags, `is_estimated`, peer fallback

Every fee row and every admission requirement row carries provenance
metadata so Dream-Vantage can decide whether to show a value with
confidence or flag it as estimated.

### 6.1 The four origin states

A row in `tuition_fees` or `admission_requirements` ends up in one of
four states:

| State | `is_estimated` | `source` (fees only) | Means | Who writes it |
|---|---|---|---|---|
| Real Perplexity data | `false` | `'perplexity'` | Verified from Perplexity search | enricher_v3, program_backfill_v3, admission_backfill_v3 |
| Peer-estimated (enricher path) | `true` | `'peer_fallback'` | Perplexity returned null/vague → averaged from similar tier+country+field+category | enricher_v3 |
| Peer-augmented (backfill path) | `true` | `'peer_augmented'` | Per-program backfill couldn't get Perplexity data → averaged from cascading peer match | admission_backfill_v3 |
| Skipped | (row not inserted) | — | Neither Perplexity nor peer could resolve | logged as `source: 'skipped'` |

> ⚠️ `admission_requirements` has `is_estimated` but **does NOT have a
> `source` text column** in the current schema. The two peer paths
> distinguish themselves only via log lines and the `is_estimated`
> flag. If you want analytic separation between `peer_fallback` and
> `peer_augmented` on admissions, add a `source text` column.

### 6.2 Filtering helpers

Three small utilities decide what's worth saving. All are pure
functions, no DB calls.

- **`isVague(value)`** — `src/utils/peerFallback.js`. Returns `true`
  for null, empty string, or text containing any of:
  `varies`, `depends`, `not available`, `not specified`, `unclear`,
  `tbd`, `n/a`. Used to reject useless Perplexity fee responses
  before saving and to trigger peer fallback in the enricher.

- **`isValidProgramName(name)`** — duplicated in `enricher_v3.js`,
  `programBackfill_v3.js`. Rejects programs whose name is shorter
  than 8 chars, is a single word, or matches a blocklist of generic
  category names (`engineering`, `science`, `arts`, `commerce`,
  `management`, `studies`, `humanities`, `programs`, `courses`, and
  variants like `ug courses`, `pg programs`, etc.).

- **`isNonUniversity(title)`** — `src/utils/nonUniversityPatterns.js`.
  ~46 regex patterns covering Wikipedia metadata pages (`Template:`,
  `List of`, `Category:`), libraries, student unions, sports clubs,
  museums, press, research institutes, plus 20 USA-specific sports
  patterns (`/^College sports/i`, `/ baseball$/i`, `/NCAA/i`, etc.).
  Applied at three points: (1) by `wikipedia_v3` while filtering
  category members, (2) by `gap_finder_v3` to reject Perplexity
  hallucinations, (3) by `enricher_v3` at the start of each queue
  item as a final safety check.

### 6.3 Peer fallback — three distinct paths

There are **three independent peer-matching implementations** in the
codebase. They differ in what they match on, how they cascade, and
what `source` they tag.

#### Path A — `findPeerFee()` (enricher_v3, tuition_fees)

In `src/utils/peerFallback.js`. Fires when Perplexity returns a
null or vague `annual_fee`.

- **Filters:** `country` + `global_tier` + `student_category` +
  fuzzy substring match on `field_of_study`
- **Source filter:** only rows where `is_estimated = false`
  (refuses to learn from its own estimates)
- **Computation:** mean of up to 50 matched rows, rounded to nearest integer
- **Insert tag:** `is_estimated=true, source='peer_fallback'`
- **No cascade.** If the field+tier+country combo has no matches,
  the fee is simply not inserted.

#### Path B — `findPeerAdmissionRequirement()` (enricher_v3, admission_requirements)

In `src/utils/peerFallback.js`. Fires when Perplexity returns null
`min_percentage` during the main enrich pass.

- **Filters:** `country` + `global_tier` + fuzzy field_of_study
- **No `is_estimated` filter** (no admission `source` column to
  filter on either)
- **Computation:** uses the first matched row's values, not an average
- **Insert tag:** `is_estimated=true`, notes string `"Estimated from N peer institutions in same tier"`
- **No cascade.**

#### Path C — `findPeerAdmissionAverage()` (admission_backfill_v3 only)

Defined inline in `src/workers/admissionBackfill_v3.js`. Fires when
the per-program backfill can't get usable Perplexity data, OR
unconditionally when run with `--peer-only`.

- **Three-tier cascade.** Tries the strictest match first; falls
  back to looser matches if the strict one returns nothing:
  1. **`tier_inst_group`** — country + global_tier + institution_type + degree_group
  2. **`tier_group`** — drops institution_type
  3. **`tier_only`** — drops both, just country + global_tier
- **Source filter:** only rows where `is_estimated = false`
- **Computation:** mean of up to 500 rows, **rounded to nearest 5**
- **Insert tag:** `is_estimated=true`, notes string `"Estimated — based on average of similar Tier {tier} {country} universities. Actual entry requirements not publicly available. Verify directly with the institution."`
- **In-process cache:** keyed by `${country}|${tier}|${institution_type}|${group_key}` to avoid repeat queries when many programs share the same peer cohort
- **Per-row log:** includes `match_level: 'tier_inst_group' | 'tier_group' | 'tier_only'` so you can audit which cascade tier resolved each row.

#### Degree groups used by Path C

`normalizeDegreeLevel()` strips whitespace and takes the first
value of comma/slash-separated strings (e.g. `"BSc, BA"` → `"BSc"`)
before matching. Recognised groups:

- **UG (19 entries):** BA, BSc, BEng, LLB, BMus, BEd, BDS, MBBS, MBChB, BVM&S, BArch, BFA, BBA, BN, BSN, Foundation Degree, FD, FdA, FdSc
- **PG (19 entries):** MSc, MA, MBA, PhD, MPhil, MRes, LLM, MEng, MEd, MArch, MFA, MMus, MTh, MPharm, PGDip, PGCE, MComp, MDes, MSt
- **Vocational (18 entries):** HNC, HND, BTEC, T Level, T-Level, Access to HE, Access, Certificate, Diploma, Foundation, Higher, NVQ, CertHE, Cert HE, Higher Certificate, Higher Diploma, NC, FDip

Anything else (Diplom, Staatsexamen, MD, JD, EdD, MFA, BFA, AA, AS, etc.) → falls through to `tier_only` match only.

### 6.4 Why three implementations, not one?

Historical and intentional:
- Path A and B were built into the original enricher when Perplexity coverage was thinner. Inline with the main enrich pass.
- Path C was built later for the dedicated admission backfill, where we wanted a smarter cascade and an explicit `--peer-only` mode.
- They are NOT consolidated because they fire at different stages and have different cost/accuracy trade-offs. Leave them be.

---

## 7. Country-specific configuration

Every country has its own block in `src/perplexity_v3.js` (`countryFields`)
and its own region list in `src/wikipedia_v3.js`.

| | Germany | United Kingdom | USA | India |
|---|---|---|---|---|
| **Regions** | 16 Bundesländer | 4 nations (England/Scotland/Wales/NI) | 50 states + DC | 28 states + 8 UTs |
| **Currency** | EUR | GBP | USD | INR |
| **Accreditation** | AQAS, ASIIN, FIBAA, ZEvA, AHPGS, evalag, Akkreditierungsrat | QAA, OfS, BMA, Law Society, Engineering Council, RIBA, RICS, NMC | HLC, SACSCOC, WASC, NECHE, MSCHE, AACSB, ABET, LCME, ABA | UGC, NAAC, AICTE, NBA |
| **Entrance tests** | ABITUR, NUMERUS_CLAUSUS, TestDaF, DSH, GMAT, TOEFL, IELTS | A_LEVELS, UCAS, IELTS, TOEFL, UCAT, LNAT, BMAT, MAT, STEP, TSA, GMAT | SAT, ACT, GRE, GMAT, TOEFL, IELTS, LSAT, MCAT | JEE_MAIN, JEE_ADVANCED, NEET, CAT, CUET, GATE, MAT, XAT, CLAT, NIFT, NID |
| **Institution types** | universitaet, technische_universitaet, fachhochschule, kunsthochschule, paedagogische_hochschule, duale_hochschule, private_hochschule | russell_group, million_plus, university_alliance, post_92, specialist, conservatoire, further_education | ivy_league, public_research, private_research, liberal_arts, community_college, hbcu, land_grant, technical_institute, for_profit | central_university, state_university, deemed_university, private_university, iit, nit, iim, aiims, bits |
| **Student categories** | eu_domestic, non_eu, exchange | home_uk, eu, international | in_state, out_of_state, international | general_domestic, sc_st, obc, nri, oci, foreign_national |
| **Tier 1 examples** | TUM, LMU | Oxford, Cambridge, Imperial, UCL | MIT, Caltech, Stanford, Harvard, Yale | IITs, IIMs, AIIMS Delhi, IISc |

### `global_tier` semantics (used by Dream-Vantage)

- **Tier 1**: Top 50 globally (or country-specific top tier — IITs, Ivy League, Russell Group elites)
- **Tier 2**: Top 51-200 globally (NITs, top Russell Group, KIT, etc.)
- **Tier 3**: Top 201-500 OR strong regional rep (most state unis, top private unis)
- **Tier 4**: Unranked / very small / local-only

---

## 8. Environment variables

Set per Railway service (or in `.env` for local runs).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PERPLEXITY_API_KEY` | yes (Phases 1B–3) | — | `sonar-pro` model — gap_finder, enricher, both backfills |
| `SUPABASE_URL` | yes | — | |
| `SUPABASE_SERVICE_KEY` | yes | — | Service role, not anon |
| `SUPABASE_ANON_KEY` | no | — | Not used by v3 |
| `ANTHROPIC_API_KEY` | yes (Phase 4 backfill) | — | `claude-sonnet-4-5` — used by `validate_urls --mode=backfill`. Not needed for `--mode=check`. |
| `BRAVE_API_KEY` | yes (Phase 4 backfill) | — | Brave Web Search subscription token. Required by `validate_urls --mode=backfill` only. |
| `CRAWLER_COUNTRY` | yes (for v3) | none | Must be `Germany`, `United Kingdom`, `USA`, or `India`. Can be overridden by `--country=` CLI arg (quote multi-word: `--country="United Kingdom"`) |
| `CRAWLER_DELAY_MS` | no | 10000 | Sleep between API calls |
| `MAX_RETRIES` | no | 3 | Per queue item before permanent failure |
| `LOG_LEVEL` | no | — | Set to `debug` to enable `logger.debug` lines |

> If `CRAWLER_COUNTRY` is missing AND `--country=` is not passed, all
> v3 workers exit immediately with a clear error. There is no silent
> "Germany" fallback.

---

## 9. Operational sequence for a new country

Order matters. Don't parallelize across phases — each phase reads the
previous phase's writes.

```
Step 1. Confirm DB migrations are applied (001-008 + is_estimated patch)
Step 2. Run seed_v3            → populates crawler_queue
Step 3. Run gap_finder_v3      → tops up crawler_queue with Perplexity finds
Step 4. Run enricher_v3        → drains the queue, writes all entity tables
        ↳ Monitor: SELECT status, count(*) FROM crawler_queue
                   WHERE metadata->>'country' = 'India' GROUP BY status;
Step 5. (optional) program_backfill_v3 if many unis have 0 programs
Step 6. (optional) admission_backfill_v3 for final coverage
        ↳ Re-run with --peer-only if Perplexity cap reached
Step 7. validate_urls --mode=check                       → writes url_status for every program
        ↳ Monitor: SELECT url_status, count(*) FROM programs p
                   JOIN universities u ON u.id = p.university_id
                   WHERE u.country = 'India' GROUP BY 1 ORDER BY 2 DESC;
Step 8. validate_urls --mode=backfill                    → fixes broken / missing URLs (~$0.02/URL)
        ↳ Watch for the next-step hint at the end of the run
Step 9. validate_urls --mode=backfill --retry-not-found  → re-attempts long-tail rows
Step 10. Hand off to Dream-Vantage — read-only consumer
```

Parallelisation within a phase is OK (e.g. multiple enricher_v3 workers
for the same country share the queue via Postgres-level row locking),
but be mindful of Perplexity rate limits.

---

## 10. Monitoring queries

Run these in the Supabase SQL Editor to track progress.

```sql
-- Queue health
SELECT worker_type, status, COUNT(*)
FROM crawler_queue
WHERE metadata->>'country' = 'India'
GROUP BY 1, 2 ORDER BY 1, 2;

-- Validation summary
SELECT validation_status, is_active, COUNT(*)
FROM universities
WHERE country = 'India'
GROUP BY 1, 2;

-- Tier distribution (Dream-Vantage cares about this)
SELECT global_tier, COUNT(*)
FROM universities
WHERE country = 'India' AND is_active = true
GROUP BY 1 ORDER BY 1 NULLS LAST;

-- Coverage gaps
SELECT u.global_tier,
       COUNT(p.id) AS programs,
       COUNT(p.id) FILTER (WHERE EXISTS (
         SELECT 1 FROM tuition_fees tf WHERE tf.program_id = p.id
       )) AS programs_with_fees,
       COUNT(p.id) FILTER (WHERE EXISTS (
         SELECT 1 FROM admission_requirements ar WHERE ar.program_id = p.id
       )) AS programs_with_admissions,
       COUNT(p.id) FILTER (WHERE p.url_status = '200') AS programs_with_working_url
FROM universities u
LEFT JOIN programs p ON p.university_id = u.id
WHERE u.country = 'India' AND u.is_active = true
GROUP BY u.global_tier ORDER BY u.global_tier NULLS LAST;

-- URL phase: status distribution
SELECT p.url_status, COUNT(*)
FROM programs p
JOIN universities u ON u.id = p.university_id
WHERE u.country = 'India' AND u.is_active = true
GROUP BY 1 ORDER BY 2 DESC;

-- URL phase: backfill tier distribution
SELECT p.url_backfill_tier,
       p.url_backfill_source,
       COUNT(*)
FROM programs p
JOIN universities u ON u.id = p.university_id
WHERE u.country = 'India' AND u.is_active = true
GROUP BY 1, 2 ORDER BY 1 NULLS LAST;

-- URL phase: programs left without a working URL
SELECT u.name, p.name AS program, p.url_backfill_status
FROM programs p
JOIN universities u ON u.id = p.university_id
WHERE u.country = 'India' AND u.is_active = true
  AND (p.program_url IS NULL OR p.url_status != '200')
ORDER BY u.global_tier NULLS LAST;
```

---

## 11. Migration history

| File | What it adds |
|---|---|
| `001_initial_schema.sql` | All base tables: universities, programs, tuition_fees, admission_requirements, entrance_tests, intake_stats, colleges, crawler_queue |
| `002_add_campuses.sql` | `campuses` table + `programs.campus_id` FK |
| `003_add_notes_crawl_status.sql` | `universities.notes`, `crawl_status`, `institution_type`, `affiliated_to`, `apply_through`, `can_apply_directly`. Drops `default 'India'` from `country` and `default 'INR'` from `tuition_fees.currency`. |
| `004_v3_columns.sql` | `universities.global_tier` (integer with 1-4 check), `validation_status`, `wikipedia_summary`. `tuition_fees.is_estimated`, `source`. Index on `(country, global_tier)`. |
| `005_add_program_url_status.sql` | `programs.url_status`, `url_checked_at` + index. RPC `get_programs_with_distinct_urls`. |
| `006_add_failed_url_rpc.sql` | RPC `get_programs_with_failed_urls` (used by `validate_urls --retry-failed`). |
| `007_add_url_backfill_tracking.sql` | `programs.url_backfill_status`, `url_backfill_at`, `url_backfill_source`, `url_backfill_candidates_count` + index. RPC `get_programs_for_url_backfill`. |
| `008_add_url_backfill_tier.sql` *(applied manually)* | `programs.url_backfill_tier` + RPC `get_programs_for_url_retry` (used by `validate_urls --retry-not-found`). Lives in Supabase only. |
| **manual patch** | `alter table admission_requirements add column if not exists is_estimated boolean default false;` |
| **manual** | The `get_programs_needing_admission(p_country text)` RPC must exist (definition lives in Supabase, not in this repo) |

---

## 12. Known gotchas

1. **`naac_grade` column is a misnomer.** It stores India's NAAC grade,
   Germany's `accreditation_status`, and United Kingdom's `tef_rating`. Don't be
   misled by the name. Functionally fine.

2. **`admission_requirements.is_estimated` isn't in any migration file.**
   It was added directly to Supabase. If you bootstrap a new DB, apply
   the manual patch in §4.

3. **`get_programs_needing_admission` RPC isn't in the repo.** It's a
   Postgres function defined in Supabase only. If `admission_backfill_v3`
   fails with "function does not exist", check Supabase.

4. **The v2 files** (`seedBuilder.js`, `enricher.js`, `wikipedia.js`,
   `perplexity.js`, `websiteCrawler.js`, `aggregatorScraper.js`,
   `pdfExtractor.js`, `siblingAugmentor.js`) are kept for rollback only.
   Do not run them. v3 is the only supported pipeline.

5. **Perplexity rate limits.** With default `CRAWLER_DELAY_MS=10000` a
   full country takes 8-30 hours. Don't reduce delay below 3000ms unless
   you've upgraded the Perplexity plan.

6. **`global_tier` is populated by Perplexity, not by any external
   ranking source.** It's a model judgment. Audit Tier 1 manually after
   the first run for any country.

7. **Re-running phases is safe.** All inserts go through PostgREST
   `upsert()` with explicit `onConflict` keys. Existing rows are updated;
   nothing is duplicated.

8. **Tier 3 (homepage fallback) URLs are NOT HTTP-validated.** Many
   university homepages sit behind Cloudflare bot protection that 403s
   our server-side HEAD/GET requests while serving fine to browsers —
   pre-fix this caused ~270 false-negative `invalid_candidate` rows on
   UK alone. Tier 3 rows are trusted from enrichment and saved with
   `url_status='200'` and `url_backfill_source='homepage_fallback_unchecked'`.
   The `unchecked` suffix is the audit-trail flag.

9. **The 1000-row Supabase RPC cap.** PostgREST applies `db-max-rows`
   (commonly 1000) to RPC responses. All four URL RPCs are called with
   `.range(0, 99999)` to bypass it. If you ever add another RPC caller,
   remember to chain `.range()` or you'll silently truncate.

10. **URL phase needs both `BRAVE_API_KEY` and `ANTHROPIC_API_KEY`**
    in `--mode=backfill`. `--mode=check` only needs Supabase. Both 401s
    are fatal — the worker `process.exit(1)`s rather than burning rows.

---

## 13. Repo layout (for orientation only)

```
src/
  config.js                        # env parsing, SUPPORTED_COUNTRIES
  supabase.js                      # PostgREST client + upsert helpers
  perplexity_v3.js                 # buildPrompt() + enrichUniversity() + findMissingUniversities()
  wikipedia_v3.js                  # category recursion + region lists
  utils/
    logger.js                      # JSON line logger, LOG_LEVEL=debug toggles .debug()
    nonUniversityPatterns.js       # blocklist regex (libraries, sports, etc.)
    peerFallback.js                # tuition fee peer matching
    queue.js                       # requeueStuckItems()
    regexCrawler.js                # (v2 only, do not use)
  workers/
    seedBuilder_v3.js
    gapFinder_v3.js
    enricher_v3.js
    programBackfill_v3.js
    admissionBackfill_v3.js
    programUrlValidator_v3.js      # Phase 4 — check + backfill (Brave + Sonnet)
    # v2 files exist alongside but are not part of the v3 pipeline

scripts/
  runWorker.js                     # CLI dispatcher — every worker is launched through here
  pushPendingToQueue.js            # requeue utility (see §5)

supabase/migrations/
  001_initial_schema.sql
  002_add_campuses.sql
  003_add_notes_crawl_status.sql
  004_v3_columns.sql
  005_add_program_url_status.sql
  006_add_failed_url_rpc.sql
  007_add_url_backfill_tracking.sql
  # 008_add_url_backfill_tier.sql is applied manually in Supabase only
```

---

**Owner contact:** Sajeed Ahmed (`sajeedahmed1981@gmail.com`).
**Repo:** https://github.com/sajeedahmed1981/university-db-crawler
**Last updated:** 2026-05-16 (Phase 4 URL validator + backfill with tiered Brave/Sonnet + Cloudflare-skip homepage fallback shipped)

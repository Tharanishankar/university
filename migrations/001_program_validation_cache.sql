-- Migration 001: Program Validation Cache
-- Run once in Supabase SQL editor (Dashboard → SQL Editor → New query → Paste → Run)
--
-- Purpose: Cache ContainerQ Perplexity validation results (ACTIVE/INACTIVE/STREAM_MISMATCH)
--          per program+stream combination. 7-day TTL.
--          UNKNOWN is never cached — means Perplexity couldn't determine; always retried.
--
-- Expected impact: eliminates repeated Perplexity calls for programs already validated.
--   Cold (first time a program is seen): Perplexity called, result cached.
--   Warm (any subsequent session): instant cache hit, no Perplexity call.

CREATE TABLE IF NOT EXISTS program_validation_cache (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key         TEXT        UNIQUE NOT NULL,         -- programId::stream
  program_id        UUID        NOT NULL,
  university_id     UUID,                                -- informational, not used in lookup
  stream            TEXT        NOT NULL,
  validation_status TEXT        NOT NULL,                -- 'ACTIVE' | 'INACTIVE' | 'STREAM_MISMATCH'
  fetched_at        TIMESTAMPTZ DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL
);

-- Index used by every cache read (eq cache_key + gt expires_at)
CREATE INDEX IF NOT EXISTS idx_program_validation_cache_key_expiry
  ON program_validation_cache (cache_key, expires_at);

-- Optional: auto-delete expired rows (keeps table tidy)
-- Run separately if you want a cleanup job, or rely on the expires_at filter in queries.
-- DELETE FROM program_validation_cache WHERE expires_at < NOW();

-- V3 migration: add columns to support v3 enrichment quality tracking

-- Backfill column that was added manually to live DB but never tracked in migrations
alter table universities
add column if not exists global_tier integer;

-- Enforce tier range constraint
alter table universities
drop constraint if exists universities_global_tier_check;

alter table universities
add constraint universities_global_tier_check
check (global_tier is null or global_tier between 1 and 4);

-- Fee-level quality tracking
alter table tuition_fees
add column if not exists is_estimated boolean default false;

alter table tuition_fees
add column if not exists source text;
-- values: 'perplexity', 'peer_fallback', 'manual', 'estimated_default'

-- University-level validation tracking
alter table universities
add column if not exists validation_status text;
-- values: 'pending', 'validated', 'rejected_pattern', 'rejected_perplexity', 'manual_override'

alter table universities
add column if not exists wikipedia_summary text;
-- Optional Wikipedia summary text, useful for future audits

-- Index for tier-based queries (recommender needs this fast)
create index if not exists idx_universities_tier_country
on universities(country, global_tier)
where is_active = true;

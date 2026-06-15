-- Migration 007: track URL backfill outcomes for programs whose
-- url_status is bad or whose program_url is missing/equal to the
-- university's main website.
--
-- Used by src/workers/programUrlValidator_v3.js when invoked with
-- --mode=backfill.

alter table programs add column if not exists url_backfill_status text;
alter table programs add column if not exists url_backfill_at timestamptz;
alter table programs add column if not exists url_backfill_source text;
alter table programs add column if not exists url_backfill_candidates_count int;

create index if not exists idx_programs_url_backfill_status
  on programs(url_backfill_status);

create or replace function get_programs_for_url_backfill(p_country text)
returns table(
  program_id uuid,
  program_name text,
  university_id uuid,
  university_name text,
  university_website text,
  university_city text,
  university_country text
)
language sql stable
as $$
  select
    p.id as program_id,
    p.name as program_name,
    u.id as university_id,
    u.name as university_name,
    u.website as university_website,
    u.city as university_city,
    u.country as university_country
  from programs p
  join universities u on u.id = p.university_id
  where u.country = p_country
    and u.is_active = true
    and u.website is not null
    and (
      p.url_status in ('404','403','400','405','500','TIMEOUT','ERROR')
      or p.program_url is null
      or p.program_url = u.website
    );
$$;

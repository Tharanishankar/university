-- Migration 005: track HTTP status of every program_url
--
-- Adds two columns to programs and one RPC used by
-- src/workers/programUrlValidator_v3.js.

-- 1. Schema columns
alter table programs add column if not exists url_status text;
alter table programs add column if not exists url_checked_at timestamptz;

create index if not exists idx_programs_url_status on programs(url_status);

-- 2. RPC — returns programs where program_url is set AND different from
--    the university's main website, scoped to one active country.
create or replace function get_programs_with_distinct_urls(p_country text)
returns table(id uuid, program_url text)
language sql
stable
as $$
  select p.id, p.program_url
  from programs p
  join universities u on u.id = p.university_id
  where p.program_url is not null
    and p.program_url <> u.website
    and u.is_active = true
    and u.country = p_country;
$$;

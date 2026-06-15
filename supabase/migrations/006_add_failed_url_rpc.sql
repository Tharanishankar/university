-- Migration 006: RPC for retrying programs whose URL check previously failed
--
-- Used by src/workers/programUrlValidator_v3.js when invoked with
-- --retry-failed. Returns the same row shape as the original
-- get_programs_with_distinct_urls, filtered to known-bad statuses.

create or replace function get_programs_with_failed_urls(p_country text)
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
    and u.country = p_country
    and p.url_status in ('403', '404', 'TIMEOUT', 'ERROR', '500', '400')
  order by p.id;
$$;

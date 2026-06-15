-- Add notes and crawl_status to universities table
alter table universities add column if not exists notes text;
alter table universities add column if not exists crawl_status text default 'pending';

-- Add institution metadata columns (from v1.8 session)
alter table universities add column if not exists institution_type text;
alter table universities add column if not exists affiliated_to text;
alter table universities add column if not exists apply_through text;
alter table universities add column if not exists can_apply_directly boolean;

-- Remove hardcoded India default from country column
alter table universities alter column country drop default;

-- Remove hardcoded INR default from tuition_fees (currency is now set per-country by the crawler)
alter table universities alter column country set not null;
alter table tuition_fees alter column currency drop default;

-- Index on crawl_status for monitoring queries
create index if not exists idx_universities_crawl_status on universities(crawl_status);
create index if not exists idx_universities_country on universities(country);

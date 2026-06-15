create table if not exists campuses (
  id uuid primary key default uuid_generate_v4(),
  university_id uuid references universities(id) on delete cascade,
  name text not null,
  city text,
  state text,
  country text not null default 'India',
  is_main_campus boolean default false,
  website text,
  created_at timestamptz default now(),
  unique(university_id, city, country)
);

create index if not exists idx_campuses_university on campuses(university_id);

-- Add campus_id column to programs table
alter table programs add column if not exists campus_id uuid references campuses(id) on delete set null;

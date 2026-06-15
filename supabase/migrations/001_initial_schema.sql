create extension if not exists "uuid-ossp";

create table if not exists universities (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  country text not null default 'India',
  state text,
  city text,
  type text,
  website text,
  accreditation_body text,
  naac_grade text,
  world_ranking_tier text,
  is_active boolean default true,
  last_verified timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(name, country)
);

create table if not exists colleges (
  id uuid primary key default uuid_generate_v4(),
  university_id uuid references universities(id) on delete cascade,
  name text not null,
  short_code text,
  website text,
  created_at timestamptz default now(),
  unique(university_id, name)
);

create table if not exists programs (
  id uuid primary key default uuid_generate_v4(),
  university_id uuid references universities(id) on delete cascade,
  college_id uuid references colleges(id) on delete set null,
  name text not null,
  degree_level text,
  field_of_study text,
  duration_years numeric,
  delivery_mode text default 'campus',
  language_of_instruction text default 'English',
  is_active boolean default true,
  created_at timestamptz default now(),
  unique(university_id, name, degree_level)
);

create table if not exists tuition_fees (
  id uuid primary key default uuid_generate_v4(),
  program_id uuid references programs(id) on delete cascade,
  student_category text not null,
  annual_fee numeric,
  currency text default 'INR',
  academic_year text default '2024-25',
  created_at timestamptz default now(),
  unique(program_id, student_category, academic_year)
);

create table if not exists admission_requirements (
  id uuid primary key default uuid_generate_v4(),
  program_id uuid references programs(id) on delete cascade,
  requirement_type text,
  subject_group text,
  min_percentage numeric,
  specific_subjects text,
  notes text,
  created_at timestamptz default now(),
  unique(program_id, requirement_type, subject_group)
);

create table if not exists entrance_tests (
  id uuid primary key default uuid_generate_v4(),
  program_id uuid references programs(id) on delete cascade,
  test_name text not null,
  test_region text,
  min_score numeric,
  is_mandatory boolean default true,
  notes text,
  created_at timestamptz default now(),
  unique(program_id, test_name)
);

create table if not exists intake_stats (
  id uuid primary key default uuid_generate_v4(),
  program_id uuid references programs(id) on delete cascade,
  academic_year text,
  total_seats integer,
  applications_received integer,
  admissions_granted integer,
  created_at timestamptz default now(),
  unique(program_id, academic_year)
);

create table if not exists crawler_queue (
  id uuid primary key default uuid_generate_v4(),
  university_name text,
  university_url text,
  state text,
  university_type text,
  naac_grade text,
  worker_type text not null,
  status text default 'pending',
  priority integer default 5,
  retry_count integer default 0,
  error_message text,
  metadata jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_queue_status_worker on crawler_queue(status, worker_type);
create index if not exists idx_queue_priority on crawler_queue(priority desc);
create index if not exists idx_programs_university on programs(university_id);
create index if not exists idx_colleges_university on colleges(university_id);

-- 창업노트 T0 schema draft.
-- Do not apply to production until Supabase project/RLS settings are reviewed.

create extension if not exists "uuid-ossp";
create extension if not exists vector;

create type company_kind as enum ('active', 'preliminary');
create type company_role as enum ('owner', 'member', 'viewer');
create type grant_source as enum ('kstartup', 'bizinfo', 'bizinfo_event');
create type grant_status as enum ('upcoming', 'open', 'closed', 'unknown');
create type raw_status as enum ('fetched', 'converted', 'extracted', 'normalized', 'published', 'failed');
create type criterion_dimension as enum (
  'region',
  'biz_age',
  'industry',
  'size',
  'revenue',
  'employees',
  'founder_age',
  'founder_trait',
  'certification',
  'prior_award',
  'ip',
  'target_type',
  'business_status',
  'other'
);
create type criterion_operator as enum ('in', 'not_in', 'lte', 'gte', 'between', 'exists', 'text_only');
create type criterion_kind as enum ('required', 'preferred', 'exclusion');
create type profile_source as enum ('popbill', 'nts', 'codef', 'self_declared', 'ocr');
create type eligibility as enum ('eligible', 'conditional', 'ineligible');
create type match_event_type as enum ('surfaced', 'clicked', 'saved', 'apply_click');

create table users (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  name text,
  created_at timestamptz not null default now()
);

create table app_refresh_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text unique not null,
  device_id text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_from uuid references app_refresh_tokens(id),
  created_at timestamptz not null default now()
);

create table companies (
  id uuid primary key default uuid_generate_v4(),
  kind company_kind not null,
  biz_no text unique,
  legal_type text,
  name text,
  verified boolean not null default false,
  verified_at timestamptz,
  verify_method text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint active_company_requires_biz_no check (kind = 'preliminary' or biz_no is not null)
);

create table user_company (
  user_id uuid not null references users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role company_role not null,
  invited_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

create table consents (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  scope text not null,
  purpose text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table company_profiles (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  dimension criterion_dimension not null,
  value jsonb not null,
  source profile_source not null,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  as_of timestamptz,
  updated_at timestamptz not null default now()
);
create index company_profiles_company_dimension_idx on company_profiles(company_id, dimension);

create table company_enrichment_cache (
  provider text not null,
  biz_no text not null,
  scope text not null,
  raw_payload jsonb,
  canonical_payload jsonb,
  provider_result_code text,
  provider_result_message text,
  checked_at timestamptz,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  payload_hash text,
  last_error jsonb,
  primary key (provider, biz_no, scope)
);

create table grant_raw (
  id uuid primary key default uuid_generate_v4(),
  source grant_source not null,
  source_id text not null,
  payload jsonb not null,
  attachments jsonb,
  raw_hash text,
  collected_at timestamptz not null default now(),
  status raw_status not null,
  unique (source, source_id)
);

create table grants (
  id uuid primary key default uuid_generate_v4(),
  source grant_source not null,
  source_id text not null,
  title text not null,
  url text,
  agency_jurisdiction text,
  agency_operator text,
  category_l1 text,
  category_l2 text,
  apply_start date,
  apply_end date,
  apply_method jsonb,
  support_amount jsonb,
  status grant_status not null default 'unknown',
  f_regions text[] not null default '{}',
  f_industries text[] not null default '{}',
  f_biz_age_min_months integer,
  f_biz_age_max_months integer,
  f_sizes text[] not null default '{}',
  f_founder_traits text[] not null default '{}',
  f_required_certs text[] not null default '{}',
  embedding vector,
  overall_confidence numeric(4,3) check (overall_confidence >= 0 and overall_confidence <= 1),
  model_ver text,
  prompt_ver text,
  parser_version text,
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);
create index grants_status_idx on grants(status);
create index grants_regions_idx on grants using gin(f_regions);

create table grant_criteria (
  id uuid primary key default uuid_generate_v4(),
  grant_id uuid not null references grants(id) on delete cascade,
  dimension criterion_dimension not null,
  operator criterion_operator not null,
  value jsonb not null,
  kind criterion_kind not null,
  weight numeric(8,3) not null default 0,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  source_span text,
  raw_text text,
  source_field text,
  needs_review boolean not null default false,
  parser_version text
);
create index grant_criteria_grant_idx on grant_criteria(grant_id);

create table match_state (
  company_id uuid not null references companies(id) on delete cascade,
  grant_id uuid not null references grants(id) on delete cascade,
  eligibility eligibility not null,
  match_score integer not null check (match_score >= 0 and match_score <= 100),
  fit jsonb,
  competitiveness jsonb,
  value_score jsonb,
  rule_trace jsonb not null,
  match_confidence numeric(4,3),
  ruleset_ver text not null,
  scoring_ver text not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, grant_id)
);

create table match_events (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  grant_id uuid not null references grants(id) on delete cascade,
  event match_event_type not null,
  ruleset_ver text not null,
  ts timestamptz not null default now()
);
create index match_events_company_grant_idx on match_events(company_id, grant_id, ts desc);

create table feedback (
  id uuid primary key default uuid_generate_v4(),
  target_type text not null,
  target_id text not null,
  type text not null,
  value jsonb,
  actor text not null,
  ts timestamptz not null default now()
);

create table extraction_log (
  id uuid primary key default uuid_generate_v4(),
  grant_id uuid references grants(id) on delete cascade,
  input_ref text,
  output jsonb,
  confidence numeric(4,3),
  status text not null,
  reviewer uuid references users(id),
  model_ver text,
  prompt_ver text,
  ts timestamptz not null default now()
);

create table golden_set (
  id uuid primary key default uuid_generate_v4(),
  kind text not null,
  ref jsonb not null,
  gold jsonb not null,
  curated_by uuid references users(id),
  golden_ver text not null
);

create table eval_runs (
  id uuid primary key default uuid_generate_v4(),
  target text not null,
  version_refs jsonb not null,
  metrics jsonb not null,
  golden_ver text not null,
  ts timestamptz not null default now()
);

create table versions (
  id uuid primary key default uuid_generate_v4(),
  type text not null,
  hash text not null,
  notes text,
  activated_at timestamptz
);

create table industry_taxonomy (
  ksic text not null,
  policy_tag text not null,
  ver text not null,
  primary key (ksic, policy_tag, ver)
);

create table region_hierarchy (
  sigungu text primary key,
  sido text not null,
  region_group text
);

create table size_thresholds (
  ksic text not null,
  segment text not null,
  revenue_max_krw numeric,
  employees_max integer,
  ver text not null,
  primary key (ksic, segment, ver)
);

create table source_cursor (
  source grant_source primary key,
  last_page integer,
  last_collected_at timestamptz
);

create table dedup_links (
  canonical_grant_id uuid not null references grants(id) on delete cascade,
  member_grant_id uuid not null references grants(id) on delete cascade,
  score numeric(5,4) not null,
  confirmed boolean not null default false,
  primary key (canonical_grant_id, member_grant_id)
);

alter table companies enable row level security;
alter table user_company enable row level security;
alter table company_profiles enable row level security;
alter table consents enable row level security;
alter table app_refresh_tokens enable row level security;
alter table match_state enable row level security;
alter table match_events enable row level security;

comment on table company_enrichment_cache is 'Provider raw/canonical cache for Popbill/NTS repeat-call and billing control.';
comment on table grant_criteria is 'Truth source for deterministic matching; grants.f_* columns are projections only.';
comment on table match_state is 'Current company x grant match state, upserted by ruleset/scoring version.';
comment on table match_events is 'Append-only user exposure/action history.';

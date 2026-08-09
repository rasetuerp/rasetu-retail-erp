-- Round 4 — lean MVP license table. One row per sold license key. Single-
-- machine trust (machine_id stored directly on the row, no separate
-- machine_bindings table — no machine-transfer support in v1).
create table if not exists licenses (
  id uuid primary key default gen_random_uuid(),
  license_key text unique not null,
  type text not null default 'TRIAL' check (type in ('TRIAL', 'LIFETIME')),
  status text not null default 'TRIAL' check (status in ('TRIAL', 'ACTIVE', 'EXPIRED', 'BLOCKED')),
  block_reason text,
  customer_name text,
  customer_business_name text,
  customer_gstin text,
  customer_email text,
  machine_id text,
  activated_at timestamptz,
  trial_expires_on timestamptz,
  amc_expires_on timestamptz,
  max_machines integer not null default 1,
  last_seen_at timestamptz,
  software_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists licenses_status_idx on licenses (status);

-- Edge Functions authenticate with the service_role key, which bypasses RLS
-- entirely — this policy just ensures the table is never reachable through
-- the public anon/authenticated API surface (defense in depth).
alter table licenses enable row level security;

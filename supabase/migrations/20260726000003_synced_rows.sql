-- Round 4 — one-way sync backup log (v1 scope: push only, deliberately
-- minimal — see docs/ARCHITECTURE.md's Sync design). A JSON backup log, not a
-- fully relational mirror; a typed mirror is a Phase 2 concern.
create table if not exists synced_rows (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references licenses(id),
  company_id text not null,
  table_name text not null,
  row_id text not null,
  action text not null,
  payload jsonb not null,
  source_created_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists synced_rows_company_idx on synced_rows (company_id, table_name);

-- Edge Functions authenticate with the service_role key, which bypasses RLS
-- entirely — this policy just ensures the table is never reachable through
-- the public anon/authenticated API surface (defense in depth).
alter table synced_rows enable row level security;

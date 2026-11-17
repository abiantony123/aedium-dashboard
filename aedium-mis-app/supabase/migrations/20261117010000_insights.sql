-- Cache of LLM-written dashboard narrative, keyed by a hash of the rule findings it was written from.
-- Server-only (service role). New text is generated only when the findings change.
create table mis.insights (
  findings_hash text primary key,
  studio text,
  narrative jsonb not null,
  model text,
  created_at timestamptz not null default now()
);
alter table mis.insights enable row level security;
grant all on mis.insights to service_role;
notify pgrst, 'reload schema';

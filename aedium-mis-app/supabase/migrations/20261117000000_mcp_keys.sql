-- API keys for the Aedium MCP server, and a log of every tool call made through it.
-- Only the server (service role) reads or writes these tables; signed-in users get no direct access.

create table mis.api_keys (
  id bigint generated always as identity primary key,
  name text not null,                              -- e.g. "Melixa · Claude desktop"
  prefix text not null,                            -- first characters, shown in the list (ak_live_1a2b…)
  key_hash text not null unique,                   -- sha256 of the full key; the key itself is never stored
  scope text not null check (scope in ('read','act')),
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table mis.agent_runs (
  id bigint generated always as identity primary key,
  key_id bigint references mis.api_keys on delete set null,
  key_name text, client text,                      -- client = MCP clientInfo name (Claude, ChatGPT, Gemini CLI...)
  tool text not null, input jsonb, ok boolean not null, error text, ms int,
  created_at timestamptz not null default now()
);
create index on mis.agent_runs (created_at desc);

alter table mis.api_keys enable row level security;
alter table mis.agent_runs enable row level security;
-- Signed-in people may see the call log (not the keys table).
create policy "signed-in users read" on mis.agent_runs for select to authenticated using (true);
grant select on mis.agent_runs to authenticated;
grant all on mis.api_keys, mis.agent_runs to service_role;
grant usage, select on all sequences in schema mis to service_role;

notify pgrst, 'reload schema';

-- PO intake (staged -> reviewed -> merged), FY plan, monthly projection, finance notifications and roles.
-- Run after the earlier migrations. Server writes use the service role; RLS lets signed-in users read.

-- ---------- tracker rows can now come from an approved PO as well as the Excel import ----------
alter table mis.project_lines add column if not exists origin text not null default 'excel';
alter table mis.project_lines add column if not exists po_id bigint;
alter table mis.billing_stages add column if not exists origin text not null default 'excel';
alter table mis.billing_stages add column if not exists po_id bigint;

-- ---------- invoiced step + invoice number on stage events ----------
alter table mis.stage_events drop constraint if exists stage_events_event_check;
alter table mis.stage_events add constraint stage_events_event_check
  check (event in ('complete','client_approved','finance_notified','invoiced','reopened'));
alter table mis.stage_events add column if not exists invoice_number text;

-- Recreated (not replaced): billing_stages gained columns, so s.* changes shape.
drop view if exists mis.v_stages;
create view mis.v_stages with (security_invoker = true) as
select s.*,
  e.event as last_event, e.created_at as last_event_at, e.actor_email as last_event_by,
  case
    when s.source_status = 'billed' then 'billed'
    when e.event = 'invoiced' then 'invoiced'
    when e.event = 'finance_notified' then 'finance_notified'
    when e.event = 'client_approved' then 'client_approved'
    when e.event = 'complete' then 'complete'
    when e.event = 'reopened' then 'pending'
    else s.source_status
  end as workflow_status,
  e.invoice_number
from mis.billing_stages s
left join lateral (
  select event, created_at, actor_email, invoice_number from mis.stage_events x
  where x.project_number = s.project_number and x.studio is not distinct from s.studio and x.seq = s.seq
  order by created_at desc limit 1
) e on true;

-- ---------- purchase orders ----------
create table mis.purchase_orders (
  id bigint generated always as identity primary key,
  po_number text not null,
  version int not null default 1,
  parent_id bigint references mis.purchase_orders,
  kind text not null default 'new' check (kind in ('new','amendment','additional','rework')),
  client_name text, project_number text, project_name text, location text, project_type text,
  po_date date, start_date date, end_date date, contract_validity text, escalation_clause text,
  total_value numeric, gst_included boolean,
  status text not null default 'pending_review' check (status in ('pending_review','approved','rejected')),
  source text, source_ref text,           -- e.g. outlook / folder / attachment, and the mail subject or file name
  extracted_by text,                      -- who or which assistant staged it (key name)
  confidence numeric, checks jsonb, diff jsonb, raw jsonb,
  created_at timestamptz not null default now(),
  reviewed_by text, reviewed_at timestamptz, review_note text,
  unique (po_number, version)
);
create table mis.po_lines (
  id bigint generated always as identity primary key,
  po_id bigint not null references mis.purchase_orders on delete cascade,
  studio text not null, split_value numeric, split_pct numeric, design_value numeric, construction_value numeric
);
create table mis.po_stages (
  id bigint generated always as identity primary key,
  po_id bigint not null references mis.purchase_orders on delete cascade,
  studio text not null, seq int not null, stage text not null, pct numeric, fee numeric,
  is_construction boolean not null default false, instalments int
);

-- ---------- FY targets and monthly projection ----------
create table mis.fy_targets (
  fy text not null, studio text not null default 'All', target numeric not null,
  updated_by text, updated_at timestamptz not null default now(),
  primary key (fy, studio)
);
create table mis.projections (
  id bigint generated always as identity primary key,
  month date not null,                    -- first day of the month
  week int not null check (week between 1 and 5),
  project_number text, studio text, stage_seq int, description text not null,
  amount numeric not null,
  kind text not null default 'forecast' check (kind in ('forecast','unplanned','new_project')),
  created_by text, created_at timestamptz not null default now()
);
create index on mis.projections (month);

-- ---------- notifications and roles ----------
create table mis.notifications (
  id bigint generated always as identity primary key,
  role text not null, title text not null, body text, tab text, ref text,
  created_at timestamptz not null default now(), read_at timestamptz
);
create index on mis.notifications (role, created_at desc);
create table mis.user_roles (
  email text primary key, role text not null check (role in ('admin','ceo','project_manager','finance','hr','employee')),
  studio text, name text, created_at timestamptz not null default now()
);
alter table mis.api_keys add column if not exists role text not null default 'admin';
alter table mis.api_keys add column if not exists studio text;

-- ---------- access ----------
do $$
declare t text;
begin
  foreach t in array array['purchase_orders','po_lines','po_stages','fy_targets','projections','notifications','user_roles']
  loop
    execute format('alter table mis.%I enable row level security', t);
    execute format('create policy "signed-in users read" on mis.%I for select to authenticated using (true)', t);
    execute format('grant select on mis.%I to authenticated', t);
    execute format('grant all on mis.%I to service_role', t);
  end loop;
end $$;
grant select on mis.v_stages to authenticated;
grant all on all tables in schema mis to service_role;
grant usage, select on all sequences in schema mis to service_role;

notify pgrst, 'reload schema';

-- Aedium MIS schema: master tracker + Zoho Books mirror + workflow + audit.
-- Run once in the Supabase SQL editor (or `supabase db push`). Every table is locked to signed-in users by RLS.
-- Everything lives in its own schema, `mis`, so other apps' tables in `public` are never touched.
-- After running: Project Settings > Data API > Exposed schemas: add `mis`.
create schema if not exists mis;
grant usage on schema mis to authenticated, service_role;

-- ============ Master tracker ============
create table mis.project_lines (            -- Summary sheet: one row per project x studio line
  id bigint generated always as identity primary key,
  row_no int not null unique,                   -- source row in the Summary sheet (re-import key)
  sl_no text, financial_year text,
  project_number text not null, client_name text, project_name text, location text,
  studio text, project_type text, contract_validity text,
  start_date date, end_date date, escalation_clause text,
  total_project_value numeric, split_value numeric, split_pct numeric,
  billed_pct numeric, billed_amount numeric, yet_to_bill_pct numeric, yet_to_bill_amount numeric,
  paid_to_sub numeric, yet_to_pay_sub numeric, sub_total_value numeric,
  design_value numeric, construction_value numeric, short_closed_value numeric,
  site_area numeric, built_up_area numeric, parking_area numeric,
  status text, status_raw text, project_stage text, spoc text,
  construction_stage text, construction_pct numeric, construction_amount numeric,
  expected_deliverable date, current_stage text,
  imported_at timestamptz not null default now()
);
create index on mis.project_lines (project_number, studio);

create table mis.billing_stages (           -- Billing Stages sheet
  id bigint generated always as identity primary key,
  project_number text not null, studio text, seq int not null,
  sl_no text,                                   -- matches project_lines.sl_no (e.g. "2A")
  project_name text, project_value numeric,
  stage text, completion text, pct numeric, fee numeric,
  billed_on date, assigned_to text, remarks text,
  source_status text not null check (source_status in ('pending','in_progress','complete','billed')),
  row_no int not null,
  imported_at timestamptz not null default now(),
  unique (project_number, studio, seq)
);
create index on mis.billing_stages (billed_on);

-- Workflow events entered in the app. Keyed by the stage's natural key so they survive a re-import.
create table mis.stage_events (
  id bigint generated always as identity primary key,
  project_number text not null, studio text, seq int not null,
  event text not null check (event in ('complete','client_approved','finance_notified','reopened')),
  note text,
  actor uuid default auth.uid(), actor_email text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index on mis.stage_events (project_number, studio, seq, created_at desc);

create table mis.sub_consultants (
  id bigint generated always as identity primary key,
  loa text not null unique, financial_year text, consultant_name text, project_number text,
  project_name text, service text, start_date date, end_date date,
  value numeric, paid numeric, yet_to_pay numeric
);
create table mis.sub_consultant_stages (
  id bigint generated always as identity primary key,
  loa text not null, consultant_name text, seq int not null, stage text, completion text,
  pct numeric, fee numeric, invoice_date date, invoice_no text, paid_on date, remarks text,
  unique (loa, seq)
);
create table mis.staff (
  id bigint generated always as identity primary key,
  name text not null unique, designation text
);

-- ============ Zoho Books mirror (read-only copy, filled by the sync/import) ============
create table mis.zoho_contacts (
  contact_id text primary key, contact_name text, company_name text, gst_no text, payment_terms int, email text
);
create table mis.zoho_sales_orders (
  salesorder_id text primary key, salesorder_number text, customer_id text references mis.zoho_contacts,
  reference_number text, date date, status text, total numeric,
  project_number text, project_name text, studio text
);
create table mis.zoho_invoices (
  invoice_id text primary key, invoice_number text not null, customer_id text references mis.zoho_contacts,
  salesorder_id text references mis.zoho_sales_orders, reference_number text,
  date date not null, due_date date not null, total numeric not null, balance numeric not null,
  line_items jsonb not null default '[]'
);
create table mis.zoho_payments (
  payment_id text primary key, payment_number text, customer_id text references mis.zoho_contacts,
  date date not null, payment_mode text, amount numeric not null, tax_amount_withheld numeric not null default 0,
  reference_number text, invoices jsonb not null default '[]'
);

-- ============ Agent decisions and run log ============
create table mis.agent_decisions (
  id bigint generated always as identity primary key,
  agent text not null, ref text not null,
  decision text not null check (decision in ('approved','dismissed')),
  note text,
  actor uuid default auth.uid(), actor_email text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create table mis.import_runs (
  id bigint generated always as identity primary key,
  source text not null, started_at timestamptz not null, finished_at timestamptz,
  ok boolean, counts jsonb, issues jsonb, error text, report_month date
);

-- ============ Views the dashboard reads ============
-- Current workflow state per stage: billed in the tracker wins, then the latest app event, then the sheet.
create view mis.v_stages with (security_invoker = true) as
select s.*,
  e.event as last_event, e.created_at as last_event_at, e.actor_email as last_event_by,
  case
    when s.source_status = 'billed' then 'billed'
    when e.event = 'finance_notified' then 'finance_notified'
    when e.event = 'client_approved' then 'client_approved'
    when e.event = 'complete' then 'complete'
    when e.event = 'reopened' then 'pending'
    else s.source_status
  end as workflow_status
from mis.billing_stages s
left join lateral (
  select event, created_at, actor_email from mis.stage_events x
  where x.project_number = s.project_number and x.studio is not distinct from s.studio and x.seq = s.seq
  order by created_at desc limit 1
) e on true;

-- Open invoices with ageing against today (30-day terms are in due_date already).
create view mis.v_open_invoices with (security_invoker = true) as
select i.*, c.contact_name as customer_name, so.project_name, so.project_number, so.studio,
  greatest(0, current_date - i.due_date) as days_overdue,
  case
    when current_date <= i.due_date then '0-15'
    when current_date - i.due_date <= 15 then '0-15'
    when current_date - i.due_date <= 30 then '16-30'
    when current_date - i.due_date <= 45 then '31-45'
    when current_date - i.due_date <= 90 then '46-90'
    else '90+'
  end as bucket
from mis.zoho_invoices i
left join mis.zoho_contacts c on c.contact_id = i.customer_id
left join mis.zoho_sales_orders so on so.salesorder_id = i.salesorder_id
where i.balance > 0;

-- ============ Row-level security ============
do $$
declare t text;
begin
  foreach t in array array['project_lines','billing_stages','stage_events','sub_consultants','sub_consultant_stages',
                           'staff','zoho_contacts','zoho_sales_orders','zoho_invoices','zoho_payments',
                           'agent_decisions','import_runs']
  loop
    execute format('alter table mis.%I enable row level security', t);
    execute format('create policy "signed-in users read" on mis.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- People may add workflow events and agent decisions, as themselves only. Nothing else is writable from the app;
-- imports use the service-role key, which bypasses RLS.
create policy "signed-in users add stage events" on mis.stage_events
  for insert to authenticated with check (actor = auth.uid());
create policy "signed-in users add decisions" on mis.agent_decisions
  for insert to authenticated with check (actor = auth.uid());

-- Privileges (RLS above still filters rows). anon gets nothing in this schema.
grant select on all tables in schema mis to authenticated;
grant insert on mis.stage_events, mis.agent_decisions to authenticated;
grant usage, select on all sequences in schema mis to authenticated;
grant all on all tables in schema mis to service_role;
grant usage, select on all sequences in schema mis to service_role;

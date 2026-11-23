-- F1 PO intake inbox, F2 billing/cash forecast, F4 leakage list. Additive only: no existing table loses data.
-- Run after 20261118000000_po_plan_finance_rbac.sql. Server writes use the service role; RLS lets signed-in users read.

-- =====================================================================
-- F1 · PO intake: every email / file the watcher (or a person) brings in
-- =====================================================================
create table if not exists mis.po_inbox (
  id bigint generated always as identity primary key,
  source text not null default 'upload' check (source in ('mailbox','upload','folder','assistant')),
  mailbox text,                                   -- e.g. projects@ shared mailbox
  message_id text,                                -- Graph message id or file hash: makes re-scans idempotent (R23)
  subject text, sender text, received_at timestamptz,
  attachment_name text, attachment_pages int, attachment_bytes int,
  file_path text,                                 -- object path in the private 'po-files' storage bucket
  classification text not null default 'unknown'
    check (classification in ('unknown','po','amendment','duplicate','not_po')),
  status text not null default 'detected'
    check (status in ('detected','staged','merged','rejected','skipped','error')),
  po_id bigint references mis.purchase_orders on delete set null,
  matched_project_number text,                    -- tracker project the email / PO matched to
  duplicate_of_po bigint references mis.purchase_orders on delete set null,
  skip_reason text, error text,
  detected_by text, detected_at timestamptz not null default now(),
  merged_at timestamptz,
  unique (source, message_id)
);
create index if not exists po_inbox_status on mis.po_inbox (status, detected_at desc);

-- Per-field extraction with confidence and source page (R02), so a reviewer sees which field is shaky.
create table if not exists mis.po_field_extractions (
  id bigint generated always as identity primary key,
  po_id bigint not null references mis.purchase_orders on delete cascade,
  field text not null, value text, confidence numeric check (confidence between 0 and 1),
  source_page int, note text,
  unique (po_id, field)
);

-- Watcher run log (R21): one row per mailbox scan or manual load.
create table if not exists mis.po_scan_runs (
  id bigint generated always as identity primary key,
  source text not null, started_at timestamptz not null default now(), finished_at timestamptz,
  scanned int not null default 0, detected int not null default 0, skipped int not null default 0,
  ok boolean, error text, run_by text
);

-- Change log for tracker merges (BR13 / R04): previous values are kept, never overwritten silently.
create table if not exists mis.tracker_history (
  id bigint generated always as identity primary key,
  table_name text not null, row_id bigint, project_number text, studio text,
  field text not null, old_value text, new_value text,
  po_id bigint references mis.purchase_orders on delete set null,
  changed_by text, changed_at timestamptz not null default now()
);
create index if not exists tracker_history_project on mis.tracker_history (project_number, changed_at desc);

alter table mis.purchase_orders add column if not exists inbox_id bigint references mis.po_inbox on delete set null;
alter table mis.purchase_orders add column if not exists corrected_by text;
alter table mis.purchase_orders add column if not exists corrected_at timestamptz;

-- =====================================================================
-- F2 · Forecast: probability-weighted billing and expected cash
-- =====================================================================
create table if not exists mis.forecast_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  fy text not null, month date not null,          -- month the run was made in (first day)
  studio text not null default 'All',
  model_version text not null,
  manual_outlook numeric, expected_billing numeric, low numeric, high numeric,
  billed_ytd numeric, cash_by_fy_end numeric, cash_low numeric, cash_high numeric,
  by_month jsonb, params jsonb, run_by text,
  unique (month, studio, model_version)           -- one snapshot per month: the backtest compares it with actuals
);
create table if not exists mis.forecast_items (
  id bigint generated always as identity primary key,
  run_id bigint not null references mis.forecast_runs on delete cascade,
  project_number text not null, studio text, seq int,
  client_name text, stage text, fee numeric,
  probability numeric, expected_month date, expected_cash_month date, basis text
);
create index if not exists forecast_items_run on mis.forecast_items (run_id);

-- Days from invoice to payment per customer, from the Zoho Books mirror (sample data until Zoho is connected).
create or replace view mis.v_client_payment_days with (security_invoker = true) as
select c.contact_id, coalesce(c.company_name, c.contact_name) as customer_name,
       count(*) as paid_invoices,
       round(avg(p.date - i.date))::int as avg_days,
       round(percentile_cont(0.5) within group (order by p.date - i.date))::int as median_days
from mis.zoho_payments p
cross join lateral jsonb_array_elements(p.invoices) x
join mis.zoho_invoices i on i.invoice_id = x ->> 'invoice_id'
join mis.zoho_contacts c on c.contact_id = i.customer_id
where p.date >= i.date
group by c.contact_id, coalesce(c.company_name, c.contact_name);

-- =====================================================================
-- F4 · Leakage: weekly ranked list, each item owned and decided by a person
-- =====================================================================
create table if not exists mis.leakage_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(), run_by text,
  open_items int, new_items int, at_stake numeric, counts jsonb
);
create table if not exists mis.leakage_items (
  id bigint generated always as identity primary key,
  item_key text not null unique,                  -- stable across runs, e.g. complete_not_billed|R-2223-002|Structural|7
  kind text not null check (kind in ('billed_not_collected','complete_not_billed','lapsed_with_value','stages_over_100','under_billed_fee','stalled_approval','tracker_mismatch')),
  project_number text, studio text, seq int, row_no int,
  title text not null, detail text, evidence text,
  amount numeric,                                 -- ₹ impact; null when it cannot be sized
  owner text,                                     -- studio director (studio) or Finance / Planning & MIS
  first_seen_run bigint references mis.leakage_runs, last_seen_run bigint references mis.leakage_runs,
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','confirmed','corrected','dismissed','resolved')),
  decided_by text, decided_at timestamptz, reason text, corrected_value numeric
);
create index if not exists leakage_items_status on mis.leakage_items (status, amount desc nulls last);

-- =====================================================================
-- access
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['po_inbox','po_field_extractions','po_scan_runs','tracker_history','forecast_runs','forecast_items','leakage_runs','leakage_items']
  loop
    execute format('alter table mis.%I enable row level security', t);
    execute format('drop policy if exists "signed-in users read" on mis.%I', t);
    execute format('create policy "signed-in users read" on mis.%I for select to authenticated using (true)', t);
    execute format('grant select on mis.%I to authenticated', t);
    execute format('grant all on mis.%I to service_role', t);
  end loop;
end $$;
grant select on mis.v_client_payment_days to authenticated, service_role;
grant usage, select on all sequences in schema mis to service_role;

-- The private 'po-files' storage bucket for PO scans is created by `npm run load-pos` (service role), not here.

notify pgrst, 'reload schema';

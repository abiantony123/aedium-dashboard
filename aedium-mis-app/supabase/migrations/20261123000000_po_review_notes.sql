-- PO intake agent (Cowork / Managed Agent): suggested fixes for failed checks. Additive only.
-- The agent writes a suggestion with its evidence; it never edits the PO. A reviewer applies or dismisses it.
-- Run after 20261122000000_po_inbox_forecast_leakage.sql.

create table if not exists mis.po_review_notes (
  id bigint generated always as identity primary key,
  po_id bigint not null references mis.purchase_orders on delete cascade,
  check_rule text not null,                 -- the failed check, as shown in the PO's checks
  suggestion text not null,                 -- what to change, in plain words
  evidence text not null,                   -- where it comes from: page, past PO, tracker list
  proposed_value text,                      -- the value to use, when there is one
  status text not null default 'open' check (status in ('open','applied','dismissed')),
  created_by text, created_at timestamptz not null default now(),
  decided_by text, decided_at timestamptz
);
create index if not exists po_review_notes_po on mis.po_review_notes (po_id, status);

alter table mis.po_review_notes enable row level security;
drop policy if exists "signed-in users read" on mis.po_review_notes;
create policy "signed-in users read" on mis.po_review_notes for select to authenticated using (true);
grant select on mis.po_review_notes to authenticated;
grant all on mis.po_review_notes to service_role;
grant usage, select on all sequences in schema mis to service_role;

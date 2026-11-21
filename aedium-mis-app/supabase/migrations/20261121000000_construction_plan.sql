-- R11: confirmed construction start (and optional duration) per project line.
-- Run in the Supabase SQL Editor after the earlier migrations. Until it is run, the Plan tab keeps today's behaviour
-- (instalments counted from next month) and shows a notice; nothing else depends on this table.
create table if not exists mis.construction_plan (
  project_number text not null,
  studio text not null default '',                 -- '' when the line has no studio, matching "project|studio" keys in the app
  start_month date not null,                        -- first day of the month construction billing starts
  months int check (months is null or months between 1 and 120),   -- null = use the duration read from the PO / contract
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (project_number, studio)
);
alter table mis.construction_plan enable row level security;
drop policy if exists "signed-in users read" on mis.construction_plan;
create policy "signed-in users read" on mis.construction_plan for select to authenticated using (true);
grant select on mis.construction_plan to authenticated;
grant all on mis.construction_plan to service_role;

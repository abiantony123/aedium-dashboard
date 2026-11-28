-- Replace the old, empty kb_* tables with the knowledge-base tables the app uses, then run the full migration.
-- Run in Supabase > SQL Editor (paste all, then Run).
--
-- Why: mis.kb_documents, kb_chunks, kb_ingest_runs and kb_ask_log already existed with a different layout,
-- so "create table if not exists" kept the old ones. All four were empty on 28 Nov 2026 and no code in this
-- repository uses the old layout.
--
-- Safety: the block below stops the whole script, changing nothing, if any of the four tables has a row.

do $$
declare t text; n bigint;
begin
  foreach t in array array['kb_documents','kb_chunks','kb_ingest_runs','kb_ask_log'] loop
    if to_regclass('mis.' || t) is not null then
      execute format('select count(*) from mis.%I', t) into n;
      if n > 0 then raise exception 'mis.% has % row(s); nothing was dropped. Tell Claude before going further.', t, n; end if;
    end if;
  end loop;
end $$;

drop function if exists mis.kb_search(text, extensions.vector, text[], text, text, boolean, int);
drop table if exists mis.kb_chunks cascade;
drop table if exists mis.kb_documents cascade;
drop table if exists mis.kb_ingest_runs cascade;
drop table if exists mis.kb_ask_log cascade;

-- ===== full migration 20261128000000_kb_pgvector.sql follows =====

-- Knowledge base for Ask AI (RAG phase 1): approved and amended POs as searchable, cited passages.
-- pgvector in the existing database; tables live in the mis schema so the app's API client reaches them.
-- Safe to run twice.

create extension if not exists vector with schema extensions;

-- One row per indexed document (a PO version now; OneDrive files in phase 2).
create table if not exists mis.kb_documents (
  id bigint generated always as identity primary key,
  source text not null check (source in ('po','onedrive','upload')),
  source_ref text not null,                     -- PO id, or the Graph driveItem id in phase 2
  title text not null,
  departments text[] not null,                  -- any of legal, finance, project
  doc_type text,                                -- po, amendment, additional, rework, contract, nda, mom ...
  project_number text, client_name text, studios text[],
  po_id bigint references mis.purchase_orders on delete cascade,
  po_number text, version int,
  is_current boolean not null default true,     -- false once a later approved version of the same PO exists
  sensitivity text not null default 'normal' check (sensitivity in ('normal','confidential','nda')),
  file_path text,                               -- object path in the private 'po-files' bucket
  source_url text,                              -- OneDrive web URL in phase 2
  content_hash text,
  status text not null default 'pending' check (status in ('pending','indexed','needs_review','excluded','failed')),
  error text, pages int, chunk_count int, embedded boolean not null default false,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, source_ref)
);
create index if not exists kb_documents_po on mis.kb_documents (po_number, version);

-- Searchable passages: vector + keyword in one table, filter columns copied from the document.
create table if not exists mis.kb_chunks (
  id bigint generated always as identity primary key,
  document_id bigint not null references mis.kb_documents on delete cascade,
  seq int not null,
  page_from int, page_to int,
  heading text,
  content text not null,
  embedding extensions.vector(1024),            -- null until VOYAGE_API_KEY is set; keyword search still works
  departments text[] not null,
  project_number text, studios text[],
  is_current boolean not null default true,
  -- slashes and underscores become spaces so "NWR/PO/2026/0141" also matches nwr, po, 2026, 0141
  fts tsvector generated always as (to_tsvector('english', regexp_replace(coalesce(heading, '') || ' ' || content, '[/_\\]', ' ', 'g'))) stored,
  unique (document_id, seq)
);
create index if not exists kb_chunks_embedding on mis.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists kb_chunks_fts on mis.kb_chunks using gin (fts);
create index if not exists kb_chunks_departments on mis.kb_chunks using gin (departments);
create index if not exists kb_chunks_project on mis.kb_chunks (project_number) where is_current;

-- Run log (R21) and question log.
create table if not exists mis.kb_ingest_runs (
  id bigint generated always as identity primary key,
  source text not null, started_at timestamptz not null default now(), finished_at timestamptz,
  documents int not null default 0, chunks int not null default 0, failed int not null default 0,
  ok boolean, error text, run_by text
);
create table if not exists mis.kb_ask_log (
  id bigint generated always as identity primary key,
  asked_at timestamptz not null default now(),
  user_email text, role text, departments text[], question text not null,
  chunk_ids bigint[], answer_ok boolean
);

-- Departments the signed-in user may read (mirrors departmentsFor in lib/kb.ts).
create or replace function mis.kb_my_departments() returns text[]
language sql stable security definer set search_path = mis as $$
  select case coalesce((select role from mis.user_roles where email = lower(auth.jwt() ->> 'email')), 'employee')
    when 'admin' then array['legal','finance','project']
    when 'ceo' then array['legal','finance','project']
    when 'finance' then array['finance']
    when 'project_manager' then array['project']
    else array[]::text[] end
$$;

alter table mis.kb_documents enable row level security;
alter table mis.kb_chunks enable row level security;
alter table mis.kb_ingest_runs enable row level security;
alter table mis.kb_ask_log enable row level security;
drop policy if exists "kb documents by department" on mis.kb_documents;
create policy "kb documents by department" on mis.kb_documents for select to authenticated
  using (departments && mis.kb_my_departments() and sensitivity <> 'nda');
drop policy if exists "kb chunks by department" on mis.kb_chunks;
create policy "kb chunks by department" on mis.kb_chunks for select to authenticated
  using (departments && mis.kb_my_departments());
-- ingest runs and the ask log: service role only (no policy = no access for signed-in users).

-- Hybrid search: keyword (OR of the question's words) and vector ranks merged by reciprocal rank fusion.
-- depts is always passed by the server from the caller's role; RLS applies too when called as a signed-in user.
create or replace function mis.kb_search(
  q_tsquery text,                               -- 'escalation | northwind | clause', built by the server
  q_embedding extensions.vector(1024) default null,
  depts text[] default '{}',
  studio_filter text default null,
  project text default null,
  include_superseded boolean default false,
  k int default 40
) returns table (
  chunk_id bigint, document_id bigint, title text, doc_type text, po_number text, version int, is_current boolean,
  project_number text, file_path text, source_url text, page_from int, page_to int, heading text, content text, score double precision
)
language sql stable set search_path = mis, extensions, public as $$
  with base as (
    select c.* from mis.kb_chunks c
    where c.departments && depts
      and (include_superseded or c.is_current)
      and (project is null or c.project_number = project)
      and (studio_filter is null or c.studios is null or studio_filter = any (c.studios))
  ),
  kw as (
    select b.id, row_number() over (order by ts_rank_cd(b.fts, to_tsquery('english', q_tsquery)) desc) as r
    from base b
    where coalesce(q_tsquery, '') <> '' and b.fts @@ to_tsquery('english', q_tsquery)
    order by r limit k
  ),
  vec as (
    select b.id, row_number() over (order by b.embedding <=> q_embedding) as r
    from base b
    where q_embedding is not null and b.embedding is not null
    order by b.embedding <=> q_embedding limit k
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as score from (select * from kw union all select * from vec) u group by id
  )
  select c.id, c.document_id, d.title, d.doc_type, d.po_number, d.version, d.is_current,
         c.project_number, d.file_path, d.source_url, c.page_from, c.page_to, c.heading, c.content, f.score
  from fused f
  join mis.kb_chunks c on c.id = f.id
  join mis.kb_documents d on d.id = c.document_id
  where d.status = 'indexed' and d.sensitivity <> 'nda'
  order by f.score desc
  limit k
$$;

-- Grants (same pattern as the earlier migrations) and refresh the API's schema cache.
grant select on mis.kb_documents, mis.kb_chunks to authenticated;
grant all on mis.kb_documents, mis.kb_chunks, mis.kb_ingest_runs, mis.kb_ask_log to service_role;
grant usage, select on all sequences in schema mis to service_role;
grant execute on function mis.kb_my_departments() to authenticated, service_role;
grant execute on function mis.kb_search(text, extensions.vector, text[], text, text, boolean, int) to authenticated, service_role;
notify pgrst, 'reload schema';

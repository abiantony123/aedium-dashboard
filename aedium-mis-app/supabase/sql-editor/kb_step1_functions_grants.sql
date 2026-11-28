-- STEP 1 of 2 - run in Supabase > SQL Editor (paste all, then Run).
-- Finishes the knowledge-base migration: search functions, row-level security, grants, and a schema refresh.
-- Safe to run more than once. The tables from 20261128000000_kb_pgvector.sql must already exist.

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

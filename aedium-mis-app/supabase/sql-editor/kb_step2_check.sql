-- STEP 2 of 2 - run in Supabase > SQL Editor after step 1. Read-only: changes nothing.
-- Every row should say ok. Send a screenshot of the result if any row says MISSING.

select 'extension vector' as item,
       case when exists (select 1 from pg_extension where extname = 'vector') then 'ok' else 'MISSING' end as status
union all
select 'table ' || t,
       case when to_regclass('mis.' || t) is not null then 'ok' else 'MISSING' end
from unnest(array['kb_documents', 'kb_chunks', 'kb_ingest_runs', 'kb_ask_log']) as t
union all
select 'function ' || f,
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'mis' and p.proname = f) then 'ok' else 'MISSING' end
from unnest(array['kb_search', 'kb_my_departments']) as f
union all
select 'service_role can write kb_chunks',
       case when has_table_privilege('service_role', 'mis.kb_chunks', 'INSERT') then 'ok' else 'MISSING' end
union all
select 'service_role can run kb_search',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'mis' and p.proname = 'kb_search'
                           and has_function_privilege('service_role', p.oid, 'EXECUTE')) then 'ok' else 'MISSING' end
union all
select 'HNSW vector index',
       case when to_regclass('mis.kb_chunks_embedding') is not null then 'ok' else 'MISSING' end
union all
select 'approved POs to index', (select count(*)::text from mis.purchase_orders where status = 'approved');

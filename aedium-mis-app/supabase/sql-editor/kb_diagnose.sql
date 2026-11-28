-- Read-only diagnostic for the kb_* objects. Run in Supabase > SQL Editor and send a screenshot of the result.
-- Shows what each kb_* object is (table, view...), how many rows it has, and its columns.

select c.relname as object,
       case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'materialized view'
                      when 'p' then 'partitioned table' when 'f' then 'foreign table' else c.relkind::text end as kind,
       n.nspname as schema,
       (select string_agg(a.attname, ', ' order by a.attnum) from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relname in ('kb_documents', 'kb_chunks', 'kb_ingest_runs', 'kb_ask_log')
order by n.nspname, c.relname;

// Index every approved PO into the knowledge base (RAG phase 1), and fill missing embeddings.
// Usage (from aedium-mis-app):
//   npx tsx scripts/kb-backfill.ts               index approved POs that are not indexed yet
//   npx tsx scripts/kb-backfill.ts --all         re-index every approved PO
//   npx tsx scripts/kb-backfill.ts --embed       only fill embeddings missing since VOYAGE_API_KEY was added
//   add --no-ocr to skip Claude reading of scanned PDFs
// Writes only mis.kb_* tables. Needs the migration 20261128000000_kb_pgvector.sql.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { indexPo, embedMissing } from "../lib/kb-index";
import { embeddingsOn } from "../lib/kb";

config({ path: ".env.local" });
const args = new Set(process.argv.slice(2));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "mis" }, auth: { persistSession: false } });

async function main() {
  console.log(`Embeddings: ${embeddingsOn() ? "Voyage (hybrid search)" : "off - set VOYAGE_API_KEY for vector search; keyword search works now"}`);
  if (args.has("--embed")) { console.log(`Embedded ${await embedMissing(sb)} passages.`); return; }

  const { data: run } = await sb.from("kb_ingest_runs").insert({ source: "po", run_by: "kb-backfill" }).select("id").single();
  const { data: pos, error } = await sb.from("purchase_orders").select("id,po_number,version").eq("status", "approved").order("id");
  if (error) throw new Error(error.message);
  const { data: done } = await sb.from("kb_documents").select("po_id").eq("source", "po").eq("status", "indexed");
  const indexed = new Set(((done ?? []) as { po_id: number }[]).map((d) => d.po_id));
  const todo = ((pos ?? []) as { id: number; po_number: string; version: number }[]).filter((p) => args.has("--all") || !indexed.has(p.id));
  console.log(`${pos?.length ?? 0} approved POs, ${todo.length} to index.`);

  let chunks = 0, failed = 0;
  for (const p of todo) {
    const r = await indexPo(sb, p.id, { ocr: !args.has("--no-ocr") });
    if (r.status === "indexed") chunks += r.chunks ?? 0; else if (r.status === "failed") failed++;
    console.log(`  ${p.po_number} v${p.version}: ${r.status}${r.chunks ? `, ${r.chunks} passages` : ""}${r.error ? ` - ${r.error}` : ""}`);
  }
  if (run) await sb.from("kb_ingest_runs").update({ finished_at: new Date().toISOString(), documents: todo.length - failed, chunks, failed, ok: failed === 0 }).eq("id", (run as { id: number }).id);
  console.log(`Done: ${todo.length - failed} indexed, ${failed} failed, ${chunks} passages.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

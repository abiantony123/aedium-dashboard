// Index one approved PO version into the knowledge base: a "PO card" passage from the structured rows,
// the amendment diff (when there is one), and the PDF text split into passages with page numbers.
// Writes only mis.kb_* rows; never touches tracker data (BR13). Re-running replaces that PO's passages (R23).
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { extractText, getDocumentProxy } from "unpdf";
import { after } from "next/server";
import type { Db } from "./supabase/server";
import { chunkPages, embed, embeddingsOn, toVector, type Chunk, type Page } from "./kb";

const OCR_MODEL = process.env.PO_OCR_MODEL || process.env.ASK_MODEL || "claude-opus-5-5";
const inr = (v: unknown) => (v == null || v === "" ? "not stated" : `₹${Math.round(Number(v)).toLocaleString("en-IN")}`);
const pct = (v: unknown) => (v == null ? "" : `${Math.round(Number(v) * 1000) / 10}%`);
const KIND: Record<string, string> = { new: "new order", amendment: "amendment", additional: "additional order", rework: "rework order" };

type Header = Record<string, unknown> & { id: number; po_number: string; version: number; kind: string; status: string };
type Line = { studio: string; split_value: number | null; split_pct: number | null; design_value: number | null; construction_value: number | null };
type Stage = { studio: string; seq: number; stage: string; pct: number | null; fee: number | null; is_construction: boolean; instalments: number | null };

export function poCard(h: Header, lines: Line[], stages: Stage[]): string {
  const s = (k: string) => (h[k] == null || h[k] === "" ? "not stated" : String(h[k]));
  const out = [
    `Purchase order ${h.po_number}, version ${h.version} (${KIND[h.kind] ?? h.kind}), status ${h.status}.`,
    `Client: ${s("client_name")}. Project: ${s("project_name")} (project number ${s("project_number")}). Location: ${s("location")}. Project type: ${s("project_type")}.`,
    `PO date: ${s("po_date")}. Start date: ${s("start_date")}. End date: ${s("end_date")}. Contract validity: ${s("contract_validity")}. Escalation clause: ${s("escalation_clause")}.`,
    `Total PO value: ${inr(h.total_value)} ${h.gst_included ? "including" : "excluding"} GST.`,
  ];
  if (lines.length) out.push(`Studio split: ${lines.map((l) => `${l.studio} ${inr(l.split_value)}${l.split_pct != null ? ` (${pct(l.split_pct)})` : ""}`).join("; ")}.`);
  for (const studio of [...new Set(stages.map((x) => x.studio))]) {
    const st = stages.filter((x) => x.studio === studio).sort((a, b) => a.seq - b.seq);
    out.push(`Payment stages for ${studio}: ${st.map((x) => `${x.seq}. ${x.stage} ${pct(x.pct)}${x.fee != null ? ` (${inr(x.fee)})` : ""}${x.is_construction ? `, construction stage${x.instalments ? ` in ${x.instalments} monthly instalments` : ""}` : ""}`).join("; ")}.`);
  }
  if (h.review_note) out.push(`Review note: ${String(h.review_note)}`);
  if (h.source_ref) out.push(`Source: ${h.source ? `${String(h.source)} ` : ""}${String(h.source_ref)}`);
  return out.join("\n");
}

function diffText(h: Header): string | null {
  const d = h.diff as unknown;
  if (!d || (typeof d === "object" && !Array.isArray(d) && !Object.keys(d as object).length)) return null;
  const fmt = (v: unknown) => (typeof v === "number" ? (v > 1000 ? inr(v) : String(v)) : typeof v === "string" ? v : JSON.stringify(v));
  const lines = Array.isArray(d)
    ? d.map((x) => (x && typeof x === "object" ? Object.entries(x as Record<string, unknown>).map(([k, v]) => `${k}: ${fmt(v)}`).join(", ") : fmt(x)))
    : Object.entries(d as Record<string, unknown>).map(([k, v]) => `${k}: ${fmt(v)}`);
  return `Changes in ${h.po_number} version ${h.version} (${KIND[h.kind] ?? h.kind}) compared with the earlier version:\n${lines.join("\n")}`;
}

// PDF text per page; scanned pages (no text layer) are read by Claude when an Anthropic key is set.
async function pdfPages(bytes: Uint8Array, name: string, allowOcr: boolean): Promise<Page[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => ({ page: i + 1, text: t ?? "" }));
  const chars = pages.reduce((a, p) => a + p.text.trim().length, 0);
  if (chars >= 200 || !allowOcr || !process.env.ANTHROPIC_API_KEY) return pages.filter((p) => p.text.trim());
  const client = new Anthropic();
  const Pages = z.object({ pages: z.array(z.object({ page: z.number().int(), text: z.string() })) });
  const res = await client.messages.parse({
    model: OCR_MODEL, max_tokens: 16000, output_config: { effort: "low", format: zodOutputFormat(Pages) },
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") }, title: name },
      { type: "text", text: "Transcribe the text of every page of this document exactly as printed, page by page. Keep tables as lines of text. Skip blank pages." },
    ] }],
  });
  return (res.parsed_output?.pages ?? []).filter((p) => p.text.trim());
}

export type IndexResult = { po_id: number; status: "indexed" | "skipped" | "failed"; chunks?: number; embedded?: boolean; error?: string };

export async function indexPo(sb: Db, poId: number, opts: { ocr?: boolean } = {}): Promise<IndexResult> {
  const [hq, lq, sq, fq] = await Promise.all([
    sb.from("purchase_orders").select("*").eq("id", poId).single(),
    sb.from("po_lines").select("studio,split_value,split_pct,design_value,construction_value").eq("po_id", poId).order("id"),
    sb.from("po_stages").select("studio,seq,stage,pct,fee,is_construction,instalments").eq("po_id", poId).order("studio").order("seq"),
    sb.from("po_inbox").select("file_path,attachment_name").eq("po_id", poId).not("file_path", "is", null).order("id", { ascending: false }).limit(1),
  ]);
  if (hq.error) return { po_id: poId, status: "failed", error: hq.error.message };
  const h = hq.data as Header;
  if (h.status !== "approved") return { po_id: poId, status: "skipped", error: `PO is ${h.status}; only approved POs are indexed.` };
  const lines = (lq.data ?? []) as Line[], stages = (sq.data ?? []) as Stage[];
  const file = (fq.data ?? [])[0] as { file_path: string; attachment_name: string | null } | undefined;
  const title = `${h.client_name ?? "Client"} PO ${h.po_number}${h.version > 1 ? ` v${h.version}` : ""}`;
  const studios = [...new Set(lines.map((l) => l.studio))];
  const docRow = {
    source: "po", source_ref: String(poId), title, departments: ["project", "finance"],
    doc_type: h.kind === "new" ? "po" : h.kind, project_number: (h.project_number as string | null) ?? null, client_name: (h.client_name as string | null) ?? null,
    studios: studios.length ? studios : null, po_id: poId, po_number: h.po_number, version: h.version, file_path: file?.file_path ?? null,
  };
  const { data: doc, error: de } = await sb.from("kb_documents").upsert({ ...docRow, status: "pending", error: null }, { onConflict: "source,source_ref" }).select("id").single();
  if (de) return { po_id: poId, status: "failed", error: de.message };
  const docId = (doc as { id: number }).id;

  try {
    let pages: Page[] = [];
    if (file?.file_path) {
      const dl = await sb.storage.from("po-files").download(file.file_path);
      if (dl.error) throw new Error(`Could not read ${file.file_path}: ${dl.error.message}`);
      pages = await pdfPages(new Uint8Array(await dl.data.arrayBuffer()), file.attachment_name ?? title, opts.ocr !== false);
    }
    const chunks: Chunk[] = [{ seq: 0, page_from: null, page_to: null, heading: "PO summary", content: poCard(h, lines, stages) }];
    const diff = diffText(h);
    if (diff) chunks.push({ seq: 1, page_from: null, page_to: null, heading: "Amendment changes", content: diff });
    chunks.push(...chunkPages(pages, title, chunks.length));

    const vectors = await embed(chunks.map((c) => `${title}\n${c.heading ?? ""}\n${c.content}`), "document");
    // Latest approved version of this PO number is the current one.
    const { data: versions } = await sb.from("purchase_orders").select("id,version").eq("po_number", h.po_number).eq("status", "approved");
    const vs = (versions ?? []) as { id: number; version: number }[];
    const latest = Math.max(h.version, ...vs.map((v) => v.version));
    const current = h.version >= latest;
    // An older version's PDF text stays current while the latest version has no PDF of its own.
    let keepPdf = false;
    if (!current) {
      const latestId = vs.find((v) => v.version === latest)?.id;
      const { data: lf } = latestId ? await sb.from("po_inbox").select("id").eq("po_id", latestId).not("file_path", "is", null).limit(1) : { data: [] };
      keepPdf = !(lf ?? []).length;
    }

    await sb.from("kb_chunks").delete().eq("document_id", docId);
    const rows = chunks.map((c, i) => ({
      document_id: docId, seq: c.seq, page_from: c.page_from, page_to: c.page_to, heading: c.heading, content: c.content,
      embedding: vectors ? toVector(vectors[i]) : null,
      departments: docRow.departments, project_number: docRow.project_number, studios: docRow.studios, is_current: current || (keepPdf && c.page_from != null),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const r = await sb.from("kb_chunks").insert(rows.slice(i, i + 100));
      if (r.error) throw new Error(r.error.message);
    }
    if (current) {
      // Older versions stay searchable for history questions but drop out of default results.
      const { data: older } = await sb.from("kb_documents").select("id").eq("source", "po").eq("po_number", h.po_number).lt("version", h.version);
      const ids = ((older ?? []) as { id: number }[]).map((o) => o.id);
      if (ids.length) {
        await sb.from("kb_documents").update({ is_current: false }).in("id", ids);
        // Older summary and diff passages always step aside. The older PDF text steps aside only when this version
        // has its own PDF; otherwise it is still the only wording of the contract (this version's diff says what changed).
        const q = sb.from("kb_chunks").update({ is_current: false }).in("document_id", ids);
        await (pages.length ? q : q.is("page_from", null));
      }
    }
    const hash = createHash("sha256").update(chunks.map((c) => c.content).join("\n")).digest("hex");
    await sb.from("kb_documents").update({
      status: "indexed", is_current: current, pages: pages.length || null, chunk_count: rows.length, embedded: !!vectors,
      content_hash: hash, indexed_at: new Date().toISOString(), error: null,
    }).eq("id", docId);
    return { po_id: poId, status: "indexed", chunks: rows.length, embedded: !!vectors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from("kb_documents").update({ status: "failed", error: msg.slice(0, 500) }).eq("id", docId);
    return { po_id: poId, status: "failed", error: msg };
  }
}

// Called from PO approval: index after the response is sent so approving stays fast. A failure is logged and
// recorded on the kb_documents row; it never undoes or blocks the approval.
export function indexPoLater(sb: Db, poId: number) {
  const run = () => indexPo(sb, poId).then((r) => { if (r.status === "failed") console.error(`kb: PO ${poId} not indexed: ${r.error}`); })
    .catch((e) => console.error(`kb: PO ${poId} not indexed`, e));
  try { after(run); } catch { void run(); }   // outside a request (scripts): run now
}

// Fill embeddings for passages stored before VOYAGE_API_KEY was set.
export async function embedMissing(sb: Db, batch = 64): Promise<number> {
  if (!embeddingsOn()) return 0;
  let done = 0;
  for (;;) {
    const { data } = await sb.from("kb_chunks").select("id,heading,content,document_id,kb_documents(title)").is("embedding", null).limit(batch);
    const rows = (data ?? []) as unknown as { id: number; heading: string | null; content: string; kb_documents: { title: string } | null }[];
    if (!rows.length) return done;
    const vecs = await embed(rows.map((r) => `${r.kb_documents?.title ?? ""}\n${r.heading ?? ""}\n${r.content}`), "document");
    if (!vecs) return done;
    for (const [i, r] of rows.entries()) await sb.from("kb_chunks").update({ embedding: toVector(vecs[i]) }).eq("id", r.id);
    done += rows.length;
  }
}

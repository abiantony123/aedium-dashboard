// Knowledge base for Ask AI (RAG phase 1): approved and amended POs stored as passages in pgvector
// (mis.kb_documents / mis.kb_chunks) and searched with keyword + vector search merged by rank.
// Embeddings and reranking use Voyage AI when VOYAGE_API_KEY is set; without it search is keyword-only.
import type { Db } from "./supabase/server";
import type { Role } from "./rbac";

export type Dept = "legal" | "finance" | "project";
export const DEPTS: Dept[] = ["legal", "finance", "project"];

// Departments each role may search. Mirrors mis.kb_my_departments() in the migration.
export function departmentsFor(role: Role): Dept[] {
  switch (role) {
    case "admin": case "ceo": return [...DEPTS];
    case "finance": return ["finance"];
    case "project_manager": return ["project"];
    default: return [];
  }
}

// ---------- Voyage AI (embeddings + rerank) ----------
const EMBED_MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";
const RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL || "rerank-2.5";
export const DIMENSIONS = 1024;
export const embeddingsOn = () => !!process.env.VOYAGE_API_KEY?.trim();

async function voyage<T>(path: "embeddings" | "rerank", body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.voyageai.com/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.VOYAGE_API_KEY!.trim()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Voyage ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// Returns null when no Voyage key is configured (the caller stores no embedding).
export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  if (!embeddingsOn() || !texts.length) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const j = await voyage<{ data: { index: number; embedding: number[] }[] }>("embeddings", {
      input: texts.slice(i, i + 64), model: EMBED_MODEL, input_type: inputType, output_dimension: DIMENSIONS,
    });
    out.push(...[...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

async function rerank(query: string, docs: string[], topK: number): Promise<number[] | null> {
  if (!embeddingsOn() || docs.length <= topK) return null;
  const j = await voyage<{ data: { index: number; relevance_score: number }[] }>("rerank", { query, documents: docs, model: RERANK_MODEL, top_k: topK });
  return j.data.map((d) => d.index);
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;

// ---------- chunking ----------
export type Page = { page: number; text: string };
export type Chunk = { seq: number; page_from: number | null; page_to: number | null; heading: string | null; content: string };
const MAX_CHARS = 2400; // about 600 tokens

function splitLong(s: string): string[] {
  const parts: string[] = [];
  let rest = s;
  while (rest.length > MAX_CHARS) {
    const cut = Math.max(rest.lastIndexOf(". ", MAX_CHARS), rest.lastIndexOf(" ", MAX_CHARS));
    const at = cut > MAX_CHARS * 0.5 ? cut + 1 : MAX_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

// Paragraph-aware chunks that keep their page numbers; a chunk never spans more than MAX_CHARS.
export function chunkPages(pages: Page[], heading: string | null, startSeq = 1): Chunk[] {
  const out: Chunk[] = [];
  let buf = "", from = 0, to = 0;
  const flush = () => {
    const t = buf.trim();
    if (t) out.push({ seq: startSeq + out.length, page_from: from, page_to: to, heading, content: t });
    buf = "";
  };
  for (const p of pages) {
    if (buf.length > 600) flush();   // start a new passage at a page break unless the last one is tiny: citations name one page
    const paras = p.text.replace(/\r/g, "").split(/\n\s*\n/).map((s) => s.replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim()).filter(Boolean);
    for (const para of paras) for (const piece of splitLong(para)) {
      if (buf && buf.length + piece.length + 1 > MAX_CHARS) flush();
      if (!buf) from = p.page;
      buf += (buf ? "\n" : "") + piece;
      to = p.page;
    }
  }
  flush();
  return out;
}

// ---------- search ----------
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "what", "which", "who", "how", "does", "do", "did", "with", "by", "at", "from", "this", "that", "our", "we", "it", "be", "as", "any", "all", "me", "show", "tell", "give", "list", "about"]);

// OR of the question's words, so a passage needs only some of them; ranking rewards those with more.
export function toTsquery(q: string): string {
  const words = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)].slice(0, 24).join(" | ");
}

export type Hit = {
  chunk_id: number; document_id: number; title: string; doc_type: string | null; po_number: string | null; version: number | null;
  is_current: boolean; project_number: string | null; file_path: string | null; source_url: string | null;
  page_from: number | null; page_to: number | null; heading: string | null; content: string; score: number;
};
export type SearchActor = { role: Role; studio: string | null };

export async function searchDocuments(
  sb: Db, actor: SearchActor,
  input: { query: string; project_number?: string | null; include_superseded?: boolean; limit?: number; departments?: Dept[] },
) {
  const allowed = departmentsFor(actor.role);
  const depts = input.departments?.length ? allowed.filter((d) => input.departments!.includes(d)) : allowed;
  if (!depts.length) return { results: [] as (Hit & { n: number })[], departments: depts, mode: "none" as const, note: "This role has no access to documents." };
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 12);
  const qvec = (await embed([input.query], "query"))?.[0] ?? null;
  const { data, error } = await sb.rpc("kb_search", {
    q_tsquery: toTsquery(input.query),
    q_embedding: qvec ? toVector(qvec) : null,
    depts,
    studio_filter: actor.role === "project_manager" ? actor.studio : null,
    project: input.project_number?.trim().toUpperCase().replace(/\s/g, "") || null,
    include_superseded: !!input.include_superseded,
    k: 40,
  });
  if (error) {
    if (/kb_search|kb_chunks/.test(error.message)) throw new Error("Document search is not set up yet: run the migration 20261128000000_kb_pgvector.sql in Supabase.");
    throw new Error(error.message);
  }
  const hits = (data ?? []) as Hit[];
  const order = await rerank(input.query, hits.map((h) => `${h.title}\n${h.content}`), limit).catch(() => null);
  const top = (order ? order.map((i) => hits[i]).filter(Boolean) : hits).slice(0, limit);
  return { results: top.map((h, i) => ({ ...h, n: i + 1 })), departments: depts, mode: qvec ? ("hybrid" as const) : ("keyword" as const) };
}

// Short label for a hit: "Northwind PO NWR/PO/2026/0141 v2 · p. 3".
export function hitLabel(h: Pick<Hit, "title" | "page_from" | "page_to">) {
  const p = h.page_from ? ` · p. ${h.page_from}${h.page_to && h.page_to !== h.page_from ? `–${h.page_to}` : ""}` : "";
  return `${h.title}${p}`;
}

// F1 · PO intake inbox. Every email or file that might be a PO lands in mis.po_inbox (from the mailbox watcher,
// an upload, or an assistant). Extraction stages it as a purchase order with per-field confidence; a reviewer
// corrects, approves (merge with change log), rejects, or marks it "not a PO". Nothing reaches the tracker unreviewed.
import type { Db } from "./supabase/server";
import { assertCan } from "./rbac";
import { notify, who, type Actor } from "./agents/actions";
import { checkPo, getPo, reviewPo, stagePo, type PoIn } from "./po";

export const GATE = 0.9;   // approve is disabled below this confidence (and for failed error checks)
type Check = { rule: string; ok: boolean; severity: "error" | "warning"; detail: string };

export type InboxRow = {
  id: number; source: string; mailbox: string | null; subject: string | null; sender: string | null; received_at: string | null;
  attachment_name: string | null; attachment_pages: number | null; file_path: string | null; classification: string; status: string;
  po_id: number | null; matched_project_number: string | null; duplicate_of_po: number | null; skip_reason: string | null;
  detected_by: string | null; detected_at: string; merged_at: string | null;
};

const PO_COLS = "id,po_number,version,kind,client_name,project_number,project_name,total_value,status,confidence,checks,diff,start_date,end_date,contract_validity,escalation_clause,po_date,source,source_ref,extracted_by,created_at,reviewed_by,reviewed_at,review_note,inbox_id,raw";
type PoRow = {
  id: number; po_number: string; version: number; kind: string; client_name: string | null; project_number: string | null; project_name: string | null;
  total_value: number | null; status: string; confidence: number | null; checks: unknown; diff: unknown; start_date: string | null; end_date: string | null;
  contract_validity: string | null; escalation_clause: string | null; po_date: string | null; source: string | null; source_ref: string | null;
  extracted_by: string | null; created_at: string; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null; inbox_id: number | null; raw: unknown;
};
type FieldRow = { po_id: number; field: string; value: string | null; confidence: number | null; source_page: number | null; note: string | null };

// One shape for every PO shown on the screen: an inbox row (upload, folder, mailbox) or a PO with no inbox row.
function toItem<P extends PoRow>(r: InboxRow | null, po: P | null, fields: FieldRow[]) {
  const checks = ((po?.checks as Check[] | null) ?? []);
  const failed = checks.filter((c) => !c.ok && c.severity === "error");
  const lowFields = fields.filter((f) => f.confidence != null && Number(f.confidence) < GATE);
  const conf = po?.confidence != null ? Number(po.confidence) : null;
  const held = po && po.status === "pending_review" ? (failed.length ? `Failed check: ${failed[0].rule}` : conf != null && conf < GATE ? `Low confidence (${Math.round(conf * 100)}%)` : lowFields.length ? `Low confidence on ${lowFields.map((f) => f.field).join(", ")}` : null) : null;
  const row: InboxRow = r ?? { id: -(po!.id), source: "assistant", mailbox: null, subject: po!.source_ref, sender: po!.extracted_by, received_at: po!.created_at, attachment_name: null, attachment_pages: null, file_path: null, classification: po!.kind === "amendment" ? "amendment" : "po", status: po!.status === "approved" ? "merged" : "staged", po_id: po!.id, matched_project_number: po!.project_number, duplicate_of_po: null, skip_reason: null, detected_by: po!.extracted_by, detected_at: po!.created_at, merged_at: null };
  return { ...row, po, fields, checks, failed: failed.length, held, ready: !!po && po.status === "pending_review" && !held };
}

export async function inbox(sb: Db) {
  const [rows, pos, fields, runs, history] = await Promise.all([
    sb.from("po_inbox").select("*").order("detected_at", { ascending: false }).limit(60),
    sb.from("purchase_orders").select(PO_COLS).order("id", { ascending: false }).limit(60),
    sb.from("po_field_extractions").select("po_id,field,value,confidence,source_page,note").order("id"),
    sb.from("po_scan_runs").select("*").order("id", { ascending: false }).limit(10),
    sb.from("tracker_history").select("table_name,project_number,studio,field,old_value,new_value,po_id,changed_by,changed_at").order("id", { ascending: false }).limit(20),
  ]);
  if (rows.error) throw new Error(rows.error.message);
  const poRows = (pos.data ?? []) as unknown as PoRow[];
  const poBy = new Map(poRows.map((p) => [p.id, p]));
  const fieldsBy = new Map<number, FieldRow[]>();
  for (const f of (fields.data ?? []) as FieldRow[]) fieldsBy.set(f.po_id, [...(fieldsBy.get(f.po_id) ?? []), f]);
  const items = ((rows.data ?? []) as InboxRow[]).map((r) => toItem(r, r.po_id ? poBy.get(r.po_id) ?? null : null, fieldsBy.get(r.po_id ?? -1) ?? []));
  // POs staged with no inbox row (an assistant, or "edit as new version") still show up while they wait for review.
  const linked = new Set(items.map((i) => i.po_id).filter(Boolean));
  const orphans = poRows.filter((p) => !linked.has(p.id) && p.status === "pending_review").map((p) => toItem(null, p, fieldsBy.get(p.id) ?? []));
  const all = [...items, ...orphans].sort((a, b) => b.detected_at.localeCompare(a.detected_at));
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString(), today = new Date().toISOString().slice(0, 10);
  const merged = all.filter((i) => i.merged_at);
  const hours = merged.filter((i) => i.received_at).map((i) => (Date.parse(i.merged_at!) - Date.parse(i.received_at!)) / 3600000).sort((a, b) => a - b);
  const lastScan = (runs.data ?? []).find((r) => r.source === "mailbox") ?? null;
  return {
    items: all.filter((i) => i.status !== "skipped"),
    skipped: all.filter((i) => i.status === "skipped"),
    kpi: {
      detected_week: all.filter((i) => i.detected_at >= weekAgo && i.classification !== "not_po").length,
      ready: all.filter((i) => i.ready).length,
      held: all.filter((i) => i.po?.status === "pending_review" && i.held).length,
      merged_today: merged.filter((i) => i.merged_at!.startsWith(today)).length,
      median_hours: hours.length ? hours[Math.floor(hours.length / 2)] : null,
    },
    runs: runs.data ?? [], lastScan, history: history.data ?? [],
    mailboxConnected: !!process.env.MS_GRAPH_CLIENT_ID,
  };
}

// Register a document as detected (upload, folder, mailbox watcher). Idempotent on (source, message_id).
export async function registerDocument(sb: Db, actor: Actor, d: { source: "mailbox" | "upload" | "folder" | "assistant"; message_id: string; subject?: string; sender?: string; received_at?: string; attachment_name?: string; attachment_pages?: number; attachment_bytes?: number; file_path?: string; mailbox?: string }) {
  assertCan(actor.role, "po.stage");
  const { data: existing } = await sb.from("po_inbox").select("id").eq("source", d.source).eq("message_id", d.message_id).maybeSingle();
  if (existing) return { id: existing.id as number, existed: true };
  const { data, error } = await sb.from("po_inbox").insert({ ...d, detected_by: who(actor) }).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id as number, existed: false };
}

// Attach a staged PO to its inbox row, store per-field confidence, and work out duplicate / amendment.
export async function linkStaged(sb: Db, inboxId: number, poId: number, fields: { field: string; value: string | null; confidence: number; source_page?: number; note?: string }[]) {
  const { data: po } = await sb.from("purchase_orders").select("id,po_number,version,kind,project_number,status,diff").eq("id", poId).single();
  const { data: prior } = await sb.from("purchase_orders").select("id,status").eq("po_number", po!.po_number).neq("id", poId).eq("status", "approved");
  const sameAsApproved = Array.isArray(po!.diff) && (po!.diff as unknown[]).length === 0;
  const classification = sameAsApproved ? "duplicate" : po!.kind === "amendment" ? "amendment" : "po";
  await sb.from("po_inbox").update({ po_id: poId, status: "staged", classification, matched_project_number: po!.project_number, duplicate_of_po: sameAsApproved ? prior?.[0]?.id ?? null : null }).eq("id", inboxId);
  await sb.from("purchase_orders").update({ inbox_id: inboxId }).eq("id", poId);
  if (fields.length) {
    const r = await sb.from("po_field_extractions").upsert(fields.map((f) => ({ po_id: poId, field: f.field, value: f.value, confidence: f.confidence, source_page: f.source_page ?? null, note: f.note ?? null })), { onConflict: "po_id,field" });
    if (r.error) throw new Error(r.error.message);
  }
  return { classification };
}

export async function skipDocument(sb: Db, actor: Actor, inboxId: number, reason: string) {
  assertCan(actor.role, "po.review");
  const { data: row } = await sb.from("po_inbox").select("po_id").eq("id", inboxId).single();
  if (row?.po_id) {
    const { data: po } = await sb.from("purchase_orders").select("status").eq("id", row.po_id).single();
    if (po?.status === "pending_review") await sb.from("purchase_orders").update({ status: "rejected", reviewed_by: who(actor), reviewed_at: new Date().toISOString(), review_note: `Not a PO: ${reason}` }).eq("id", row.po_id);
  }
  const { error } = await sb.from("po_inbox").update({ status: "skipped", classification: "not_po", skip_reason: reason }).eq("id", inboxId);
  if (error) throw new Error(error.message);
}

// "Open and correct": a reviewer fixes extracted values; checks re-run on the corrected PO.
export async function correctPo(sb: Db, actor: Actor, poId: number, patch: { client_name?: string; project_name?: string; location?: string; project_type?: string; po_date?: string; project_number?: string; total_value?: number; start_date?: string; end_date?: string; contract_validity?: string; escalation_clause?: string; lines?: { studio: string; split_value: number }[]; stages?: { id: number; pct: number }[] }) {
  assertCan(actor.role, "po.review");
  const cur = await getPo(sb, poId);
  if (cur.header.status !== "pending_review") throw new Error("Only POs waiting for review can be corrected.");
  const raw = { ...(cur.header.raw as PoIn) };
  for (const k of ["client_name", "project_name", "location", "project_type", "po_date", "project_number", "total_value", "start_date", "end_date", "contract_validity", "escalation_clause"] as const)
    if (patch[k] !== undefined && patch[k] !== "") (raw as Record<string, unknown>)[k] = patch[k];
  const lineVal = new Map((patch.lines ?? []).map((l) => [l.studio, l.split_value]));
  raw.lines = cur.lines.map((l) => ({ studio: l.studio, split_value: lineVal.get(l.studio) ?? (l.split_value != null ? Number(l.split_value) : undefined), split_pct: undefined, design_value: l.design_value ?? undefined, construction_value: l.construction_value ?? undefined }));
  const pctBy = new Map((patch.stages ?? []).map((s) => [s.id, s.pct]));
  raw.stages = cur.stages.map((s) => ({ studio: s.studio, stage: s.stage, pct: pctBy.get(s.id) ?? Number(s.pct ?? 0), fee: undefined, is_construction: s.is_construction, instalments: s.instalments ?? undefined }));
  const { checks, po } = await checkPo(sb, raw);
  const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  const h = await sb.from("purchase_orders").update({
    client_name: po.client_name, project_name: po.project_name, location: po.location ?? null, project_type: po.project_type ?? null, po_date: po.po_date || null,
    project_number: po.project_number?.toUpperCase().replace(/\s/g, "") ?? null, total_value: po.total_value, start_date: po.start_date || null, end_date: po.end_date || null,
    contract_validity: po.contract_validity ?? null, escalation_clause: po.escalation_clause ?? null, checks, raw: po, corrected_by: who(actor), corrected_at: new Date().toISOString(),
    confidence: Math.max(Number(cur.header.confidence ?? 0), GATE),   // a person has checked the shaky fields
  }).eq("id", poId);
  if (h.error) throw new Error(h.error.message);
  for (const l of cur.lines) { const nl = po.lines.find((x) => x.studio === l.studio); await sb.from("po_lines").update({ split_value: nl?.split_value ?? null, split_pct: nl?.split_pct ?? null }).eq("id", l.id); }
  for (const s of cur.stages) { const i = cur.stages.indexOf(s); const ns = po.stages[i]; await sb.from("po_stages").update({ pct: ns.pct, fee: ns.fee ?? null }).eq("id", s.id); }
  // Corrected fields are now human-verified.
  const fieldMap: Record<string, string[]> = { client_name: ["Client"], project_name: ["Project"], location: ["Location"], project_type: ["Project type"], po_date: ["PO date"], project_number: ["Project"], total_value: ["PO value"], start_date: ["Validity", "Start date"], end_date: ["Validity", "End date"], contract_validity: ["Validity"], escalation_clause: ["Escalation"] };
  for (const k of changed) if (fieldMap[k]) await sb.from("po_field_extractions").update({ confidence: 1, note: `Corrected by ${who(actor)}` }).eq("po_id", poId).in("field", fieldMap[k]);
  if (patch.lines?.length) await sb.from("po_field_extractions").update({ confidence: 1, note: `Confirmed by ${who(actor)}` }).eq("po_id", poId).in("field", ["Studio split"]);
  if (patch.stages?.length) await sb.from("po_field_extractions").update({ confidence: 1, note: `Corrected by ${who(actor)}` }).eq("po_id", poId).in("field", ["Stage split"]);
  return { checks, failed: checks.filter((c) => !c.ok && c.severity === "error").length };
}

// Approve = the existing merge, plus: change log of previous values, studio director notified, contract-watch item closed.
export async function approveFromInbox(sb: Db, actor: Actor, poId: number, note?: string, projectNumber?: string) {
  const cur = await getPo(sb, poId);
  // Approve always writes to the tracker. Failed checks and low confidence no longer block it; they are kept as an
  // override note on the PO (and in the change log) so the decision stays auditable.
  const conf = cur.header.confidence != null ? Number(cur.header.confidence) : 1;
  const failed = ((cur.header.checks as Check[] | null) ?? []).filter((c) => !c.ok && c.severity === "error");
  const overrides = [failed.length ? `${failed.length} failed check(s): ${failed.map((c) => c.rule).join("; ")}` : "", conf < GATE ? `confidence ${Math.round(conf * 100)}% below ${GATE * 100}%` : ""].filter(Boolean);
  if (overrides.length) note = [note, `Approved with override by ${who(actor)}: ${overrides.join(" · ")}`].filter(Boolean).join(" | ");
  const pn = ((projectNumber ?? cur.header.project_number ?? "") || await nextProjectNumber(sb, cur.header.po_date as string | null)).toUpperCase().replace(/\s/g, "");
  // Snapshot previous tracker values for the change log before the merge writes.
  const { data: before } = pn ? await sb.from("project_lines").select("id,studio,end_date,start_date,split_value,total_project_value,escalation_clause,contract_validity").eq("project_number", pn) : { data: [] };
  const r = await reviewPo(sb, actor, poId, "approved", note, pn || undefined);
  const { data: after } = await sb.from("project_lines").select("id,studio,end_date,start_date,split_value,total_project_value,escalation_clause,contract_validity").eq("project_number", r.project_number!);
  const log: Record<string, unknown>[] = [];
  for (const a of after ?? []) {
    const b = (before ?? []).find((x) => x.id === a.id);
    for (const f of ["end_date", "start_date", "split_value", "total_project_value", "escalation_clause", "contract_validity"] as const)
      if (String(b?.[f] ?? "") !== String(a[f] ?? "")) log.push({ table_name: "project_lines", row_id: a.id, project_number: r.project_number, studio: a.studio, field: f, old_value: b ? (b[f] == null ? null : String(b[f])) : "(new line)", new_value: a[f] == null ? null : String(a[f]), po_id: poId, changed_by: who(actor) });
  }
  if (log.length) await sb.from("tracker_history").insert(log);
  await sb.from("po_inbox").update({ status: "merged", merged_at: new Date().toISOString(), matched_project_number: r.project_number }).eq("po_id", poId);
  const studios = [...new Set(cur.lines.map((l) => l.studio))];
  await notify(sb, "project_manager", `PO ${cur.header.kind === "amendment" ? "amendment" : ""} merged: ${r.project_number}`.replace("  ", " "), `${cur.header.client_name} · ${studios.join(", ")}${cur.header.end_date ? ` · end date ${cur.header.end_date}` : ""}. Approved by ${who(actor)}.`, "agents", String(poId));
  // A contract that now runs past today no longer needs a contract-watch item.
  if (cur.header.end_date && cur.header.end_date >= new Date().toISOString().slice(0, 10))
    for (const a of after ?? []) await sb.from("agent_decisions").insert({ agent: "contract_watch", ref: String((await sb.from("project_lines").select("row_no").eq("id", a.id).single()).data?.row_no ?? ""), decision: "approved", note: `Closed by PO ${cur.header.po_number} v${cur.header.version}`, actor: actor.id, actor_email: who(actor) });
  return { ...r, changes: log.length, override: overrides.length > 0 };
}

export async function scanLog(sb: Db, actor: Actor, run: { source: string; scanned: number; detected: number; skipped: number; ok: boolean; error?: string }) {
  await sb.from("po_scan_runs").insert({ ...run, finished_at: new Date().toISOString(), run_by: who(actor) });
}

// Next free internal project number for the PO's financial year: R-YYYY-NNN, e.g. R-2627-014.
export async function nextProjectNumber(sb: Db, poDate?: string | null) {
  const d = poDate && /^\d{4}-\d{2}/.test(poDate) ? poDate : new Date().toISOString().slice(0, 10);
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)), fy = m >= 4 ? y : y - 1;
  const code = `${String(fy).slice(2)}${String(fy + 1).slice(2)}`;
  const [a, b] = await Promise.all([
    sb.from("project_lines").select("project_number").ilike("project_number", `R-${code}-%`).limit(2000),
    sb.from("purchase_orders").select("project_number").ilike("project_number", `R-${code}-%`).limit(2000),
  ]);
  const seq = Math.max(0, ...[...(a.data ?? []), ...(b.data ?? [])].map((r) => Number(String(r.project_number).split("-")[2]) || 0));
  return `R-${code}-${String(seq + 1).padStart(3, "0")}`;
}

// Search every PO already in the table (any status) by PO number, client, project or project number.
export async function searchPos(sb: Db, q: string, status?: string) {
  const term = q.trim().replace(/[%,()]/g, " ").slice(0, 80);
  let query = sb.from("purchase_orders").select(PO_COLS).order("id", { ascending: false }).limit(40);
  if (term) query = query.or(["po_number", "client_name", "project_name", "project_number"].map((c) => `${c}.ilike.%${term}%`).join(","));
  if (status && status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const pos = (data ?? []) as unknown as PoRow[];
  if (!pos.length) return [];
  const ids = pos.map((p) => p.id);
  const [rows, fields] = await Promise.all([
    sb.from("po_inbox").select("*").in("po_id", ids),
    sb.from("po_field_extractions").select("po_id,field,value,confidence,source_page,note").in("po_id", ids).order("id"),
  ]);
  const rowBy = new Map(((rows.data ?? []) as InboxRow[]).map((r) => [r.po_id, r]));
  const fieldsBy = new Map<number, FieldRow[]>();
  for (const f of (fields.data ?? []) as FieldRow[]) fieldsBy.set(f.po_id, [...(fieldsBy.get(f.po_id) ?? []), f]);
  return pos.map((p) => toItem(rowBy.get(p.id) ?? null, p, fieldsBy.get(p.id) ?? []));
}

// Edit an approved or rejected PO: stage a new version from its current values so it can be corrected and approved
// again. Approval then updates the same tracker rows; the earlier version and the change log stay as history.
export async function revisePo(sb: Db, actor: Actor, poId: number) {
  assertCan(actor.role, "po.review");
  const cur = await getPo(sb, poId);
  if (cur.header.status === "pending_review") return { po_id: poId, existed: true };
  const { data: open } = await sb.from("purchase_orders").select("id").eq("po_number", cur.header.po_number).eq("status", "pending_review").limit(1).maybeSingle();
  if (open) return { po_id: open.id as number, existed: true };
  const raw = { ...(cur.header.raw as PoIn) };
  const lines = cur.lines.map((l) => ({ studio: l.studio, split_value: l.split_value != null ? Number(l.split_value) : undefined, split_pct: l.split_pct != null ? Number(l.split_pct) : undefined, design_value: l.design_value != null ? Number(l.design_value) : undefined, construction_value: l.construction_value != null ? Number(l.construction_value) : undefined }));
  const stages = cur.stages.map((s) => ({ studio: s.studio, stage: s.stage, pct: Number(s.pct ?? 0), fee: s.fee != null ? Number(s.fee) : undefined, is_construction: !!s.is_construction, instalments: s.instalments ?? undefined }));
  const r = await stagePo(sb, actor, { ...raw, kind: undefined, project_number: cur.header.project_number ?? raw.project_number, confidence: 1, lines, stages, source_ref: `Edit of ${cur.header.po_number} v${cur.header.version}`, notes: [raw.notes, `Revision of v${cur.header.version} opened by ${who(actor)}.`].filter(Boolean).join(" ") });
  const { data: f } = await sb.from("po_field_extractions").select("field,value,confidence,source_page,note").eq("po_id", poId);
  if (f?.length) await sb.from("po_field_extractions").insert(f.map((x) => ({ ...x, po_id: r.po_id })));
  return { po_id: r.po_id, existed: false };
}

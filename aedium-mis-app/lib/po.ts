// PO intake. An assistant (Claude, ChatGPT, Gemini...) reads the PO from Outlook, a folder or an attachment using
// the person's own connectors, then calls stage_po with the extracted fields. Rules check the numbers; a person
// reviews and approves; approval merges the PO into the tracker tables. Amendments are compared to the last
// approved version of the same PO number.
import { z } from "zod";
import type { Db } from "./supabase/server";
import { assertCan } from "./rbac";
import { notify, who, type Actor } from "./agents/actions";

const num = z.number().finite();
export const PoInput = {
  po_number: z.string().min(1).describe("Client PO / work-order number exactly as printed"),
  kind: z.enum(["new", "amendment", "additional", "rework"]).optional().describe("Leave out to auto-detect: an existing PO number becomes an amendment. Additional area or rework usually has its own project number."),
  client_name: z.string().describe("Client or group name, e.g. 'Zonasha'"),
  project_name: z.string(),
  project_number: z.string().optional().describe("Aedium internal project number (R-YYYY-NNN) if known; Finance assigns it otherwise"),
  location: z.string().optional(), project_type: z.string().optional(),
  po_date: z.string().optional().describe("YYYY-MM-DD"), start_date: z.string().optional(), end_date: z.string().optional(),
  contract_validity: z.string().optional().describe("As written, e.g. '36 months'"),
  escalation_clause: z.string().optional().describe("As written, e.g. '10% every year after the end date'"),
  total_value: num.describe("Total fee in INR, excluding GST"),
  gst_included: z.boolean().optional(),
  lines: z.array(z.object({
    studio: z.string().describe("Studio as in the tracker: 'Arch - Com', 'Arch - Resi', 'MEPF', 'Structural', 'Landscape', 'Healthcare', 'Interior'..."),
    split_value: num.optional(), split_pct: num.optional().describe("0-1"),
    design_value: num.optional(), construction_value: num.optional(),
  })).min(1).describe("One per studio / vertical in the PO's fee split. A single-studio PO has one line with the whole value."),
  stages: z.array(z.object({
    studio: z.string(), stage: z.string().describe("Stage text as in the PO"),
    pct: num.describe("Share of that studio's fee, 0-1"), fee: num.optional().describe("INR excl. GST; computed from pct when missing"),
    is_construction: z.boolean().optional(), instalments: z.number().int().optional().describe("For construction fees paid monthly, the number of months"),
  })).min(1),
  source: z.enum(["outlook", "folder", "attachment", "upload", "other"]).optional(),
  source_ref: z.string().optional().describe("Mail subject, file name or path, so a reviewer can find the original"),
  confidence: z.number().min(0).max(1).optional().describe("Your confidence in the extraction, 0-1"),
  notes: z.string().optional().describe("Anything unclear: fields you could not read, assumptions you made"),
};
const PoSchema = z.object(PoInput);
export type PoIn = z.infer<typeof PoSchema>;
type Check = { rule: string; ok: boolean; severity: "error" | "warning"; detail: string };

// Money: relative tolerance with a ₹1 floor. Percentages (0-1): absolute tolerance.
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.max(tol * Math.abs(b), 1);
const samePct = (a: number, b: number, tol = 0.00005) => Math.abs(a - b) <= tol;
const iso = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : null);

export async function checkPo(sb: Db, po: PoIn): Promise<{ checks: Check[]; po: PoIn }> {
  const c: Check[] = [];
  const add = (rule: string, ok: boolean, severity: Check["severity"], detail: string) => c.push({ rule, ok, severity, detail });
  // Fill split values / fees from percentages where only one side is given.
  for (const l of po.lines) {
    if (l.split_value == null && l.split_pct != null) l.split_value = Math.round(l.split_pct * po.total_value);
    if (l.split_pct == null && l.split_value != null && po.total_value) l.split_pct = l.split_value / po.total_value;
  }
  if (po.lines.length === 1 && po.lines[0].split_value == null) { po.lines[0].split_value = po.total_value; po.lines[0].split_pct = 1; }
  const lineBy = new Map(po.lines.map((l) => [l.studio, l]));
  for (const s of po.stages) { const l = lineBy.get(s.studio); if (s.fee == null && l?.split_value != null) s.fee = Math.round(s.pct * l.split_value); }

  const splitSum = po.lines.reduce((a, l) => a + (l.split_value ?? 0), 0);
  add("BR03 studio split adds to the PO value", close(splitSum, po.total_value, 0.01), "error", `Split ₹${Math.round(splitSum).toLocaleString("en-IN")} vs PO ₹${Math.round(po.total_value).toLocaleString("en-IN")}`);
  for (const l of po.lines) {
    const st = po.stages.filter((s) => s.studio === l.studio);
    const pct = st.reduce((a, s) => a + s.pct, 0);
    add(`BR04 ${l.studio}: stage % adds to 100%`, samePct(pct, 1, 0.005), "error", `${(pct * 100).toFixed(2)}% over ${st.length} stages`);
    const feeSum = st.reduce((a, s) => a + (s.fee ?? 0), 0);
    if (l.split_value != null) add(`BR05 ${l.studio}: stage fees add to the studio value`, close(feeSum, l.split_value, 0.01), "error", `Fees ₹${Math.round(feeSum).toLocaleString("en-IN")} vs ₹${Math.round(l.split_value).toLocaleString("en-IN")}`);
    for (const s of st) if (s.fee != null && l.split_value != null && !close(s.fee, s.pct * l.split_value, 0.01))
      add(`BR05 ${l.studio}: fee matches % for "${s.stage.slice(0, 40)}"`, false, "warning", `₹${s.fee} vs ${(s.pct * 100).toFixed(2)}% of ₹${l.split_value}`);
  }
  const orphan = po.stages.filter((s) => !lineBy.has(s.studio)).map((s) => s.studio);
  if (orphan.length) add("Every stage belongs to a studio line", false, "error", `No fee line for: ${[...new Set(orphan)].join(", ")}`);
  const { data: known } = await sb.from("project_lines").select("studio").not("studio", "is", null).limit(2000);
  const studios = new Set((known ?? []).map((r) => r.studio));
  const unknown = po.lines.map((l) => l.studio).filter((s) => !studios.has(s));
  add("Studios match the tracker's names", !unknown.length, "warning", unknown.length ? `New studio name(s): ${unknown.join(", ")}` : "All known");
  add("Internal project number present", !!po.project_number && /^R-?\d{4}-\d{2,4}$/i.test(po.project_number.replace(/\s/g, "")), "warning", po.project_number ? po.project_number : "Missing: Finance assigns it before approval");
  if (po.start_date || po.end_date) add("Dates are valid and in order", !!iso(po.start_date) && !!iso(po.end_date) && po.start_date! <= po.end_date!, "warning", `${po.start_date ?? "?"} to ${po.end_date ?? "?"}`);
  if (po.confidence != null) add("Extraction confidence ≥ 0.9", po.confidence >= 0.9, "warning", `${Math.round(po.confidence * 100)}%`);
  return { checks: c, po };
}

function diffPo(prev: { header: Record<string, unknown>; lines: { studio: string; split_value: number | null }[]; stages: { studio: string; seq: number; stage: string; pct: number | null; fee: number | null }[] }, next: PoIn) {
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  for (const f of ["client_name", "project_name", "project_number", "start_date", "end_date", "contract_validity", "escalation_clause", "total_value"] as const)
    if (String(prev.header[f] ?? "") !== String(next[f] ?? "")) changes.push({ field: f, from: prev.header[f] ?? null, to: next[f] ?? null });
  for (const l of next.lines) {
    const p = prev.lines.find((x) => x.studio === l.studio);
    if (!p) changes.push({ field: `line ${l.studio}`, from: null, to: l.split_value });
    else if (!close(Number(p.split_value ?? 0), l.split_value ?? 0, 0.001)) changes.push({ field: `split ${l.studio}`, from: p.split_value, to: l.split_value });
  }
  for (const p of prev.lines) if (!next.lines.some((l) => l.studio === p.studio)) changes.push({ field: `line ${p.studio}`, from: p.split_value, to: null });
  const key = (s: { studio: string; stage: string }) => `${s.studio}|${s.stage.trim().toLowerCase()}`;
  for (const s of next.stages) {
    const p = prev.stages.find((x) => key(x) === key(s));
    if (!p) changes.push({ field: `stage added (${s.studio})`, from: null, to: `${s.stage} · ${(s.pct * 100).toFixed(2)}%` });
    else if (!samePct(Number(p.pct ?? 0), s.pct) || !close(Number(p.fee ?? 0), s.fee ?? 0, 0.001)) changes.push({ field: `stage changed (${s.studio}): ${s.stage.slice(0, 50)}`, from: `${((p.pct ?? 0) * 100).toFixed(2)}% · ₹${p.fee}`, to: `${(s.pct * 100).toFixed(2)}% · ₹${s.fee}` });
  }
  for (const p of prev.stages) if (!next.stages.some((s) => key(s) === key(p))) changes.push({ field: `stage removed (${p.studio})`, from: p.stage, to: null });
  return changes;
}

async function loadPo(sb: Db, id: number) {
  const [h, l, s] = await Promise.all([
    sb.from("purchase_orders").select("*").eq("id", id).single(),
    sb.from("po_lines").select("*").eq("po_id", id).order("id"),
    sb.from("po_stages").select("*").eq("po_id", id).order("studio").order("seq"),
  ]);
  if (h.error) throw new Error(h.error.message);
  return { header: h.data, lines: l.data ?? [], stages: s.data ?? [] };
}

export async function stagePo(sb: Db, actor: Actor, raw: unknown) {
  assertCan(actor.role, "po.stage");
  const { checks, po } = await checkPo(sb, PoSchema.parse(raw));
  if (po.project_number) po.project_number = po.project_number.toUpperCase().replace(/\s/g, "");
  const { data: prior } = await sb.from("purchase_orders").select("id,version,status").eq("po_number", po.po_number).order("version", { ascending: false });
  const lastApproved = (prior ?? []).find((p) => p.status === "approved");
  const version = (prior?.[0]?.version ?? 0) + 1;
  const kind = po.kind ?? (lastApproved ? "amendment" : "new");
  const diff = lastApproved ? diffPo(await loadPo(sb, lastApproved.id), po) : null;
  if (diff && !diff.length) checks.push({ rule: "Amendment changes something", ok: false, severity: "warning", detail: "Identical to the approved version: nothing to merge" });

  const { data: h, error } = await sb.from("purchase_orders").insert({
    po_number: po.po_number, version, parent_id: lastApproved?.id ?? null, kind,
    client_name: po.client_name, project_number: po.project_number ?? null, project_name: po.project_name, location: po.location ?? null, project_type: po.project_type ?? null,
    po_date: iso(po.po_date), start_date: iso(po.start_date), end_date: iso(po.end_date), contract_validity: po.contract_validity ?? null, escalation_clause: po.escalation_clause ?? null,
    total_value: po.total_value, gst_included: po.gst_included ?? null, source: po.source ?? null, source_ref: po.source_ref ?? null,
    extracted_by: who(actor), confidence: po.confidence ?? null, checks, diff, raw: po,
  }).select("id").single();
  if (error) throw new Error(error.message);
  const seqBy = new Map<string, number>();
  const lines = po.lines.map((l) => ({ po_id: h.id, studio: l.studio, split_value: l.split_value ?? null, split_pct: l.split_pct ?? null, design_value: l.design_value ?? null, construction_value: l.construction_value ?? null }));
  const stages = po.stages.map((s) => { const n = (seqBy.get(s.studio) ?? 0) + 1; seqBy.set(s.studio, n); return { po_id: h.id, studio: s.studio, seq: n, stage: s.stage, pct: s.pct, fee: s.fee ?? null, is_construction: s.is_construction ?? false, instalments: s.instalments ?? null }; });
  const r1 = await sb.from("po_lines").insert(lines); if (r1.error) throw new Error(r1.error.message);
  const r2 = await sb.from("po_stages").insert(stages); if (r2.error) throw new Error(r2.error.message);
  const errors = checks.filter((x) => !x.ok && x.severity === "error").length;
  await notify(sb, "admin", `PO to review: ${po.po_number}${version > 1 ? ` v${version}` : ""}`, `${po.client_name} · ${kind} · ${errors ? `${errors} check(s) failed` : "checks passed"} · staged by ${who(actor)}`, "agents", String(h.id));
  return { po_id: h.id, po_number: po.po_number, version, kind, status: "pending_review", checks, diff, next_step: "A reviewer approves or rejects it on the Agents tab (or with review_po)." };
}

export async function listPos(sb: Db, status?: string) {
  let q = sb.from("purchase_orders").select("id,po_number,version,kind,client_name,project_number,project_name,total_value,status,source,source_ref,extracted_by,confidence,checks,diff,created_at,reviewed_by,reviewed_at,review_note").order("id", { ascending: false }).limit(50);
  if (status) q = q.eq("status", status);
  const { data, error } = await q; if (error) throw new Error(error.message);
  return data ?? [];
}
export const getPo = loadPo;

const fy = (d: string) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, "0")}`; };

export async function reviewPo(sb: Db, actor: Actor, id: number, decision: "approved" | "rejected", note?: string, projectNumber?: string) {
  assertCan(actor.role, "po.review");
  const po = await loadPo(sb, id);
  const h = po.header;
  if (h.status !== "pending_review") throw new Error(`PO ${h.po_number} v${h.version} is already ${h.status}.`);
  if (decision === "rejected") {
    await sb.from("purchase_orders").update({ status: "rejected", reviewed_by: who(actor), reviewed_at: new Date().toISOString(), review_note: note ?? null }).eq("id", id);
    return { ok: true, status: "rejected" };
  }
  const pn = (projectNumber ?? h.project_number ?? "").toUpperCase().replace(/\s/g, "");
  if (!pn) throw new Error("Set the internal project number before approving.");
  const failed = (h.checks as Check[] | null ?? []).filter((c) => !c.ok && c.severity === "error");
  if (failed.length && !note) throw new Error(`${failed.length} check(s) failed. Add a review note explaining why it is still correct, or reject it.`);

  const today = new Date().toISOString().slice(0, 10);
  const merged: { lines: number; stages_added: number; stages_updated: number } = { lines: 0, stages_added: 0, stages_updated: 0 };
  for (const [i, l] of po.lines.entries()) {
    const { data: existing } = await sb.from("project_lines").select("id,billed_amount").eq("project_number", pn).eq("studio", l.studio).order("id").limit(1).maybeSingle();
    const base = { client_name: h.client_name, project_name: h.project_name, location: h.location, project_type: h.project_type, contract_validity: h.contract_validity, start_date: h.start_date, end_date: h.end_date, escalation_clause: h.escalation_clause, total_project_value: h.total_value, split_value: l.split_value, split_pct: l.split_pct, design_value: l.design_value, construction_value: l.construction_value, po_id: id };
    if (existing) {
      const r = await sb.from("project_lines").update({ ...base, yet_to_bill_amount: Number(l.split_value ?? 0) - Number(existing.billed_amount ?? 0) }).eq("id", existing.id);
      if (r.error) throw new Error(r.error.message);
    } else {
      const r = await sb.from("project_lines").insert({ ...base, row_no: 1_000_000 + id * 100 + i, sl_no: `PO-${id}-${i + 1}`, financial_year: fy(h.po_date ?? today), project_number: pn, studio: l.studio, billed_amount: 0, billed_pct: 0, yet_to_bill_amount: l.split_value, yet_to_bill_pct: 1, status: "Not started", origin: "po" });
      if (r.error) throw new Error(r.error.message);
    }
    merged.lines++;
    const { data: cur } = await sb.from("billing_stages").select("id,seq,stage,billed_on,pct,fee").eq("project_number", pn).eq("studio", l.studio);
    let next = Math.max(0, ...(cur ?? []).map((s) => s.seq)) + 1;
    for (const s of po.stages.filter((x) => x.studio === l.studio)) {
      const match = (cur ?? []).find((c) => (c.stage ?? "").trim().toLowerCase() === s.stage.trim().toLowerCase());
      if (match) {
        const changed = !samePct(Number(match.pct ?? 0), s.pct ?? 0) || !close(Number(match.fee ?? 0), Number(s.fee ?? 0), 0.001);
        if (!match.billed_on && changed) { await sb.from("billing_stages").update({ pct: s.pct, fee: s.fee, project_value: l.split_value, po_id: id }).eq("id", match.id); merged.stages_updated++; }
      } else {
        const r = await sb.from("billing_stages").insert({ project_number: pn, studio: l.studio, seq: next, sl_no: `PO-${id}-${i + 1}`, project_name: h.project_name, project_value: l.split_value, stage: s.stage, pct: s.pct, fee: s.fee, source_status: "pending", row_no: 1_000_000 + id * 1000 + next, origin: "po", po_id: id });
        if (r.error) throw new Error(r.error.message);
        next++; merged.stages_added++;
      }
    }
  }
  await sb.from("purchase_orders").update({ status: "approved", project_number: pn, reviewed_by: who(actor), reviewed_at: new Date().toISOString(), review_note: note ?? null }).eq("id", id);
  await notify(sb, "finance", `New PO approved: ${h.po_number}`, `${h.client_name} · ${pn} · ₹${Math.round(Number(h.total_value)).toLocaleString("en-IN")}. First-stage invoice may be due on confirmation.`, "finance", String(id));
  return { ok: true, status: "approved", project_number: pn, merged, excel: "Call tracker_rows_for_excel with this po_id to get rows for the master tracker workbook." };
}

// Rows in the master tracker workbook's column order, so an assistant (or a person) can paste them into the Excel.
export async function excelRows(sb: Db, id: number) {
  const po = await loadPo(sb, id);
  const h = po.header;
  const summary_headers = ["Sl. No.", "Financial Year", "Project Number", "Client Name", "Project Name", "Location", "Studio", "Project type", "Contract Validity", "Project Start Date", "Project End Date", "Escalation Clause", "Total Project Value in INR", "Project split", "Project split %", "Billed %", "Billed", "Yet to bill %", "Yet to bill", "Design Value", "Construction Value", "Project Status"];
  const summary = po.lines.map((l, i) => [`PO-${id}-${i + 1}`, h.po_date ? fy(h.po_date) : "", h.project_number, h.client_name, h.project_name, h.location, l.studio, h.project_type, h.contract_validity, h.start_date, h.end_date, h.escalation_clause, h.total_value, l.split_value, l.split_pct, 0, 0, 1, l.split_value, l.design_value, l.construction_value, "Not started"]);
  const stage_headers = ["Sl. No.", "Project Number", "Project Name", "Service", "Project Value in INR", "Stage", "Proposed Completion", "Percentage", "Fee/stage in INR", "Billed", "Work Assigned to", "Remarks"];
  const stages = po.stages.map((s) => { const l = po.lines.find((x) => x.studio === s.studio); return [`PO-${id}`, h.project_number, h.project_name, s.studio, l?.split_value ?? null, s.stage, "", s.pct, s.fee, "", "", `PO ${h.po_number} v${h.version}`]; });
  return { sheets: { Summary: { headers: summary_headers, rows: summary }, "Billing Stages": { headers: stage_headers, rows: stages } }, note: "Append to the matching sheets of the master tracker workbook. The dashboard already holds these rows." };
}

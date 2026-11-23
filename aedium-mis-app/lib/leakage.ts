// F4 · Leakage: a weekly, ranked list of money that is slipping, each item owned by a director and decided by a person.
// Items are keyed so they survive re-runs; a decided item stays decided, an open item that no longer appears is resolved.
import type { Db } from "./supabase/server";
import { all, isActive, isSummaryRow, type Line, type Stage, type OpenInvoice } from "./data";
import { escalationOf } from "./plan";
import { inRange, type Range } from "./period";
import { assertCan } from "./rbac";
import { assertStudio, recordStageEvent, notify, who, type Actor } from "./agents/actions";

export const KINDS = {
  billed_not_collected: { label: "Billed, not collected", rule: "Invoice past due on its payment terms, over 90 days" },
  complete_not_billed: { label: "Complete, not billed", rule: "Stage marked complete with no invoice after 7 days" },
  lapsed_with_value: { label: "Lapsed with value", rule: "Contract lapsed in the last year while value is still unbilled" },
  stages_over_100: { label: "Stages over 100%", rule: "Stage fees on a tracker line add up to more than its value" },
  under_billed_fee: { label: "Under-billed fees", rule: "Escalation due after the end date but not applied" },
  stalled_approval: { label: "Stalled approvals", rule: "Stage complete but client approval missing after 30 days" },
  tracker_mismatch: { label: "Tracker mismatch", rule: "Summary and Billing Stages sheets disagree" },
} as const;
export type Kind = keyof typeof KINDS;
type Cand = { item_key: string; kind: Kind; project_number: string | null; studio: string | null; seq: number | null; row_no: number | null; title: string; detail: string; evidence: string; amount: number | null; owner: string };

const IST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const lakh = (v: number) => `₹${(v / 1e5).toFixed(v >= 1e7 ? 0 : 2)} L`;

async function candidates(sb: Db): Promise<Cand[]> {
  const today = IST();
  let [lines, stages, open] = await Promise.all([
    all<Line>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc"),
    all<Stage>(sb, "v_stages", "id,project_number,studio,seq,sl_no,project_name,stage,pct,fee,billed_on,row_no,workflow_status,last_event_at,last_event_by"),
    all<OpenInvoice>(sb, "v_open_invoices", "invoice_id,invoice_number,customer_name,project_name,project_number,studio,date,due_date,total,balance,days_overdue,bucket", "invoice_id"),
  ]);
  const out: Cand[] = [];
  stages = stages.filter((s) => !isSummaryRow(s));
  const director = (s: string | null) => `${s ?? "Studio"} director`;
  const lineBy = new Map(lines.map((l) => [`${l.project_number}|${l.studio ?? ""}`, l]));
  const name = (pn: string, st: string | null) => { const l = lineBy.get(`${pn}|${st ?? ""}`); return l?.client_name ?? l?.project_name ?? pn; };

  // 1. Billed, not collected: open invoices over 90 days, one item per client/project.
  const late = new Map<string, OpenInvoice[]>();
  for (const i of open) if (i.days_overdue > 90) { const k = i.project_name ?? i.customer_name ?? "?"; late.set(k, [...(late.get(k) ?? []), i]); }
  for (const [k, xs] of late) {
    const big = [...xs].sort((a, b) => b.balance - a.balance)[0], oldest = Math.max(...xs.map((x) => x.days_overdue));
    out.push({ item_key: `billed_not_collected|${k}`, kind: "billed_not_collected", project_number: big.project_number, studio: big.studio, seq: null, row_no: null,
      title: `${k} · ${xs.length} invoice${xs.length > 1 ? "s" : ""} over 90 days`, detail: `Oldest ${oldest} days · largest ${big.invoice_number} at ${lakh(big.balance)}`, evidence: "Zoho Books ageing (sample data until connected)",
      amount: xs.reduce((a, x) => a + Number(x.balance), 0), owner: `${director(big.studio)} · Finance` });
  }
  // 2/6. Complete, not billed and stalled approvals.
  for (const s of stages) {
    if (s.billed_on || !(Number(s.fee) > 0)) continue;
    const ws = s.workflow_status, at = s.last_event_at?.slice(0, 10) ?? null;
    if (ws === "complete" && at && days(at, today) > 30) {
      out.push({ item_key: `stalled_approval|${s.project_number}|${s.studio ?? ""}|${s.seq}`, kind: "stalled_approval", project_number: s.project_number, studio: s.studio, seq: s.seq, row_no: s.row_no,
        title: `${name(s.project_number, s.studio)} · ${s.studio ?? ""} · stage complete, client approval not recorded`, detail: `${s.stage ?? "Stage " + s.seq} · ${days(at, today)} days since completion`, evidence: `Stage log · Billing Stages row ${s.row_no}`, amount: Number(s.fee), owner: director(s.studio) });
    } else if (["complete", "client_approved", "finance_notified"].includes(ws) && (!at || days(at, today) > 7)) {
      out.push({ item_key: `complete_not_billed|${s.project_number}|${s.studio ?? ""}|${s.seq}`, kind: "complete_not_billed", project_number: s.project_number, studio: s.studio, seq: s.seq, row_no: s.row_no,
        title: `${name(s.project_number, s.studio)} · ${s.studio ?? ""} · completed stage with no invoice`, detail: s.stage ?? `Stage ${s.seq}`, evidence: `Billing Stages row ${s.row_no} · ${s.project_number} · ${at ? `${ws.replace("_", " ")} ${days(at, today)} days ago` : "Complete in tracker, no billed date"}`, amount: Number(s.fee), owner: director(s.studio) });
    }
  }
  // 3/5. Lapsed contracts with value, escalation due but not applied.
  for (const l of lines.filter(isActive)) {
    const ytb = Number(l.yet_to_bill_amount ?? 0);
    if (l.end_date && l.end_date < today && ytb > 0 && days(l.end_date, today) <= 365)
      out.push({ item_key: `lapsed_with_value|${l.row_no}`, kind: "lapsed_with_value", project_number: l.project_number, studio: l.studio, seq: null, row_no: l.row_no,
        title: `${l.client_name ?? l.project_number} · ${l.studio ?? ""} · contract ended with value left to bill`, detail: `Lapsed ${l.end_date} · ${l.project_number}`, evidence: `Summary row ${l.row_no} · check the PO queue for an amendment`, amount: ytb, owner: director(l.studio) });
    const e = escalationOf(l, today);
    if (e && e.periods > 0 && e.uplift > 0)
      out.push({ item_key: `under_billed_fee|${l.row_no}`, kind: "under_billed_fee", project_number: l.project_number, studio: l.studio, seq: null, row_no: l.row_no,
        title: `${l.client_name ?? l.project_number} · ${l.studio ?? ""} · escalation clause due but not applied`, detail: `PO clause: ${l.escalation_clause} · ${e.periods} year${e.periods > 1 ? "s" : ""} past ${l.end_date}`, evidence: `Summary row ${l.row_no} · current invoices at the original rate`, amount: e.uplift, owner: director(l.studio) });
  }
  // 4. Stage percentages above 100% per line; 7. tracker mismatch (Summary billed vs stages billed).
  // Group per tracker line (Sl. No.: 2, 2A, 2B...), not per project + studio: one project and studio can hold
  // several lines (combined PO, additions, rework), each with its own 100% stage schedule.
  const lineKey = (pn: string, st: string | null, sl: string | null) => (sl ? `${pn}|sl:${sl}` : `${pn}|${st ?? ""}`);
  const lineBySl = new Map(lines.map((l) => [lineKey(l.project_number, l.studio, l.sl_no), l]));
  // Compare stage FEES with the line value: instalment rows repeat the whole construction % on every month,
  // so summing percentages overstates; the fee on each row is that month's share.
  const pct = new Map<string, { total: number; fee: number; n: number }>();
  for (const s of stages) { const k = lineKey(s.project_number, s.studio, s.sl_no); const r = pct.get(k) ?? { total: 0, fee: 0, n: 0 }; r.total += Number(s.fee ?? 0); r.n++; if (s.billed_on) r.fee += Number(s.fee ?? 0); pct.set(k, r); }
  let mism = 0, net = 0;
  for (const [k, r] of pct) {
    const l = lineBySl.get(k); if (!l) continue;
    const value = Number(l.split_value ?? 0);
    if (value > 0 && r.total > value * 1.005 && r.total - value > 1000) out.push({ item_key: `stages_over_100|${k}`, kind: "stages_over_100", project_number: l.project_number, studio: l.studio, seq: null, row_no: l.row_no,
      title: `${l.client_name ?? l.project_number} · ${l.studio ?? ""} · stage fees total ${Math.round((r.total / value) * 100)}% of the line value`, detail: `${r.n} stages · Sl. No. ${l.sl_no ?? "?"} · fees exceed the line value by ${lakh(r.total - value)}: check the stage schedule before invoicing`, evidence: `Billing Stages fees vs Summary split value · ${l.project_number}`, amount: null, owner: director(l.studio) });   // a data check, not money at stake: unsized
    const diff = Number(l.billed_amount ?? 0) - r.fee;
    if (Math.abs(diff) > Math.max(1000, 0.01 * Number(l.split_value ?? 0))) { mism++; net += diff; }
  }
  if (mism) out.push({ item_key: "tracker_mismatch|all", kind: "tracker_mismatch", project_number: null, studio: null, seq: null, row_no: null,
    title: `Summary and Billing Stages disagree on ${mism} project lines`, detail: `Net difference ${lakh(Math.abs(net))} (${net > 0 ? "Summary higher" : "stages higher"})`, evidence: "Import checks · billed amount vs billed stage fees", amount: null, owner: "Planning & MIS" });
  return out;
}

// Weekly run (also on demand): insert new items, refresh open ones, resolve open items that no longer appear.
export async function refreshLeakage(sb: Db, by: string) {
  const cands = await candidates(sb);
  const { data: run, error } = await sb.from("leakage_runs").insert({ run_by: by }).select("id").single();
  if (error) throw new Error(error.message);
  const { data: existing } = await sb.from("leakage_items").select("id,item_key,status");
  const byKey = new Map((existing ?? []).map((e) => [e.item_key, e]));
  const now = new Date().toISOString();
  const fresh = cands.filter((c) => !byKey.has(c.item_key)).map((c) => ({ ...c, first_seen_run: run.id, last_seen_run: run.id }));
  for (let i = 0; i < fresh.length; i += 500) { const r = await sb.from("leakage_items").insert(fresh.slice(i, i + 500)); if (r.error) throw new Error(r.error.message); }
  const seen = new Set(cands.map((c) => c.item_key));
  for (const c of cands) { const e = byKey.get(c.item_key); if (e && e.status === "open") await sb.from("leakage_items").update({ title: c.title, detail: c.detail, evidence: c.evidence, amount: c.amount, owner: c.owner, last_seen_run: run.id, last_seen_at: now }).eq("id", e.id); }
  const gone = (existing ?? []).filter((e) => e.status === "open" && !seen.has(e.item_key)).map((e) => e.id);
  if (gone.length) await sb.from("leakage_items").update({ status: "resolved", decided_by: "weekly run", decided_at: now, reason: "No longer found" }).in("id", gone);
  const counts = Object.fromEntries(Object.keys(KINDS).map((k) => [k, cands.filter((c) => c.kind === k).length]));
  const atStake = cands.reduce((a, c) => a + (c.amount ?? 0), 0);
  await sb.from("leakage_runs").update({ open_items: cands.length, new_items: fresh.length, at_stake: atStake, counts }).eq("id", run.id);
  return { run_id: run.id, items: cands.length, new: fresh.length };
}

export async function leakage(sb: Db, studio: string | null, by: string, range: Range | null = null) {
  const { data: last } = await sb.from("leakage_runs").select("id,run_at,open_items,new_items,at_stake").order("id", { ascending: false }).limit(1).maybeSingle();
  if (!last || Date.now() - Date.parse(last.run_at) > 7 * 86400000) await refreshLeakage(sb, `${by} (weekly run)`);
  const [{ data: items, error }, { data: run }] = await Promise.all([
    sb.from("leakage_items").select("*").order("amount", { ascending: false, nullsFirst: false }).limit(2000),
    sb.from("leakage_runs").select("id,run_at,open_items,new_items,at_stake").order("id", { ascending: false }).limit(1).single(),
  ]);
  if (error) throw new Error(error.message);
  const scoped = (items ?? []).filter((i) => !studio || i.studio === studio || i.kind === "tracker_mismatch");
  // With a range picked: open items first raised in it, decisions made in it. "This week" becomes "in this period".
  const open = scoped.filter((i) => i.status === "open" && (!range || inRange(range, i.first_seen_at)));
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const decided = scoped.filter((i) => ["confirmed", "corrected", "dismissed"].includes(i.status) && (!range || inRange(range, i.decided_at)));
  const decidedWeek = range ? decided : decided.filter((i) => i.decided_at >= weekAgo);
  const times = decided.map((i) => (Date.parse(i.decided_at) - Date.parse(i.first_seen_at)) / 86400000).sort((a, b) => a - b);
  // Confirmed "complete, not billed" items whose stage has since been invoiced or billed.
  const confirmedStages = decided.filter((i) => i.status === "confirmed" && i.seq != null);
  let invoicedAfter = 0;
  if (confirmedStages.length) {
    const { data: st } = await sb.from("v_stages").select("project_number,studio,seq,workflow_status,fee").in("project_number", [...new Set(confirmedStages.map((i) => i.project_number))]);
    for (const i of confirmedStages) { const s = (st ?? []).find((x) => x.project_number === i.project_number && x.studio === i.studio && x.seq === i.seq); if (s && ["invoiced", "billed"].includes(s.workflow_status)) invoicedAfter += Number(s.fee ?? 0); }
  }
  const byKind = Object.fromEntries(Object.keys(KINDS).map((k) => { const xs = open.filter((i) => i.kind === k); return [k, { n: xs.length, amount: xs.reduce((a, i) => a + Number(i.amount ?? 0), 0) }]; })) as Record<Kind, { n: number; amount: number }>;
  const owners = new Map<string, { owner: string; open: number; done: number; amount: number }>();
  for (const i of scoped) {
    if (!["open", "confirmed", "corrected", "dismissed"].includes(i.status)) continue;
    const o = owners.get(i.owner) ?? { owner: i.owner, open: 0, done: 0, amount: 0 };
    if (range && !inRange(range, i.status === "open" ? i.first_seen_at : i.decided_at)) continue;
    if (i.status === "open") { o.open++; o.amount += Number(i.amount ?? 0); } else if (range || i.decided_at >= weekAgo) o.done++;
    owners.set(i.owner, o);
  }
  return {
    run, kinds: KINDS, byKind, ranged: !!range,
    kpi: { at_stake: open.reduce((a, i) => a + Number(i.amount ?? 0), 0), open: open.length, decided_week: decidedWeek.length, invoiced_after: invoicedAfter, median_days: times.length ? times[Math.floor(times.length / 2)] : null },
    items: open.slice(0, 200),
    owners: [...owners.values()].filter((o) => o.open || o.done).sort((a, b) => b.amount - a.amount).slice(0, 8),
    log: decided.sort((a, b) => b.decided_at.localeCompare(a.decided_at)).slice(0, 8),
  };
}
export type Leakage = Awaited<ReturnType<typeof leakage>>;

export async function decideLeakage(sb: Db, actor: Actor, id: number, d: { decision: "confirmed" | "corrected" | "dismissed"; reason?: string; corrected_value?: number }) {
  assertCan(actor.role, "leakage.decide");
  const { data: it, error } = await sb.from("leakage_items").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  if (it.status !== "open") throw new Error(`Already ${it.status}.`);
  if (it.studio && it.kind !== "billed_not_collected") assertStudio(actor, it.studio);
  if (actor.role === "finance" && it.kind !== "billed_not_collected") throw new Error("Finance decides collection items; studio directors decide the rest.");
  if (d.decision !== "confirmed" && !d.reason?.trim()) throw new Error("Give a reason.");
  let message = "Logged";
  if (d.decision === "confirmed") {
    if ((it.kind === "complete_not_billed" || it.kind === "stalled_approval") && it.seq != null) {
      const { data: s } = await sb.from("v_stages").select("workflow_status").eq("project_number", it.project_number).eq("studio", it.studio).eq("seq", it.seq).maybeSingle();
      if (s && s.workflow_status !== "finance_notified") await recordStageEvent(sb, actor, { project_number: it.project_number, studio: it.studio, seq: it.seq }, "finance_notified", "Confirmed from the leakage list");
      message = "Confirmed and sent to Finance";
    } else if (it.kind === "billed_not_collected") { await notify(sb, "finance", `Chase payment: ${it.title}`, `${it.detail}. Confirmed by ${who(actor)} from the leakage list.`, "agents", String(id)); message = "Confirmed. Finance has a chase item"; }
    else { await notify(sb, "admin", `Leakage confirmed: ${it.title}`, `${it.detail}. Confirmed by ${who(actor)}.`, "cash", String(id)); message = "Confirmed. Planning & MIS notified"; }
  }
  const { error: e2 } = await sb.from("leakage_items").update({ status: d.decision, decided_by: who(actor), decided_at: new Date().toISOString(), reason: d.reason ?? null, corrected_value: d.corrected_value ?? null }).eq("id", id);
  if (e2) throw new Error(e2.message);
  return { ok: true, message: d.decision === "confirmed" ? message : d.decision === "corrected" ? "Correction logged" : "Dismissed with reason" };
}

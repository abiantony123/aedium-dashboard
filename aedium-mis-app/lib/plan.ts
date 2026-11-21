// Plan tab: FY target vs billable, escalation estimates, and the monthly projection (forecast vs actual).
import type { Db } from "./supabase/server";
import { all, isActive, type Line, type Stage } from "./data";
import { assertCan } from "./rbac";
import { who, type Actor } from "./agents/actions";
import { instalmentMonths, type Basis } from "./construction";

const IST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
export function fyOf(d: string) { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)); const s = m >= 4 ? y : y - 1; return { label: `${s}-${String((s + 1) % 100).padStart(2, "0")}`, start: `${s}-04-01`, end: `${s + 1}-03-31` }; }
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const isInstalment = (s: { stage: string | null }) => /instal|monthly|construction stage/i.test(s.stage ?? "");

type PlanLine = Pick<Line, "project_number" | "studio" | "client_name" | "end_date" | "escalation_clause" | "yet_to_bill_amount" | "split_value" | "status" | "row_no" | "project_name" | "start_date" | "billed_amount" | "id" | "sl_no" | "financial_year" | "billed_pct" | "design_value" | "construction_value" | "project_type" | "project_stage" | "spoc" | "contract_validity">;

async function base(sb: Db, studio: string | null, client: string | null = null) {
  const [lines, stages] = await Promise.all([
    all<Line>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,contract_validity,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc"),
    all<Stage>(sb, "v_stages", "id,project_number,studio,seq,sl_no,project_name,stage,pct,fee,billed_on,row_no,workflow_status,last_event_at,last_event_by"),
  ]);
  const pns = client ? new Set(lines.filter((l) => l.client_name === client).map((l) => l.project_number)) : null;
  const L = lines.filter((l) => (!studio || l.studio === studio) && (!pns || pns.has(l.project_number)));
  const S = stages.filter((s) => (!studio || s.studio === studio) && (!pns || pns.has(s.project_number)));
  return { lines: L as PlanLine[], stages: S };
}

export async function fyPlan(sb: Db, studio: string | null, client: string | null = null) {
  const today = IST(), fy = fyOf(today);
  const { lines, stages } = await base(sb, studio, client);
  const active = lines.filter((l) => isActive(l as Line));
  const key = (pn: string, st: string | null) => `${pn}|${st ?? ""}`;
  const activeKeys = new Set(active.map((l) => key(l.project_number, l.studio)));
  const months: string[] = []; for (let m = addMonths(today.slice(0, 7), 1); m <= fy.end.slice(0, 7); m = addMonths(m, 1)) months.push(m);

  const byStudio = new Map<string, { studio: string; billed_ytd: number; design_pending: number; construction_in_fy: number }>();
  const row = (s: string | null) => { const k = s ?? "Unassigned"; const r = byStudio.get(k) ?? { studio: k, billed_ytd: 0, design_pending: 0, construction_in_fy: 0 }; byStudio.set(k, r); return r; };
  for (const s of stages) {
    if (s.billed_on && s.billed_on >= fy.start && s.billed_on <= today) row(s.studio).billed_ytd += s.fee ?? 0;
  }
  const inst = new Map<string, Stage[]>();
  for (const s of stages) {
    if (s.billed_on || s.workflow_status === "invoiced" || !activeKeys.has(key(s.project_number, s.studio))) continue;
    if (isInstalment(s)) { const k = key(s.project_number, s.studio); inst.set(k, [...(inst.get(k) ?? []), s]); }
    else row(s.studio).design_pending += s.fee ?? 0;
  }
  const validity = new Map(lines.map((l) => [key(l.project_number, l.studio), l.contract_validity]));
  const timing: Record<Basis, number> = { stage: 0, contract: 0, assumed: 0 };
  for (const [k, xs] of inst.entries()) {
    xs.sort((a, b) => a.seq - b.seq);
    let slot = 0;
    for (const s of xs) {
      if (slot >= months.length) break;
      if ((s.pct ?? 0) > 0.05) { const { months: n, basis } = instalmentMonths(s.stage, validity.get(k)); timing[basis]++; row(s.studio).construction_in_fy += ((s.fee ?? 0) / n) * Math.min(months.length - slot, n); slot = months.length; }
      else { row(s.studio).construction_in_fy += s.fee ?? 0; slot++; }
    }
  }
  const { data: targets } = await sb.from("fy_targets").select("studio,target").eq("fy", fy.label);
  const tmap = new Map((targets ?? []).map((t) => [t.studio, Number(t.target)]));
  const rows = [...byStudio.values()].filter((r) => r.billed_ytd || r.design_pending || r.construction_in_fy)
    .map((r) => ({ ...r, target: tmap.get(r.studio) ?? null, outlook: r.billed_ytd + r.design_pending + r.construction_in_fy }))
    .sort((a, b) => b.outlook - a.outlook);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const target = tmap.get(studio ?? "All") ?? null;
  return {
    fy: fy.label, today, months_left: months.length, studio: studio ?? "All",
    total: { billed_ytd: sum((r) => r.billed_ytd), design_pending: sum((r) => r.design_pending), construction_in_fy: sum((r) => r.construction_in_fy), outlook: sum((r) => r.outlook), target, gap: target != null ? target - sum((r) => r.outlook) : null },
    rows, timing,
    method: "Billed YTD = stages billed since 1 April. Design pending = unbilled milestone stages on active lines (billable this FY if delivered). Construction = unbilled monthly instalments that fall before 31 March, one per month.",
  };
}

// Escalation: rate parsed from the clause text; applied per started year past the contract end date on the unbilled amount.
export function escalationOf(l: Pick<Line, "end_date" | "escalation_clause" | "yet_to_bill_amount">, today = IST()) {
  const rate = Number((l.escalation_clause ?? "").match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
  if (!rate || !l.end_date || !(Number(l.yet_to_bill_amount) > 0)) return null;
  const daysPast = Math.round((Date.parse(today) - Date.parse(l.end_date)) / 86400000);
  const periods = daysPast > 0 ? Math.ceil(daysPast / 365) : 0;
  const ytb = Number(l.yet_to_bill_amount);
  return { rate: rate / 100, days_past_end: daysPast, periods, yet_to_bill: ytb, uplift: periods ? Math.round(ytb * (Math.pow(1 + rate / 100, periods) - 1)) : 0, next_step_up: periods ? null : l.end_date };
}

export async function escalations(sb: Db, studio: string | null, client: string | null = null) {
  const { lines } = await base(sb, studio, client);
  const today = IST();
  return lines.filter((l) => isActive(l as Line)).map((l) => ({ l, e: escalationOf(l, today) }))
    .filter((x) => x.e && (x.e.periods > 0 || x.e.days_past_end > -90))
    .map(({ l, e }) => ({ row_no: l.row_no, project_number: l.project_number, client_name: l.client_name, studio: l.studio, end_date: l.end_date, clause: l.escalation_clause, ...e! }))
    .sort((a, b) => b.uplift - a.uplift || b.days_past_end - a.days_past_end);
}

export async function setTarget(sb: Db, actor: Actor, fy: string, studio: string, target: number) {
  assertCan(actor.role, "plan.target");
  const { error } = await sb.from("fy_targets").upsert({ fy, studio, target, updated_by: who(actor), updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

// ---------- monthly projection ----------
export type ProjRow = { id: number; month: string; week: number; project_number: string | null; studio: string | null; stage_seq: number | null; description: string; amount: number; kind: string; created_by: string | null };
const weekOf = (d: string) => Math.min(5, Math.ceil(Number(d.slice(8, 10)) / 7));

export async function projection(sb: Db, month: string, studio: string | null, client: string | null = null) {
  const m = month.slice(0, 7), prev = addMonths(m, -1);
  const [{ data: cur }, { data: prv }, { stages, lines }] = await Promise.all([
    sb.from("projections").select("*").eq("month", `${m}-01`).order("week").order("id"),
    sb.from("projections").select("*").eq("month", `${prev}-01`),
    base(sb, studio, client),
  ]);
  const clientPns = client ? new Set(lines.map((l) => l.project_number)) : null;
  const inStudio = (r: { studio: string | null; project_number?: string | null }) => (!studio || r.studio === studio) && (!clientPns || (!!r.project_number && clientPns.has(r.project_number)));
  const rows = ((cur ?? []) as ProjRow[]).filter(inStudio);
  const sk = (pn: string | null, st: string | null, seq: number | null) => `${pn}|${st ?? ""}|${seq ?? ""}`;
  const stageBy = new Map(stages.map((s) => [sk(s.project_number, s.studio, s.seq), s]));
  const { data: inv } = await sb.from("stage_events").select("project_number,studio,seq,created_at").eq("event", "invoiced").gte("created_at", `${m}-01`).lt("created_at", `${addMonths(m, 1)}-01`);
  // Actuals: stages billed this month in the tracker, plus invoices raised this month in the app.
  const actualKeys = new Map<string, { amount: number; week: number; label: string; project_number: string; studio: string | null }>();
  for (const s of stages) if (s.billed_on?.startsWith(m)) actualKeys.set(sk(s.project_number, s.studio, s.seq), { amount: s.fee ?? 0, week: weekOf(s.billed_on), label: s.stage ?? "", project_number: s.project_number, studio: s.studio });
  for (const e of inv ?? []) { const s = stageBy.get(sk(e.project_number, e.studio, e.seq)); if (s && inStudio(s)) actualKeys.set(sk(e.project_number, e.studio, e.seq), { amount: s.fee ?? 0, week: weekOf(e.created_at.slice(0, 10)), label: s.stage ?? "", project_number: s.project_number, studio: s.studio }); }

  const forecastKeys = new Set(rows.filter((r) => r.stage_seq != null).map((r) => sk(r.project_number, r.studio, r.stage_seq)));
  void lines;
  const carry = ((prv ?? []) as ProjRow[]).filter(inStudio).filter((r) => {
    const s = r.stage_seq != null ? stageBy.get(sk(r.project_number, r.studio, r.stage_seq)) : null;
    return s ? !s.billed_on && s.workflow_status !== "invoiced" && !forecastKeys.has(sk(r.project_number, r.studio, r.stage_seq)) : false;
  });
  // A project's first stage billed without a forecast is new-project billing (the BD team brought it in).
  const unplanned = [...actualKeys.entries()].filter(([k]) => !forecastKeys.has(k)).map(([k, v]) => ({ key: k, ...v, kind: k.endsWith("|1") ? "new_project" : "unplanned" }));
  const weeks = [1, 2, 3, 4, 5].map((w) => ({
    week: w,
    forecast: rows.filter((r) => r.week === w).reduce((a, r) => a + Number(r.amount), 0),
    actual: [...actualKeys.values()].filter((a) => a.week === w).reduce((a, r) => a + r.amount, 0),
  }));
  const forecast = weeks.reduce((a, w) => a + w.forecast, 0), actual = weeks.reduce((a, w) => a + w.actual, 0);
  const rowStatus = rows.map((r) => {
    const s = r.stage_seq != null ? stageBy.get(sk(r.project_number, r.studio, r.stage_seq)) : null;
    const done = r.stage_seq != null && actualKeys.has(sk(r.project_number, r.studio, r.stage_seq));
    return { ...r, stage: s?.stage ?? null, status: done ? "billed" : s?.workflow_status ?? "manual" };
  });
  return {
    month: m, weeks, totals: { forecast, actual, variance: actual - forecast, carry_forward: carry.reduce((a, r) => a + Number(r.amount), 0), unplanned: unplanned.reduce((a, u) => a + u.amount, 0) },
    rows: rowStatus, carry_forward: carry, unplanned,
    method: "Forecast rows are entered per week. Actual = stages billed this month in the tracker plus invoices raised in the app. Carry-forward = last month's forecast stages still not billed. Unplanned = billed this month but not forecast.",
  };
}

export async function addProjection(sb: Db, actor: Actor, r: { month: string; week: number; project_number?: string | null; studio?: string | null; stage_seq?: number | null; description: string; amount: number; kind?: "forecast" | "unplanned" | "new_project" }) {
  assertCan(actor.role, "plan.projection");
  if (actor.role === "project_manager" && actor.studio && r.studio !== actor.studio) throw new Error(`You can only plan ${actor.studio} stages.`);
  const { data, error } = await sb.from("projections").insert({ month: `${r.month.slice(0, 7)}-01`, week: Math.min(5, Math.max(1, r.week)), project_number: r.project_number ?? null, studio: r.studio ?? null, stage_seq: r.stage_seq ?? null, description: r.description.slice(0, 200), amount: r.amount, kind: r.kind ?? "forecast", created_by: who(actor) }).select("id").single();
  if (error) throw new Error(error.message);
  return data;
}
export async function deleteProjection(sb: Db, actor: Actor, id: number) {
  assertCan(actor.role, "plan.projection");
  const { error } = await sb.from("projections").delete().eq("id", id); if (error) throw new Error(error.message);
}

// Forecast the month from the pipeline: stages already complete / approved / with Finance, plus the next instalment per line.
export async function autofillProjection(sb: Db, actor: Actor, month: string, studio: string | null) {
  assertCan(actor.role, "plan.projection");
  const m = month.slice(0, 7);
  const scope = actor.role === "project_manager" && actor.studio ? actor.studio : studio;
  const { stages, lines } = await base(sb, scope);
  const activeKeys = new Set(lines.filter((l) => isActive(l as Line)).map((l) => `${l.project_number}|${l.studio ?? ""}`));
  const { data: existing } = await sb.from("projections").select("project_number,studio,stage_seq").eq("month", `${m}-01`);
  const have = new Set((existing ?? []).map((r) => `${r.project_number}|${r.studio ?? ""}|${r.stage_seq}`));
  const picks: Stage[] = [];
  const seenLine = new Set<string>();
  for (const s of stages.filter((x) => !x.billed_on && x.workflow_status !== "invoiced" && activeKeys.has(`${x.project_number}|${x.studio ?? ""}`)).sort((a, b) => a.seq - b.seq)) {
    const lk = `${s.project_number}|${s.studio ?? ""}`;
    if (["complete", "client_approved", "finance_notified"].includes(s.workflow_status)) picks.push(s);
    else if (isInstalment(s) && (s.pct ?? 0) <= 0.05 && !seenLine.has(lk)) { picks.push(s); seenLine.add(lk); }
  }
  const rows = picks.filter((s) => !have.has(`${s.project_number}|${s.studio ?? ""}|${s.seq}`)).map((s) => ({
    month: `${m}-01`, week: s.workflow_status === "finance_notified" ? 1 : s.workflow_status === "client_approved" ? 2 : isInstalment(s) ? 4 : 3,
    project_number: s.project_number, studio: s.studio, stage_seq: s.seq, description: (s.stage ?? `Stage ${s.seq}`).slice(0, 200), amount: s.fee ?? 0, kind: "forecast", created_by: `${who(actor)} (auto-fill)`,
  }));
  for (let i = 0; i < rows.length; i += 500) { const { error } = await sb.from("projections").insert(rows.slice(i, i + 500)); if (error) throw new Error(error.message); }
  return { added: rows.length };
}

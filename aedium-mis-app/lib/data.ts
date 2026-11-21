import type { Db as SupabaseClient } from "./supabase/server";
import { daysBetween } from "./format";
import { instalmentMonths, instalmentsInWindow, monthsBetween } from "./construction";

// ---------- row types (match supabase/migrations) ----------
export type Line = {
  id: number; row_no: number; sl_no: string | null; financial_year: string | null; project_number: string;
  client_name: string | null; project_name: string | null; location: string | null; contract_validity: string | null; studio: string | null; project_type: string | null;
  start_date: string | null; end_date: string | null; escalation_clause: string | null;
  split_value: number | null; billed_pct: number | null; billed_amount: number | null;
  yet_to_bill_amount: number | null; design_value: number | null; construction_value: number | null;
  status: string | null; project_stage: string | null; spoc: string | null;
};
export type Stage = {
  id: number; project_number: string; studio: string | null; seq: number; sl_no: string | null; project_name: string | null;
  stage: string | null; pct: number | null; fee: number | null; billed_on: string | null; row_no: number;
  workflow_status: "pending" | "in_progress" | "complete" | "client_approved" | "finance_notified" | "invoiced" | "billed";
  last_event_at: string | null; last_event_by: string | null;
};
export type OpenInvoice = {
  invoice_id: string; invoice_number: string; customer_name: string | null; project_name: string | null; project_number: string | null;
  studio: string | null; date: string; due_date: string; total: number; balance: number; days_overdue: number; bucket: string;
};
export type Invoice = { invoice_id: string; invoice_number: string; salesorder_id: string | null; date: string; total: number; balance: number };
export type Payment = { payment_id: string; payment_number: string | null; customer_id: string | null; date: string; amount: number; tax_amount_withheld: number; invoices: { invoice_id: string }[] };
export type SalesOrder = { salesorder_id: string; project_name: string | null; project_number: string | null; studio: string | null; total: number | null };
export type Decision = { agent: string; ref: string; decision: string; created_at: string; actor_email: string | null };
export type Event = { project_number: string; studio: string | null; seq: number; event: string; created_at: string; actor_email: string | null };
export type ImportRun = { id: number; source: string; finished_at: string | null; ok: boolean | null; counts: Record<string, unknown> | null; issues: string[] | null; report_month: string | null };

const OPEN_STATUS = new Set(["In progress", "Not started", "On hold"]);
// Active = an open status, or no status recorded but still something to bill.
export const isActive = (l: Line) => OPEN_STATUS.has(l.status ?? "") || (!l.status && (l.yet_to_bill_amount ?? 0) > 0);

// Supabase returns at most 1000 rows per request: page through.
export async function all<T>(sb: SupabaseClient, table: string, columns: string, order = "id"): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

export async function loadDashboard(sb: SupabaseClient, studio?: string | null, client?: string | null) {
  const [lines, stages, open, invoices, payments, sos, decisions, events, runs, staff, cplan] = await Promise.all([
    all<Line>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,location,contract_validity,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc"),
    all<Stage>(sb, "v_stages", "id,project_number,studio,seq,sl_no,project_name,stage,pct,fee,billed_on,row_no,workflow_status,last_event_at,last_event_by"),
    all<OpenInvoice>(sb, "v_open_invoices", "invoice_id,invoice_number,customer_name,project_name,project_number,studio,date,due_date,total,balance,days_overdue,bucket", "invoice_id"),
    all<Invoice>(sb, "zoho_invoices", "invoice_id,invoice_number,salesorder_id,date,total,balance", "invoice_id"),
    all<Payment>(sb, "zoho_payments", "payment_id,payment_number,customer_id,date,amount,tax_amount_withheld,invoices", "payment_id"),
    all<SalesOrder>(sb, "zoho_sales_orders", "salesorder_id,project_name,project_number,studio,total", "salesorder_id"),
    sb.from("agent_decisions").select("agent,ref,decision,created_at,actor_email").order("created_at", { ascending: false }).limit(200),
    sb.from("stage_events").select("project_number,studio,seq,event,created_at,actor_email").order("created_at", { ascending: false }).limit(50),
    sb.from("import_runs").select("id,source,finished_at,ok,counts,issues,report_month").order("id", { ascending: false }).limit(5),
    sb.from("staff").select("id", { count: "exact", head: true }),
    sb.from("construction_plan").select("project_number,studio,start_month,months"),   // optional table: absent until its migration is run
  ]);
  const raw: Raw = {
    lines, stages, open, invoices, payments, sos,
    decisions: (decisions.data ?? []) as Decision[], events: (events.data ?? []) as Event[],
    runs: (runs.data ?? []) as ImportRun[], staffCount: staff.count ?? 0, cplan: (cplan.data ?? []) as NonNullable<Raw["cplan"]>,
  };
  const allStudios = [...new Set(lines.map((l) => l.studio).filter((s): s is string => !!s))].sort();
  const inStudio = studio ? filterStudio(raw, studio) : raw;
  const clients = clientTree(inStudio.lines);   // client list and tree follow the studio filter, not the client filter
  const scoped = client ? filterClient(inStudio, client) : inStudio;
  return { ...build(scoped), studio: studio ?? null, allStudios, client: client ?? null, clients };
}

// One client's slice. Zoho rows follow the project number on their sales order.
function filterClient(r: Raw, client: string): Raw {
  const pns = new Set(r.lines.filter((l) => l.client_name === client).map((l) => l.project_number));
  const soIds = new Set(r.sos.filter((s) => s.project_number && pns.has(s.project_number)).map((s) => s.salesorder_id));
  const invoices = r.invoices.filter((i) => soIds.has(i.salesorder_id ?? ""));
  const invIds = new Set(invoices.map((i) => i.invoice_id));
  return {
    ...r,
    lines: r.lines.filter((l) => l.client_name === client),
    stages: r.stages.filter((s) => pns.has(s.project_number)),
    open: r.open.filter((i) => i.project_number && pns.has(i.project_number)),
    invoices, sos: r.sos.filter((s) => soIds.has(s.salesorder_id)),
    payments: r.payments.filter((p) => p.invoices?.some((x) => invIds.has(x.invoice_id))),
  };
}

// Client -> project -> studio lines, active lines only. Value is the sum of each studio's own split
// (never the repeated project total), so a combined PO is not counted once per studio.
export type ClientNode = {
  client: string; contract: number; billed: number; yetToBill: number; lines: number;
  projects: { project_number: string; name: string | null; location: string | null; type: string | null; contract: number; billed: number; yetToBill: number;
    studios: { studio: string | null; value: number; billedPct: number | null; stage: string | null }[] }[];
};
export function clientTree(lines: Line[]): ClientNode[] {
  const byClient = new Map<string, Map<string, Line[]>>();
  for (const l of lines.filter(isActive)) {
    const c = l.client_name?.trim() || "Unassigned";
    const projects = byClient.get(c) ?? new Map<string, Line[]>(); byClient.set(c, projects);
    projects.set(l.project_number, [...(projects.get(l.project_number) ?? []), l]);
  }
  const n = (v: number | null | undefined) => Number(v) || 0;
  return [...byClient.entries()].map(([client, projects]) => {
    const ps = [...projects.entries()].map(([project_number, ls]) => ({
      project_number, name: ls[0].project_name, location: ls[0].location, type: ls[0].project_type,
      contract: ls.reduce((a, l) => a + n(l.split_value), 0), billed: ls.reduce((a, l) => a + n(l.billed_amount), 0), yetToBill: ls.reduce((a, l) => a + n(l.yet_to_bill_amount), 0),
      studios: ls.map((l) => ({ studio: l.studio, value: n(l.split_value), billedPct: l.billed_pct, stage: l.project_stage })),
    })).sort((a, b) => b.contract - a.contract);
    return { client, contract: ps.reduce((a, p) => a + p.contract, 0), billed: ps.reduce((a, p) => a + p.billed, 0), yetToBill: ps.reduce((a, p) => a + p.yetToBill, 0), lines: ps.reduce((a, p) => a + p.studios.length, 0), projects: ps };
  }).sort((a, b) => b.contract - a.contract);
}

// One studio's slice: tracker rows by studio, Zoho rows through their sales order's studio.
function filterStudio(r: Raw, studio: string): Raw {
  const soIds = new Set(r.sos.filter((s) => s.studio === studio).map((s) => s.salesorder_id));
  const invoices = r.invoices.filter((i) => soIds.has(i.salesorder_id ?? ""));
  const invIds = new Set(invoices.map((i) => i.invoice_id));
  return {
    ...r,
    lines: r.lines.filter((l) => l.studio === studio),
    stages: r.stages.filter((s) => s.studio === studio),
    open: r.open.filter((i) => i.studio === studio),
    invoices, sos: r.sos.filter((s) => soIds.has(s.salesorder_id)),
    payments: r.payments.filter((p) => p.invoices?.some((x) => invIds.has(x.invoice_id))),
  };
}

export type Raw = {
  lines: Line[]; stages: Stage[]; open: OpenInvoice[]; invoices: Invoice[]; payments: Payment[]; sos: SalesOrder[];
  decisions: Decision[]; events: Event[]; runs: ImportRun[]; staffCount: number;
  cplan?: { project_number: string; studio: string; start_month: string; months: number | null }[];
};

export function build(r: Raw) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); // YYYY-MM-DD in IST
  const lastRun = r.runs.find((x) => x.ok) ?? null;
  // Report month: the latest month with billing in the tracker (the sheet lags the calendar).
  const billedMonths = r.stages.map((s) => s.billed_on).filter((d): d is string => !!d && d <= today).map((d) => d.slice(0, 7));
  const reportMonth = (lastRun?.report_month?.slice(0, 7)) ?? billedMonths.sort().at(-1) ?? today.slice(0, 7);

  const active = r.lines.filter(isActive);
  const sum = <T,>(xs: T[], f: (x: T) => number | null | undefined) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const contract = sum(active, (l) => l.split_value);
  const yetToBill = sum(active, (l) => l.yet_to_bill_amount);
  const designYtb = sum(active, (l) => l.design_value);
  const billedMonth = sum(r.stages.filter((s) => s.billed_on?.startsWith(reportMonth)), (s) => s.fee);
  const prevMonth = (() => { const [y, m] = reportMonth.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); })();
  const billedPrevMonth = sum(r.stages.filter((s) => s.billed_on?.startsWith(prevMonth)), (s) => s.fee);
  const monthPays = r.payments.filter((p) => p.date.startsWith(reportMonth));
  const collectedMonth = sum(monthPays, (p) => p.amount);
  const outstanding = sum(r.open, (i) => i.balance);
  const late = sum(r.open.filter((i) => i.days_overdue > 0), (i) => i.balance);
  const old = r.open.filter((i) => i.bucket === "90+").sort((a, b) => b.days_overdue - a.days_overdue);
  const lineKey = (pn: string, studio: string | null) => `${pn}|${studio ?? ""}`;
  const lineByKey = new Map(r.lines.map((l) => [lineKey(l.project_number, l.studio), l]));
  const label = (s: Stage) => lineByKey.get(lineKey(s.project_number, s.studio))?.client_name ?? s.project_name ?? s.project_number;

  // ---- stage pipeline (cards 1-3) ----
  const byStatus = (st: Stage["workflow_status"]) => r.stages.filter((s) => s.workflow_status === st).sort((a, b) => (b.fee ?? 0) - (a.fee ?? 0));
  const pipeline = (["complete", "client_approved", "finance_notified"] as const).map((st) => {
    const xs = byStatus(st);
    return { status: st, count: xs.length, value: sum(xs, (s) => s.fee), top: xs[0] ? { ...xs[0], label: label(xs[0]) } : null };
  });

  // ---- contracts: active lines still billable, nearest end date first ----
  const expiring = active
    .filter((l) => l.end_date && (l.yet_to_bill_amount ?? 0) > 0)
    .map((l) => ({ ...l, days: daysBetween(today, l.end_date!) }))
    .filter((l) => l.days <= 60 && l.days >= -180)               // ending within 60 days, or lapsed in the last 6 months
    .sort((a, b) => (a.days >= 0) === (b.days >= 0) ? Math.abs(a.days) - Math.abs(b.days) : a.days >= 0 ? -1 : 1);

  // ---- billing-stage vs summary check (Data confidence) ----
  const billedBySl = new Map<string, number>();
  for (const s of r.stages) if (s.sl_no && s.billed_on) billedBySl.set(s.sl_no, (billedBySl.get(s.sl_no) ?? 0) + (s.fee ?? 0));
  const mismatches = r.lines.filter((l) => l.sl_no && billedBySl.has(l.sl_no) && Math.abs((l.billed_amount ?? 0) - billedBySl.get(l.sl_no)!) > 1000).length;

  // ---- studios ----
  const studioMap = new Map<string, { studio: string; tcv: number; revenue: number; lines: number }>();
  for (const l of active) {
    const k = l.studio ?? "Unassigned";
    const s = studioMap.get(k) ?? { studio: k, tcv: 0, revenue: 0, lines: 0 };
    s.tcv += l.split_value ?? 0; s.lines++; studioMap.set(k, s);
  }
  for (const s of r.stages) if (s.billed_on?.startsWith(reportMonth)) {
    const k = s.studio ?? "Unassigned";
    const x = studioMap.get(k) ?? { studio: k, tcv: 0, revenue: 0, lines: 0 };
    x.revenue += s.fee ?? 0; studioMap.set(k, x);
  }
  const studios = [...studioMap.values()].sort((a, b) => b.tcv - a.tcv);

  // ---- committed forecast: unbilled construction instalments, one per month per line ----
  const months: string[] = [];
  { const [y, m] = today.slice(0, 7).split("-").map(Number); for (let i = 1; i <= 12; i++) { const d = new Date(Date.UTC(y, m - 1 + i, 1)); months.push(d.toISOString().slice(0, 7)); } }
  const committed = months.map(() => 0);
  const cplan = new Map((r.cplan ?? []).map((c) => [lineKey(c.project_number, c.studio), c]));
  const activeKeys = new Set(active.map((l) => lineKey(l.project_number, l.studio)));
  const instalments = new Map<string, Stage[]>();
  for (const s of r.stages) if (!s.billed_on && /instal|monthly/i.test(s.stage ?? "") && activeKeys.has(lineKey(s.project_number, s.studio))) {
    const k = lineKey(s.project_number, s.studio); instalments.set(k, [...(instalments.get(k) ?? []), s]);
  }
  for (const xs of instalments.values()) {
    xs.sort((a, b) => a.seq - b.seq);
    let slot = 0;
    for (const s of xs) {
      if (slot >= 12) break;
      if ((s.pct ?? 0) > 0.05) {
        // One row holding the whole construction fee ("payable monthly over 36 months"): spread it.
        const ov = cplan.get(lineKey(s.project_number, s.studio));
        const n = ov?.months ?? instalmentMonths(s.stage, lineByKey.get(lineKey(s.project_number, s.studio))?.contract_validity).months;
        const off = ov ? monthsBetween(months[0], ov.start_month.slice(0, 7)) : slot;   // a confirmed start overrides "from next month"
        const from = Math.max(0, off), count = instalmentsInWindow(off, n, 12);
        for (let i = from; i < from + count; i++) committed[i] += (s.fee ?? 0) / n;
        slot = 12;
      } else committed[slot++] += s.fee ?? 0;
    }
  }

  // ---- recent activity ----
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const since = {
    invoices: r.invoices.filter((i) => i.date >= dayAgo.slice(0, 10)).length,
    stages: r.events.filter((e) => e.event === "complete" && e.created_at >= dayAgo).length,
    receipts: sum(r.payments.filter((p) => p.date >= dayAgo.slice(0, 10)), (p) => p.amount),
    expiring: expiring.filter((l) => l.days >= 0).length,
  };

  // ---- agent queue (one card per agent, skipping what someone already decided) ----
  const decided = new Set(r.decisions.map((d) => `${d.agent}:${d.ref}`));
  // Full queues are shared with the MCP server and the Ask tab (lib/agents); the screens show the first of each.
  const queues = {
    collections: [...r.open].filter((i) => i.days_overdue > 0 && !decided.has(`collections:${i.invoice_number}`)).sort((a, b) => b.days_overdue - a.days_overdue),
    invoice_trigger: [...byStatus("client_approved"), ...byStatus("complete")].filter((s) => !decided.has(`invoice_trigger:${s.id}`)).map((s) => ({ ...s, label: label(s) })),
    contract_watch: expiring.filter((l) => !decided.has(`contract_watch:${l.row_no}`)),
  };
  const collection = queues.collections[0] ?? null;
  const invoiceTrigger = queues.invoice_trigger[0] ?? null;
  const contractWatch = queues.contract_watch[0] ?? null;
  const notified = byStatus("finance_notified");
  const oldestNotifiedDays = notified.length ? Math.max(...notified.map((s) => (s.last_event_at ? daysBetween(s.last_event_at, today) : 0))) : 0;

  const soById = new Map(r.sos.map((s) => [s.salesorder_id, s]));
  const invoiceProject = new Map(r.invoices.map((i) => [i.invoice_id, soById.get(i.salesorder_id ?? "")?.project_name ?? null]));
  const lastPay = [...monthPays].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;

  const timeline = [...active].sort((a, b) => (b.split_value ?? 0) - (a.split_value ?? 0)).slice(0, 6);
  const sourceIsMock = lastRun?.counts?.zoho_source !== "zoho";

  return {
    today, reportMonth, lastRun, staffCount: r.staffCount, zohoIsSample: sourceIsMock,
    prevMonth,
    kpi: { contract, yetToBill, designYtb, billedMonth, billedPrevMonth, collectedMonth, outstanding, late, openCount: r.open.length, activeLines: active.length },
    open: r.open, old, pipeline, expiring, mismatches, studios, months, committed, since, queues,
    agents: {
      collection, contractWatch,
      invoiceTrigger,
      notifiedCount: notified.length, oldestNotifiedDays,
    },
    lastPay: lastPay ? { ...lastPay, project: invoiceProject.get(lastPay.invoices?.[0]?.invoice_id) ?? null } : null,
    timeline,
    activity: [
      ...r.events.map((e) => ({ at: e.created_at, text: `${e.actor_email ?? "Someone"} marked ${e.project_number} stage ${e.seq} ${e.event.replace("_", " ")}` })),
      ...r.decisions.map((d) => ({ at: d.created_at, text: `${d.actor_email ?? "Someone"} ${d.decision} ${d.agent.replace("_", " ")} ${d.ref}` })),
      ...(lastRun?.finished_at ? [{ at: lastRun.finished_at, text: `Imported ${lastRun.counts?.project_lines ?? "?"} tracker lines and ${lastRun.counts?.billing_stages ?? "?"} billing stages` }] : []),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3),
    openStages: r.stages
      .filter((s) => ["pending", "in_progress", "complete", "client_approved"].includes(s.workflow_status) && activeKeys.has(lineKey(s.project_number, s.studio)) && !/instal|monthly/i.test(s.stage ?? ""))
      .map((s) => ({ id: s.id, project_number: s.project_number, studio: s.studio, seq: s.seq, stage: s.stage, fee: s.fee, status: s.workflow_status, label: label(s) })),
  };
}
export type Dash = ReturnType<typeof build>;

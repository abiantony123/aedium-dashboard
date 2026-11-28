import type { Db as SupabaseClient } from "./supabase/server";
import { daysBetween } from "./format";
import { instalmentMonths, instalmentsInWindow, monthsBetween } from "./construction";
import { inRange, monthEnd, prevRange, presetLabel, rangeLabel, type Range } from "./period";

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
  reference_number?: string | null; line_items?: { description?: string; amount?: number; project_number?: string; stage_seq?: number }[];
  client_name?: string | null;
};
export type Invoice = {
  invoice_id: string; invoice_number: string; salesorder_id: string | null; reference_number?: string | null;
  date: string; total: number; balance: number;
  line_items?: { description?: string; amount?: number; project_number?: string; stage_seq?: number }[];
};
export type Payment = { payment_id: string; payment_number: string | null; customer_id: string | null; date: string; amount: number; tax_amount_withheld: number; invoices: { invoice_id: string }[] };
export type SalesOrder = { salesorder_id: string; project_name: string | null; project_number: string | null; studio: string | null; total: number | null };
export type Decision = { agent: string; ref: string; decision: string; created_at: string; actor_email: string | null };
export type Event = { project_number: string; studio: string | null; seq: number; event: string; created_at: string; actor_email: string | null };
export type ImportRun = { id: number; source: string; finished_at: string | null; ok: boolean | null; counts: Record<string, unknown> | null; issues: string[] | null; report_month: string | null };

// The tracker ends each Billing Stages block with summary rows ("Billed till date", "Billable", "To be Billed").
// The import keeps them as rows; they are totals, not stages, so stage-level logic must skip them.
export const isSummaryRow = (s: { stage: string | null }) => /^[\s ]*(to[\s ]+be[\s ]+billed|billable|billed[\s ]+till[\s ]+date|total)\b/i.test(s.stage ?? "");

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

export async function loadDashboard(sb: SupabaseClient, studio?: string | null, client?: string | null, project?: string | null, stageId?: number | null, range?: Range | null) {
  const [lines, stages, open, invoices, payments, sos, decisions, events, runs, staff, cplan, cplanFallback] = await Promise.all([
    all<Line>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,location,contract_validity,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc"),
    all<Stage>(sb, "v_stages", "id,project_number,studio,seq,sl_no,project_name,stage,pct,fee,billed_on,row_no,workflow_status,last_event_at,last_event_by"),
    all<OpenInvoice>(sb, "v_open_invoices", "invoice_id,invoice_number,customer_name,project_name,project_number,studio,date,due_date,total,balance,days_overdue,bucket,reference_number,line_items", "invoice_id"),
    all<Invoice>(sb, "zoho_invoices", "invoice_id,invoice_number,salesorder_id,reference_number,date,total,balance,line_items", "invoice_id"),
    all<Payment>(sb, "zoho_payments", "payment_id,payment_number,customer_id,date,amount,tax_amount_withheld,invoices", "payment_id"),
    all<SalesOrder>(sb, "zoho_sales_orders", "salesorder_id,project_name,project_number,studio,total", "salesorder_id"),
    sb.from("agent_decisions").select("agent,ref,decision,created_at,actor_email").order("created_at", { ascending: false }).limit(200),
    sb.from("stage_events").select("project_number,studio,seq,event,created_at,actor_email").order("created_at", { ascending: false }).limit(50),
    sb.from("import_runs").select("id,source,finished_at,ok,counts,issues,report_month").order("id", { ascending: false }).limit(5),
    sb.from("staff").select("id", { count: "exact", head: true }),
    sb.from("construction_plan").select("project_number,studio,start_month,months"),   // optional table: absent until its migration is run
    sb.from("agent_decisions").select("ref,note").eq("agent", "construction_plan").eq("decision", "approved").order("id"),
  ]);
  const lineByPn = new Map<string, Line>();
  for (const l of lines) if (!lineByPn.has(l.project_number)) lineByPn.set(l.project_number, l);
  const enrichedOpen: OpenInvoice[] = open.map((i) => {
    const li = i.line_items?.[0];
    const pn = i.project_number ?? li?.project_number ?? i.reference_number ?? null;
    const descStudio = li?.description?.split("|")[0]?.trim() || null;
    const matchedLine = (pn && descStudio ? lines.find((l) => l.project_number === pn && l.studio === descStudio) : null) ?? (pn ? lineByPn.get(pn) : undefined);
    return {
      ...i,
      project_number: pn,
      studio: i.studio ?? descStudio ?? matchedLine?.studio ?? null,
      project_name: i.project_name ?? matchedLine?.project_name ?? i.customer_name,
      client_name: matchedLine?.client_name ?? i.customer_name,
    };
  });
  const cplanMerged = new Map<string, { project_number: string; studio: string; start_month: string; months: number | null }>();
  for (const d of cplanFallback.data ?? []) {
    if (!d.note) continue;
    try {
      const p = JSON.parse(d.note) as { start_month?: string; months?: number | null };
      if (!p.start_month) continue;
      const [pn, st = ""] = String(d.ref).split("|");
      cplanMerged.set(`${pn}|${st}`, { project_number: pn, studio: st, start_month: p.start_month, months: p.months ?? null });
    } catch { /* ignore malformed note */ }
  }
  for (const c of (cplan.data ?? []) as NonNullable<Raw["cplan"]>) cplanMerged.set(`${c.project_number}|${c.studio ?? ""}`, c);
  const raw: Raw = {
    lines, stages, open: enrichedOpen, invoices, payments, sos,
    decisions: (decisions.data ?? []) as Decision[], events: (events.data ?? []) as Event[],
    runs: (runs.data ?? []) as ImportRun[], staffCount: staff.count ?? 0, cplan: [...cplanMerged.values()],
  };
  const allStudios = [...new Set(lines.map((l) => l.studio).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b, "en-IN", { sensitivity: "base" }));
  const clients = clientTree(raw.lines, raw.stages);   // full alphabetical catalog so cascading dropdowns always see all project studios
  let scoped = raw;
  if (client) scoped = filterClient(scoped, client);
  if (project) scoped = filterProject(scoped, project);
  if (studio) scoped = filterStudio(scoped, studio);
  if (stageId) scoped = filterStage(scoped, stageId);
  return { ...build(scoped, range ?? null), studio: studio ?? null, allStudios, client: client ?? null, project: project ?? null, stage: stageId ?? null, clients };
}

// One client's slice. Zoho rows follow the project number on their sales order, invoice reference, or customer name.
function filterClient(r: Raw, client: string): Raw {
  const pns = new Set(r.lines.filter((l) => l.client_name === client).map((l) => l.project_number));
  const soIds = new Set(r.sos.filter((s) => s.project_number && pns.has(s.project_number)).map((s) => s.salesorder_id));
  const invoices = r.invoices.filter((i) => soIds.has(i.salesorder_id ?? "") || (i.reference_number && pns.has(i.reference_number)) || (i.line_items?.[0]?.project_number && pns.has(i.line_items[0].project_number)));
  const invIds = new Set(invoices.map((i) => i.invoice_id));
  return {
    ...r,
    lines: r.lines.filter((l) => l.client_name === client),
    stages: r.stages.filter((s) => pns.has(s.project_number)),
    open: r.open.filter((i) => (i.project_number && pns.has(i.project_number)) || i.customer_name?.toLowerCase() === client.toLowerCase()),
    invoices, sos: r.sos.filter((s) => soIds.has(s.salesorder_id)),
    payments: r.payments.filter((p) => p.invoices?.some((x) => invIds.has(x.invoice_id))),
  };
}

// One project's slice across lines, billing stages, and Zoho invoices/payments.
function filterProject(r: Raw, project: string): Raw {
  const soIds = new Set(r.sos.filter((s) => s.project_number === project).map((s) => s.salesorder_id));
  const invoices = r.invoices.filter((i) => soIds.has(i.salesorder_id ?? "") || i.reference_number === project || i.line_items?.[0]?.project_number === project);
  const invIds = new Set(invoices.map((i) => i.invoice_id));
  return {
    ...r,
    lines: r.lines.filter((l) => l.project_number === project),
    stages: r.stages.filter((s) => s.project_number === project),
    open: r.open.filter((i) => i.project_number === project),
    invoices, sos: r.sos.filter((s) => soIds.has(s.salesorder_id)),
    payments: r.payments.filter((p) => p.invoices?.some((x) => invIds.has(x.invoice_id))),
  };
}

// One milestone/stage's isolated financial slice across KPIs, pipeline cards, and Zoho rows.
function filterStage(r: Raw, stageId: number): Raw {
  const st = r.stages.find((s) => s.id === stageId);
  if (!st) return { ...r, lines: [], stages: [], open: [], invoices: [], payments: [], sos: [] };
  const fee = Number(st.fee) || 0;
  const isBilled = Boolean(st.billed_on) || st.workflow_status === "billed" || st.workflow_status === "invoiced";
  const cat = stageCategory(st.stage);
  const baseLine =
    (st.sl_no ? r.lines.find((l) => l.project_number === st.project_number && l.sl_no === st.sl_no) : undefined) ??
    r.lines.find((l) => l.project_number === st.project_number && l.studio === st.studio) ??
    r.lines.find((l) => l.project_number === st.project_number);
  const lines: Line[] = baseLine ? [{
    ...baseLine,
    split_value: fee,
    billed_amount: isBilled ? fee : 0,
    yet_to_bill_amount: isBilled ? 0 : fee,
    billed_pct: isBilled ? 1 : 0,
    design_value: !isBilled && cat === "design" ? fee : 0,
    construction_value: !isBilled && cat === "construction" ? fee : 0,
    project_stage: st.stage,
  }] : [];
  const invMatch = (i: { line_items?: { project_number?: string; stage_seq?: number }[] }) => {
    const li = i.line_items?.[0];
    if (li?.stage_seq != null) return li.stage_seq === st.seq && (!li.project_number || li.project_number === st.project_number);
    return false;
  };
  const open = isBilled ? r.open.filter((i) => (!st.project_number || i.project_number === st.project_number) && invMatch(i)) : [];
  const invoices = isBilled ? r.invoices.filter((i) => invMatch(i)) : [];
  const invIds = new Set(invoices.map((i) => i.invoice_id));
  return {
    ...r,
    lines,
    stages: [st],
    open,
    invoices,
    sos: [],
    payments: isBilled ? r.payments.filter((p) => p.invoices?.some((x) => invIds.has(x.invoice_id))) : [],
  };
}

// Client -> project -> studio lines -> billing stages, active lines only. Value is the sum of each studio's own split
// (never the repeated project total), so a combined PO is not counted once per studio.
export type ClientStageNode = {
  id: number; seq: number; stage: string | null; pct: number | null; fee: number | null; billed_on: string | null;
  workflow_status: Stage["workflow_status"]; last_event_at: string | null;
  category: "advance" | "design" | "construction";
};
export type ClientStudioNode = {
  sl_no: string | null; line_name: string | null;
  studio: string | null; value: number; splitPct: number | null; billed: number; billedPct: number | null; yetToBill: number;
  designValue: number; constructionValue: number; stage: string | null; spoc: string | null; status: string | null;
  stages: ClientStageNode[];
};
export type ClientProjectNode = {
  project_number: string; name: string | null; location: string | null; type: string | null;
  validity: string | null; start_date: string | null; end_date: string | null;
  contract: number; billed: number; yetToBill: number; studios: ClientStudioNode[];
};
export type ClientNode = {
  client: string; contract: number; billed: number; yetToBill: number; lines: number;
  projects: ClientProjectNode[];
};
const stageCategory = (name: string | null): "advance" | "design" | "construction" => {
  if (/instal|monthly|construction stage/i.test(name ?? "")) return "construction";
  if (/advance|appointment|mobilis|upon signing|confirmation of order/i.test(name ?? "")) return "advance";
  return "design";
};
const cmpAlpha = (a: string, b: string) => a.localeCompare(b, "en-IN", { sensitivity: "base" });
export function clientTree(lines: Line[], stages: Stage[] = []): ClientNode[] {
  const byClient = new Map<string, Map<string, Line[]>>();
  const allSlsByPn = new Map<string, Set<string>>();
  for (const l of lines) {
    if (!l.sl_no) continue;
    const set = allSlsByPn.get(l.project_number) ?? new Set<string>();
    set.add(l.sl_no);
    allSlsByPn.set(l.project_number, set);
  }
  for (const l of lines.filter(isActive)) {
    const c = l.client_name?.trim() || "Unassigned";
    const projects = byClient.get(c) ?? new Map<string, Line[]>(); byClient.set(c, projects);
    projects.set(l.project_number, [...(projects.get(l.project_number) ?? []), l]);
  }
  const stagesByPn = new Map<string, Stage[]>();
  for (const s of stages) stagesByPn.set(s.project_number, [...(stagesByPn.get(s.project_number) ?? []), s]);
  for (const xs of stagesByPn.values()) xs.sort((a, b) => a.seq - b.seq);
  const toStageNode = (s: Stage): ClientStageNode => ({
    id: s.id, seq: s.seq, stage: s.stage, pct: s.pct, fee: s.fee, billed_on: s.billed_on,
    workflow_status: s.workflow_status, last_event_at: s.last_event_at, category: stageCategory(s.stage),
  });
  const n = (v: number | null | undefined) => Number(v) || 0;
  return [...byClient.entries()].map(([client, projects]) => {
    const ps: ClientProjectNode[] = [...projects.entries()].map(([project_number, ls]) => {
      const contract = ls.reduce((a, l) => a + n(l.split_value), 0);
      const pStages = stagesByPn.get(project_number) ?? [];
      const claimed = new Set<number>();
      const slCounts = new Map<string, number>();
      for (const l of ls) if (l.sl_no) slCounts.set(l.sl_no, (slCounts.get(l.sl_no) ?? 0) + 1);
      // Match each active line to its own billing stages by sl_no first so same-studio lines never duplicate stages.
      const stagesByLine = new Map<number, Stage[]>();
      for (const l of ls) {
        if (!l.sl_no) continue;
        const multiSl = (slCounts.get(l.sl_no) ?? 0) > 1;
        const matches = pStages.filter((s) => !claimed.has(s.id) && s.sl_no === l.sl_no && (!multiSl || (s.studio ?? "") === (l.studio ?? "")));
        for (const s of matches) claimed.add(s.id);
        stagesByLine.set(l.id, matches);
      }
      const knownProjectSls = allSlsByPn.get(project_number) ?? new Set<string>();
      for (const l of ls) {
        if ((stagesByLine.get(l.id)?.length ?? 0) > 0) continue;
        const fallback = pStages.filter((s) => !claimed.has(s.id) && (s.studio ?? "") === (l.studio ?? "") && (!s.sl_no || !knownProjectSls.has(s.sl_no)));
        for (const s of fallback) claimed.add(s.id);
        stagesByLine.set(l.id, fallback);
      }
      return {
        project_number, name: ls[0].project_name, location: ls[0].location, type: ls[0].project_type,
        validity: ls[0].contract_validity, start_date: ls[0].start_date, end_date: ls[0].end_date,
        contract, billed: ls.reduce((a, l) => a + n(l.billed_amount), 0), yetToBill: ls.reduce((a, l) => a + n(l.yet_to_bill_amount), 0),
        studios: ls.map((l) => {
          const val = n(l.split_value);
          return {
            sl_no: l.sl_no, line_name: l.project_name,
            studio: l.studio, value: val, splitPct: contract > 0 ? val / contract : null,
            billed: n(l.billed_amount), billedPct: l.billed_pct, yetToBill: n(l.yet_to_bill_amount),
            designValue: n(l.design_value), constructionValue: n(l.construction_value),
            stage: l.project_stage, spoc: l.spoc, status: l.status, stages: (stagesByLine.get(l.id) ?? []).map(toStageNode),
          };
        }).sort((a, b) => cmpAlpha(a.studio ?? "", b.studio ?? "") || cmpAlpha(a.line_name ?? "", b.line_name ?? "") || cmpAlpha(a.sl_no ?? "", b.sl_no ?? "")),
      };
    }).sort((a, b) => cmpAlpha((a.name ?? a.project_number).trim(), (b.name ?? b.project_number).trim()));
    return { client, contract: ps.reduce((a, p) => a + p.contract, 0), billed: ps.reduce((a, p) => a + p.billed, 0), yetToBill: ps.reduce((a, p) => a + p.yetToBill, 0), lines: ps.reduce((a, p) => a + p.studios.length, 0), projects: ps };
  }).sort((a, b) => cmpAlpha(a.client, b.client));
}

// One studio's slice: tracker rows by studio, Zoho rows through their sales order's studio or invoice line prefix.
function filterStudio(r: Raw, studio: string): Raw {
  const soIds = new Set(r.sos.filter((s) => s.studio === studio).map((s) => s.salesorder_id));
  const invoices = r.invoices.filter((i) => soIds.has(i.salesorder_id ?? "") || (i.line_items?.[0]?.description ?? "").startsWith(studio + " |"));
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

export function build(r: Raw, range: Range | null = null) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()); // YYYY-MM-DD in IST
  const lastRun = r.runs.find((x) => x.ok) ?? null;
  // Report month: the latest month with billing in the tracker (the sheet lags the calendar).
  const billedMonths = r.stages.map((s) => s.billed_on).filter((d): d is string => !!d && d <= today).map((d) => d.slice(0, 7));
  const reportMonth = (lastRun?.report_month?.slice(0, 7)) ?? billedMonths.sort().at(-1) ?? today.slice(0, 7);
  // Period for flow figures (billed, collected, invoices raised). No range picked = the report month, as before.
  const custom = !!range;
  const per: Range = range ?? { from: `${reportMonth}-01`, to: monthEnd(`${reportMonth}-01`) };
  const prevPer = prevRange(per);
  const inP = (d: string | null | undefined) => inRange(per, d);

  const active = r.lines.filter(isActive);
  const sum = <T,>(xs: T[], f: (x: T) => number | null | undefined) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const contract = sum(active, (l) => l.split_value);
  const billedTotal = sum(active, (l) => l.billed_amount);
  const yetToBill = sum(active, (l) => l.yet_to_bill_amount);
  const designYtb = sum(active, (l) => l.design_value);
  const billedMonth = sum(r.stages.filter((s) => inP(s.billed_on)), (s) => s.fee);
  const prevMonth = (() => { const [y, m] = reportMonth.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); })();
  const billedPrevMonth = sum(r.stages.filter((s) => inRange(prevPer, s.billed_on)), (s) => s.fee);
  const monthPays = r.payments.filter((p) => inP(p.date));
  const collectedMonth = sum(monthPays, (p) => p.amount);
  // With a range picked, receivables are the open invoices raised in it; otherwise every open invoice.
  const openP = custom ? r.open.filter((i) => inP(i.date)) : r.open;
  const outstanding = sum(openP, (i) => i.balance);
  const late = sum(openP.filter((i) => i.days_overdue > 0), (i) => i.balance);
  const old = openP.filter((i) => i.bucket === "90+").sort((a, b) => b.days_overdue - a.days_overdue);
  const lineKey = (pn: string, studio: string | null) => `${pn}|${studio ?? ""}`;
  const lineByKey = new Map(r.lines.map((l) => [lineKey(l.project_number, l.studio), l]));
  const label = (s: Stage) => lineByKey.get(lineKey(s.project_number, s.studio))?.client_name ?? s.project_name ?? s.project_number;

  // ---- stage pipeline (cards 1-3) ----
  const byStatus = (st: Stage["workflow_status"]) => r.stages.filter((s) => s.workflow_status === st).sort((a, b) => (b.fee ?? 0) - (a.fee ?? 0));
  const pipeline = (["complete", "client_approved", "finance_notified"] as const).map((st) => {
    // Cards 1-3 are a live work queue: never date-filtered (imported stages carry no event date).
    const xs = byStatus(st).map((s) => ({ ...s, label: label(s) }));
    return { status: st, count: xs.length, value: sum(xs, (s) => s.fee), top: xs[0] ?? null, items: xs };
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
  // "Since yesterday" runs on the real clock (IST), not the report month; `last` says when each feed last moved,
  // so an all-zero card reads as "quiet" rather than "broken".
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const yday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - 86400000));
  const maxOf = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
  const last = {
    invoice: maxOf(r.invoices.map((i) => i.date)),
    receipt: maxOf(r.payments.map((p) => p.date)),
    stage: maxOf(r.events.filter((e) => e.event === "complete").map((e) => e.created_at?.slice(0, 10))),
  };
  const since = custom ? {
    invoices: r.invoices.filter((i) => inP(i.date)).length,
    stages: r.events.filter((e) => e.event === "complete" && inP(e.created_at)).length,
    receipts: collectedMonth,
    expiring: active.filter((l) => inP(l.end_date) && (l.yet_to_bill_amount ?? 0) > 0).length,
    lapsed: 0, last,
  } : {
    invoices: r.invoices.filter((i) => i.date >= yday).length,
    stages: r.events.filter((e) => e.event === "complete" && e.created_at >= dayAgo).length,
    receipts: sum(r.payments.filter((p) => p.date >= yday), (p) => p.amount),
    expiring: expiring.filter((l) => l.days >= 0).length,                 // ending in the next 60 days
    lapsed: expiring.filter((l) => l.days < 0).length,                   // ended in the last 6 months, still unbilled
    last,
  };

  // ---- agent queue (one card per agent, skipping what someone already decided) ----
  const decided = new Set(r.decisions.map((d) => `${d.agent}:${d.ref}`));
  // Full queues are shared with the MCP server and the Ask tab (lib/agents); the screens show the first of each.
  const queues = {
    collections: [...r.open].filter((i) => i.days_overdue > 0 && !decided.has(`collections:${i.invoice_number}`)).sort((a, b) => b.days_overdue - a.days_overdue),
    invoice_trigger: [...byStatus("client_approved"), ...byStatus("complete")].filter((s) => !decided.has(`invoice_trigger:${s.id}`)).map((s) => ({ ...s, label: label(s) })),
    contract_watch: expiring.filter((l) => !decided.has(`contract_watch:${l.row_no}`)),
  };
  const collection = queues.collections.at(0) ?? null;
  const invoiceTrigger = queues.invoice_trigger.at(0) ?? null;
  const contractWatch = queues.contract_watch.at(0) ?? null;
  const notified = byStatus("finance_notified");
  const oldestNotifiedDays = notified.length ? Math.max(...notified.map((s) => (s.last_event_at ? daysBetween(s.last_event_at, today) : 0))) : 0;

  const soById = new Map(r.sos.map((s) => [s.salesorder_id, s]));
  const invoiceMap = new Map(r.invoices.map((i) => [i.invoice_id, i]));
  const lineByPn = new Map<string, Line>();
  for (const l of r.lines) if (!lineByPn.has(l.project_number)) lineByPn.set(l.project_number, l);
  const invoiceProject = new Map(r.invoices.map((i) => {
    const pn = soById.get(i.salesorder_id ?? "")?.project_number ?? i.reference_number ?? i.line_items?.[0]?.project_number ?? null;
    return [i.invoice_id, soById.get(i.salesorder_id ?? "")?.project_name ?? (pn ? lineByPn.get(pn)?.project_name : null) ?? null];
  }));
  const payments = [...r.payments].sort((a, b) => b.date.localeCompare(a.date)).map((p) => {
    const invId = p.invoices?.[0]?.invoice_id;
    const inv = invId ? invoiceMap.get(invId) : undefined;
    const so = inv?.salesorder_id ? soById.get(inv.salesorder_id) : undefined;
    const pn = so?.project_number ?? inv?.reference_number ?? inv?.line_items?.[0]?.project_number ?? null;
    const line = pn ? lineByPn.get(pn) : undefined;
    return {
      ...p,
      invoice_number: inv?.invoice_number ?? null,
      project: so?.project_name ?? line?.project_name ?? line?.client_name ?? pn ?? null,
    };
  });
  const lastPay = [...monthPays].sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;

  const timeline = [...active].sort((a, b) => (b.split_value ?? 0) - (a.split_value ?? 0)).slice(0, 6);
  const sourceIsMock = lastRun?.counts?.zoho_source !== "zoho";

  return {
    today, reportMonth, lastRun, staffCount: r.staffCount, zohoIsSample: sourceIsMock,
    prevMonth,
    period: { ...per, custom, label: custom ? presetLabel(per, today) : rangeLabel(per), prev: prevPer, prevLabel: rangeLabel(prevPer) },
    kpi: { contract, billedTotal, yetToBill, designYtb, billedMonth, billedPrevMonth, collectedMonth, outstanding, late, openCount: openP.length, activeLines: active.length },
    open: openP, openAll: r.open, old, payments, pipeline, expiring, mismatches, studios, months, committed, since, queues,
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

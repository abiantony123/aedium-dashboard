// F2 · Probability-weighted billing and cash forecast.
// Model v1 (statistical, no AI): each unbilled stage on an active line gets a chance of being billed per month.
//  · Stages already moving (complete → approved → with Finance) get high fixed chances.
//  · Other milestone stages use their studio's throughput: stages billed in the last 12 months ÷ stages waiting,
//    halved when the line has had no billing or stage movement for 12 months (stalled).
//  · Construction instalments: one per month, at a lower chance (they follow site progress).
// The 80% range treats stages as independent (normal approximation), so it is narrower than reality.
// Cash = expected billing shifted by each client's usual days-to-pay (Zoho Books; sample data until connected).
import type { Db } from "./supabase/server";
import { all, isActive, isSummaryRow, type Line, type Stage, type OpenInvoice } from "./data";
import { fyOf, fyPlan } from "./plan";

export const MODEL = "throughput-v1";
const IST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const isInstalment = (s: { stage: string | null }) => /instal|monthly|construction stage/i.test(s.stage ?? "");
const Z80 = 1.2816;
const MOVING: Record<string, number> = { finance_notified: 0.95, invoiced: 0.97, client_approved: 0.9, complete: 0.8 };

type Item = { project_number: string; studio: string | null; seq: number; client_name: string | null; project_name: string | null; stage: string | null; fee: number; per?: number; p: number; month: string | null; cash_month: string | null; basis: string; byMonth: number[] };

export async function forecast(sb: Db, studio: string | null) {
  const today = IST(), fy = fyOf(today), cur = today.slice(0, 7);
  const months: string[] = []; for (let m = cur; m <= fy.end.slice(0, 7); m = addMonths(m, 1)) months.push(m);
  const [lines0, stages0, open0, payDays, manual] = await Promise.all([
    all<Line>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc"),
    all<Stage>(sb, "v_stages", "id,project_number,studio,seq,sl_no,project_name,stage,pct,fee,billed_on,row_no,workflow_status,last_event_at,last_event_by"),
    all<OpenInvoice>(sb, "v_open_invoices", "invoice_id,invoice_number,customer_name,project_name,project_number,studio,date,due_date,total,balance,days_overdue,bucket", "invoice_id"),
    sb.from("v_client_payment_days").select("customer_name,paid_invoices,avg_days,median_days"),
    fyPlan(sb, studio),
  ]);
  const lines = studio ? lines0.filter((l) => l.studio === studio) : lines0;
  const stages = (studio ? stages0.filter((s) => s.studio === studio) : stages0).filter((s) => !isSummaryRow(s));
  const open = studio ? open0.filter((i) => i.studio === studio) : open0;
  const key = (pn: string, st: string | null) => `${pn}|${st ?? ""}`;
  const lineBy = new Map(lines.map((l) => [key(l.project_number, l.studio), l]));
  const active = new Set(lines.filter(isActive).map((l) => key(l.project_number, l.studio)));
  const yearAgo = new Date(Date.parse(today) - 365 * 86400000).toISOString().slice(0, 10);

  // Studio throughput and line activity.
  const billed12 = new Map<string, number>(), waiting = new Map<string, number>(), lastMove = new Map<string, string>();
  for (const s of stages) {
    const st = s.studio ?? "Unassigned", lk = key(s.project_number, s.studio);
    if (s.billed_on && s.billed_on >= yearAgo) billed12.set(st, (billed12.get(st) ?? 0) + 1);
    const mv = [s.billed_on, s.last_event_at?.slice(0, 10)].filter(Boolean).sort().pop();
    if (mv && mv > (lastMove.get(lk) ?? "")) lastMove.set(lk, mv);
    if (!s.billed_on && s.workflow_status !== "invoiced" && active.has(lk) && !isInstalment(s)) waiting.set(st, (waiting.get(st) ?? 0) + 1);
  }
  const rateOf = (st: string) => Math.min(0.35, (billed12.get(st) ?? 0) / 12 / Math.max(waiting.get(st) ?? 1, 1));

  // Payment days per client (fallback: median across clients, else 75).
  const pd = (payDays.data ?? []).filter((r) => r.paid_invoices > 0);
  const sortedDays = pd.map((r) => Number(r.median_days ?? r.avg_days)).sort((a, b) => a - b);
  const defaultDays = sortedDays.length ? sortedDays[Math.floor(sortedDays.length / 2)] : 75;
  const daysFor = (name: string | null) => { const n = (name ?? "").toLowerCase(); const r = pd.find((x) => n && (x.customer_name ?? "").toLowerCase().includes(n.split(" ")[0])); return r ? { days: Number(r.median_days ?? r.avg_days), n: r.paid_invoices as number } : { days: defaultDays, n: 0 }; };
  const shift = (ym: string, days: number) => addMonths(ym, Math.round(days / 30));

  const items: Item[] = [];
  const inst = new Map<string, Stage[]>();
  for (const s of stages) {
    const lk = key(s.project_number, s.studio);
    if (s.billed_on || !active.has(lk) || !(Number(s.fee) > 0)) continue;
    if (isInstalment(s) && !MOVING[s.workflow_status]) { inst.set(lk, [...(inst.get(lk) ?? []), s]); continue; }
    const l = lineBy.get(lk)!;
    const byMonth = months.map(() => 0);
    let p: number, basis: string;
    if (MOVING[s.workflow_status]) {
      p = MOVING[s.workflow_status];
      const first = s.workflow_status === "complete" ? Math.min(1, months.length - 1) : 0;
      byMonth[first] = p; basis = `${s.workflow_status.replace("_", " ")} · ${Math.round(p * 100)}% by ${months[first]}`;
    } else {
      let r = rateOf(s.studio ?? "Unassigned");
      const stalled = (lastMove.get(lk) ?? "") < yearAgo;
      if (stalled) r /= 2;
      let left = 1;
      for (let k = 0; k < months.length; k++) { byMonth[k] = left * r; left *= 1 - r; }
      p = 1 - left;
      basis = `${s.studio ?? "Studio"} bills ${(r * 100).toFixed(1)}% of waiting stages a month${stalled ? " · halved: no movement for 12 months" : ""}`;
    }
    let cum = 0, month: string | null = null;
    for (let k = 0; k < months.length; k++) { cum += byMonth[k]; if (cum >= 0.5) { month = months[k]; break; } }
    const days = daysFor(l.client_name).days;
    items.push({ project_number: s.project_number, studio: s.studio, seq: s.seq, client_name: l.client_name, project_name: l.project_name, stage: s.stage, fee: Number(s.fee), p, month, cash_month: month ? shift(month, days) : null, basis, byMonth });
  }
  for (const [lk, xs] of inst) {
    xs.sort((a, b) => a.seq - b.seq);
    const l = lineBy.get(lk)!;
    const started = (lastMove.get(lk) ?? "") >= yearAgo;
    const pm = started ? 0.6 : 0.25;
    let k = 0;
    for (const s of xs) {
      if (k >= months.length) break;
      const big = (s.pct ?? 0) > 0.05;
      const n = big ? Number((s.stage ?? "").match(/(\d+)\s*(?:months|monthly|instal)/i)?.[1]) || 36 : 1;
      const span = big ? Math.min(n, months.length - k) : 1;
      const per = big ? Number(s.fee) / n : Number(s.fee), byMonth = months.map(() => 0);
      for (let j = 0; j < span; j++) byMonth[k + j] = pm;
      // One item per instalment window: fee = what falls inside the FY; each month bills `per` with chance pm.
      items.push({ project_number: s.project_number, studio: s.studio, seq: s.seq, client_name: l.client_name, project_name: l.project_name, stage: s.stage, fee: per * span, per, p: pm, month: months[k], cash_month: shift(months[k], daysFor(l.client_name).days), basis: `Construction instalment${span > 1 ? `s × ${span}` : ""} · ${Math.round(pm * 100)}% a month${started ? "" : " · site progress unknown"}`, byMonth });
      k += span;
    }
  }

  // Totals and range. Milestones: one Bernoulli per stage. Instalments: one Bernoulli per month in the window.
  const expected = items.reduce((a, it) => a + it.fee * it.p, 0);
  const varOf = (it: Item) => it.per != null ? it.byMonth.reduce((a, q) => a + it.per! * it.per! * q * (1 - q), 0) : it.fee * it.fee * it.p * (1 - it.p);
  const sd = Math.sqrt(items.reduce((a, it) => a + varOf(it), 0));
  const amt = (it: Item) => it.per ?? it.fee;
  const billing = months.map((_, k) => items.reduce((a, it) => a + amt(it) * it.byMonth[k], 0));
  const billingVar = months.map((_, k) => items.reduce((a, it) => { const q = it.byMonth[k]; return a + amt(it) * amt(it) * q * (1 - q); }, 0));

  // Collections: open invoices + expected billing, each shifted by the client's days-to-pay.
  const collections = months.map(() => 0);
  const custOpen = new Map<string, { name: string; open: number; days: number; n: number; due: string }>();
  for (const i of open) {
    const d = daysFor(i.customer_name);
    const exp = addMonths(i.date.slice(0, 7), Math.round(d.days / 30));
    const k = Math.max(0, months.indexOf(exp < cur ? cur : exp));
    if (exp <= months[months.length - 1]) collections[exp < cur ? Math.min(months.length - 1, 1) : k] += Number(i.balance) * (exp < cur ? 0.6 : 0.85);
    const c = custOpen.get(i.customer_name ?? "?") ?? { name: i.customer_name ?? "?", open: 0, days: d.days, n: d.n, due: exp };
    c.open += Number(i.balance); if (exp > c.due) c.due = exp; custOpen.set(c.name, c);
  }
  for (const it of items) if (it.cash_month && months.includes(it.cash_month)) collections[months.indexOf(it.cash_month)] += it.fee * it.p * 0.9;
  const outstanding = open.reduce((a, i) => a + Number(i.balance), 0);
  const backBeforeFyEnd = [...custOpen.values()].filter((c) => c.due <= months[months.length - 1]).reduce((a, c) => a + c.open * 0.85, 0);
  const cashTotal = collections.reduce((a, b) => a + b, 0);
  const cashSd = Math.sqrt(items.filter((it) => it.cash_month && months.includes(it.cash_month)).reduce((a, it) => a + it.fee * it.fee * it.p * (1 - it.p), 0) + open.reduce((a, i) => a + Number(i.balance) ** 2 * 0.15 * 0.85, 0));
  const dragger = [...custOpen.values()].sort((a, b) => b.open * b.days - a.open * a.days)[0] ?? null;

  const billedYtd = manual.total.billed_ytd;
  const studiosF = new Map<string, number>(), clientsF = new Map<string, number>();
  for (const it of items) { studiosF.set(it.studio ?? "Unassigned", (studiosF.get(it.studio ?? "Unassigned") ?? 0) + it.fee * it.p); clientsF.set(it.client_name ?? it.project_number, (clientsF.get(it.client_name ?? it.project_number) ?? 0) + it.fee * it.p); }
  const qEnd = (() => { const m = Number(cur.slice(5)); const qm = m <= 3 ? 3 : m <= 6 ? 6 : m <= 9 ? 9 : 12; return `${cur.slice(0, 4)}-${String(qm).padStart(2, "0")}`; })();
  const qIdx = Math.max(0, months.indexOf(qEnd) >= 0 ? months.indexOf(qEnd) : months.length - 1);
  const pQuarter = (it: Item) => Math.min(1, it.byMonth.slice(0, qIdx + 1).reduce((a, b) => a + b, 0));
  const movers = items.filter((it) => it.per == null).map((it) => ({ it, pq: pQuarter(it) }))
    .sort((a, b) => b.it.fee * b.pq - a.it.fee * a.pq).slice(0, 8);
  const stalledShare = (() => { const ms = items.filter((it) => it.per == null); const v = ms.filter((it) => /halved/.test(it.basis)).reduce((a, it) => a + it.fee, 0), t = ms.reduce((a, it) => a + it.fee, 0); return t ? v / t : 0; })();

  return {
    model: MODEL, fy: fy.label, today, months, months_left: months.length - 1, studio: studio ?? "All",
    manual: { outlook: manual.total.outlook, billed_ytd: billedYtd, design_pending: manual.total.design_pending, construction: manual.total.construction_in_fy },
    total: { expected: billedYtd + expected, pending_expected: expected, low: billedYtd + Math.max(0, expected - Z80 * sd), high: billedYtd + expected + Z80 * sd },
    unlikely: Math.max(0, manual.total.outlook - billedYtd - expected),
    byMonth: months.map((m, k) => ({ month: m, billing: billing[k], low: Math.max(0, billing[k] - Z80 * Math.sqrt(billingVar[k])), high: billing[k] + Z80 * Math.sqrt(billingVar[k]), collections: collections[k] })),
    cash: { total: cashTotal, low: Math.max(0, cashTotal - Z80 * cashSd), high: cashTotal + Z80 * cashSd, outstanding, back_before_fy_end: backBeforeFyEnd, dragger: dragger?.name ?? null, default_days: defaultDays },
    quarter_end: months[qIdx],
    movers: movers.map(({ it, pq }) => ({ project_number: it.project_number, studio: it.studio, seq: it.seq, client: it.client_name, project: it.project_name, stage: it.stage, fee: it.fee, p: pq, month: it.month, cash_month: it.cash_month })),
    payments: [...custOpen.values()].sort((a, b) => b.open - a.open).slice(0, 6).map((c) => ({ ...c, confidence: c.n >= 5 ? "High" : c.n >= 2 ? "Medium" : "Low" })),
    byStudio: manual.rows.map((r) => ({ studio: r.studio, manual: r.outlook, forecast: r.billed_ytd + (studiosF.get(r.studio) ?? 0) })).sort((a, b) => b.manual - a.manual).slice(0, 10),
    byClient: [...clientsF.entries()].map(([client, v]) => ({ client, forecast: v })).sort((a, b) => b.forecast - a.forecast).slice(0, 10),
    stalled_share: stalledShare,
    items,
    zohoSample: true,
    method: "Each stage is weighted by how often similar stages at that studio were billed in the last 12 months; stages complete, approved or with Finance get 80–95%. Range assumes stages are independent.",
  };
}

export type Forecast = Awaited<ReturnType<typeof forecast>>;

// One snapshot per month and studio (the first run of the month), so later months can be backtested against actuals.
export async function snapshot(sb: Db, f: Forecast, by: string) {
  const month = `${f.today.slice(0, 7)}-01`;
  const { data: have } = await sb.from("forecast_runs").select("id").eq("month", month).eq("studio", f.studio).eq("model_version", f.model).maybeSingle();
  if (have) return have.id as number;
  const { data, error } = await sb.from("forecast_runs").insert({
    fy: f.fy, month, studio: f.studio, model_version: f.model, manual_outlook: f.manual.outlook, expected_billing: f.total.expected, low: f.total.low, high: f.total.high,
    billed_ytd: f.manual.billed_ytd, cash_by_fy_end: f.cash.total, cash_low: f.cash.low, cash_high: f.cash.high, by_month: f.byMonth, params: { default_days: f.cash.default_days }, run_by: by,
  }).select("id").single();
  if (error) throw new Error(error.message);
  const rows = f.items.map((it) => ({ run_id: data.id, project_number: it.project_number, studio: it.studio, seq: it.seq, client_name: it.client_name, stage: it.stage?.slice(0, 300) ?? null, fee: Math.round(it.fee), probability: Number(it.p.toFixed(4)), expected_month: it.month ? `${it.month}-01` : null, expected_cash_month: it.cash_month ? `${it.cash_month}-01` : null, basis: it.basis }));
  for (let i = 0; i < rows.length; i += 500) { const r = await sb.from("forecast_items").insert(rows.slice(i, i + 500)); if (r.error) throw new Error(r.error.message); }
  return data.id as number;
}

// Forecast made at the start of each past month vs what the tracker shows as billed in that month.
export async function backtest(sb: Db, studio: string | null) {
  const { data: runs } = await sb.from("forecast_runs").select("month,by_month").eq("studio", studio ?? "All").eq("model_version", MODEL).order("month", { ascending: false }).limit(6);
  const out: { month: string; forecast: number; actual: number | null }[] = [];
  const thisMonth = IST().slice(0, 7);
  for (const r of runs ?? []) {
    const m = String(r.month).slice(0, 7);
    const f = ((r.by_month as { month: string; billing: number }[]) ?? []).find((x) => x.month === m)?.billing ?? 0;
    if (m >= thisMonth) { out.push({ month: m, forecast: f, actual: null }); continue; }
    let q = sb.from("billing_stages").select("fee").gte("billed_on", `${m}-01`).lt("billed_on", `${addMonths(m, 1)}-01`);
    if (studio) q = q.eq("studio", studio);
    const { data } = await q.limit(1000);
    out.push({ month: m, forecast: f, actual: (data ?? []).reduce((a, x) => a + Number(x.fee ?? 0), 0) });
  }
  return out;
}

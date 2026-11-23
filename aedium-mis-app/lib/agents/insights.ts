// Insights = rules + LLM.
// 1) Rules read the dashboard data and emit findings: structured facts with severity, numbers and a next step.
//    Each finding carries a plain rule-generated sentence, used as-is when no LLM is available.
// 2) An LLM turns the findings (and nothing else) into the narrative shown on the screens.
//    Output is cached in Supabase per findings hash, so polling never re-generates unchanged text.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Dash } from "../data";
import { inr, monthLabel } from "../format";
import { serviceDb, sha256 } from "./keys";
import { RULES } from "./agents";

export type Tab = "brief" | "cash" | "agents" | "ask" | "studios" | "connect";
export type Finding = {
  id: string; area: "receivables" | "billing" | "contracts" | "workflow" | "data" | "studios";
  severity: 1 | 2 | 3;            // 3 = act today
  fact: string;                    // rule-generated sentence (fallback text)
  metrics: Record<string, string | number | null>;
  action: { label: string; tab: Tab };
};

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function findings(d: Dash): Finding[] {
  const f: Finding[] = [];
  const k = d.kpi, month = d.period?.custom ? d.period.label : monthLabel(d.reportMonth), prev = d.period?.custom ? d.period.prevLabel : monthLabel(d.prevMonth);
  const src = d.zohoIsSample ? " (Zoho sample data)" : "";

  if (k.outstanding > 0) {
    const share = pct(k.late, k.outstanding);
    f.push({ id: "late_share", area: "receivables", severity: share >= 50 ? 3 : share >= 25 ? 2 : 1,
      fact: `${inr(k.late)} of ${inr(k.outstanding)} outstanding is past due (${share}%)${src}.`,
      metrics: { late: k.late, outstanding: k.outstanding, late_pct: share, open_invoices: k.openCount, zoho_sample: d.zohoIsSample ? 1 : 0 },
      action: { label: "Open ageing", tab: "cash" } });
  }
  if (d.old.length) {
    const total = d.old.reduce((s, i) => s + i.balance, 0);
    const projects = [...new Set(d.old.map((i) => i.project_name ?? i.customer_name ?? "?"))];
    const top = [...d.old].sort((a, b) => b.balance - a.balance)[0];
    f.push({ id: "over_90", area: "receivables", severity: 3,
      fact: `${d.old.length} invoice(s) over 90 days total ${inr(total)}, on ${projects.join(", ")}; oldest ${d.old[0].days_overdue} days, largest ${top.invoice_number} at ${inr(top.balance)}.`,
      metrics: { count: d.old.length, total, oldest_days: d.old[0].days_overdue, oldest_invoice: d.old[0].invoice_number, largest_invoice: top.invoice_number, largest_balance: top.balance, projects: projects.join(", "), share_of_late_pct: pct(total, k.late) },
      action: { label: "Review reminders", tab: "agents" } });
  }
  {
    const change = k.billedPrevMonth ? Math.round(((k.billedMonth - k.billedPrevMonth) / k.billedPrevMonth) * 100) : null;
    f.push({ id: "billing_month", area: "billing", severity: change != null && change <= -25 ? 2 : 1,
      fact: `Billed ${inr(k.billedMonth)} in ${month}${change != null ? ` against ${inr(k.billedPrevMonth)} in ${prev} (${change >= 0 ? "+" : ""}${change}%)` : ""}, from the master tracker.`,
      metrics: { month, billed: k.billedMonth, prev_month: prev, billed_prev: k.billedPrevMonth, change_pct: change },
      action: { label: "Open stage-to-cash", tab: "cash" } });
  }
  f.push({ id: "yet_to_bill", area: "billing", severity: 1,
    fact: `${inr(k.yetToBill)} is still to bill across ${k.activeLines} active project lines; ${inr(k.designYtb)} of it is design value.`,
    metrics: { yet_to_bill: k.yetToBill, active_lines: k.activeLines, design_value_left: k.designYtb, contract_value: k.contract },
    action: { label: "Open studios", tab: "studios" } });

  const it = d.queues.invoice_trigger;
  if (it.length) {
    const value = it.reduce((s, x) => s + (x.fee ?? 0), 0);
    f.push({ id: "uninvoiced_stages", area: "workflow", severity: value >= 1e6 ? 3 : 2,
      fact: `${it.length} completed stage(s) worth ${inr(value)} have no invoice yet; largest is ${it[0].label} (${it[0].studio}) at ${inr(it[0].fee)}.`,
      metrics: { count: it.length, value, top_client: it[0].label, top_studio: it[0].studio, top_fee: it[0].fee },
      action: { label: "Send to Finance", tab: "agents" } });
  }
  if (d.agents.notifiedCount) {
    f.push({ id: "finance_waiting", area: "workflow", severity: d.agents.oldestNotifiedDays > 7 ? 3 : 2,
      fact: `Finance was notified of ${d.agents.notifiedCount} stage(s) with no invoice yet; the oldest has waited ${d.agents.oldestNotifiedDays} days.`,
      metrics: { count: d.agents.notifiedCount, oldest_days: d.agents.oldestNotifiedDays },
      action: { label: "Open stage-to-cash", tab: "cash" } });
  }
  const cw = d.queues.contract_watch;
  if (cw.length) {
    const lapsed = cw.filter((l) => l.days < 0), first = cw[0];
    f.push({ id: "contracts", area: "contracts", severity: lapsed.length ? 3 : 2,
      fact: `${cw.length} contract(s) with billing left end within 60 days or lapsed in the last 6 months (${lapsed.length} lapsed); first is ${first.client_name ?? first.project_number} (${first.studio}), ${first.days < 0 ? `lapsed ${-first.days} days ago` : first.days === 0 ? "ending today" : `ending in ${first.days} days`}, ${inr(first.yet_to_bill_amount)} to bill.`,
      metrics: { count: cw.length, lapsed: lapsed.length, first_client: first.client_name, first_studio: first.studio, first_days: first.days, first_to_bill: first.yet_to_bill_amount, first_end: first.end_date },
      action: { label: "Open contract watch", tab: "agents" } });
  }
  const top = d.studios[0];
  if (top) {
    f.push({ id: "studio_mix", area: "studios", severity: 1,
      fact: `${top.studio} holds ${pct(top.tcv, d.studios.reduce((s, x) => s + x.tcv, 0))}% of active contract value (${inr(top.tcv)}); ${d.studios.length} studios have active lines.`,
      metrics: { top_studio: top.studio, top_tcv: top.tcv, studios: d.studios.length, top_revenue_month: top.revenue },
      action: { label: "Open studios", tab: "studios" } });
  }
  f.push({ id: "payroll_gap", area: "data", severity: 2,
    fact: `No studio payroll or timesheet data is loaded, so studio multipliers cannot be computed; ${d.staffCount} staff are listed in the tracker.`,
    metrics: { staff_listed: d.staffCount, payroll_loaded: 0 },
    action: { label: "Open studios", tab: "studios" } });
  const flags = (d.lastRun?.issues?.length ?? 0);
  if (d.mismatches || flags || d.zohoIsSample) {
    f.push({ id: "data_quality", area: "data", severity: d.mismatches > 50 ? 2 : 1,
      fact: `${d.mismatches} project line(s) disagree between the Summary and Billing Stages sheets, ${flags} tracker check(s) are flagged${d.zohoIsSample ? ", and Zoho Books figures are sample data" : ""}.`,
      metrics: { summary_vs_stage_mismatches: d.mismatches, tracker_flags: flags, zoho_sample: d.zohoIsSample ? 1 : 0 },
      action: { label: "Open brief", tab: "brief" } });
  }
  return f.sort((a, b) => b.severity - a.severity);
}

// ---------- LLM narrative ----------
const Narrative = z.object({
  brief_lead: z.string().describe("1-2 sentences: the single most important thing today, with its figures"),
  brief_body: z.string().describe("2-3 sentences: billing and pipeline context, and any data caveat that matters"),
  decisions: z.array(z.object({
    finding_id: z.string(), tag: z.string().describe("1-2 words, e.g. Collections, Contract, Data gap"),
    meta: z.string().describe("very short, e.g. '226 days' or a date"), title: z.string().describe("imperative, under 60 characters"),
    body: z.string().describe("1-2 sentences with the figures that justify it"),
  })).describe("exactly 3, highest priority first, each tied to a finding id"),
  collections_note: z.string().describe("2 sentences for the Collections card on the Cash screen"),
  studios_note: z.string().describe("1-2 sentences on what the studio figures can and cannot say yet"),
  ask_starter: z.string().describe("2-3 sentence answer to 'Which invoices are more than 90 days overdue?'"),
});
export type NarrativeT = z.infer<typeof Narrative>;

export function ruleNarrative(fs: Finding[]): NarrativeT {
  const by = (id: string) => fs.find((x) => x.id === id);
  const picked: Finding[] = [];
  for (const x of fs) if (picked.length < 3 && !picked.some((p) => p.area === x.area)) picked.push(x);
  for (const x of fs) if (picked.length < 3 && !picked.includes(x)) picked.push(x);
  return {
    brief_lead: fs[0]?.fact ?? "No findings yet.",
    brief_body: [by("billing_month"), by("yet_to_bill"), by("data_quality")].filter(Boolean).map((x) => x!.fact).join(" "),
    decisions: picked.map((x) => ({ finding_id: x.id, tag: x.area[0].toUpperCase() + x.area.slice(1), meta: `Priority ${x.severity}`, title: x.action.label, body: x.fact })),
    collections_note: [by("finance_waiting"), by("over_90")].filter(Boolean).map((x) => x!.fact).join(" ") || "Nothing is waiting on Collections.",
    studios_note: by("payroll_gap")?.fact ?? "",
    ask_starter: by("over_90")?.fact ?? "No invoices are more than 90 days overdue.",
  };
}

const MODEL = process.env.INSIGHTS_MODEL || process.env.ASK_MODEL || "claude-opus-5-5";

export async function narrate(fs: Finding[], studio: string | null): Promise<{ narrative: NarrativeT; source: "llm" | "rules"; generated_at: string | null; note?: string }> {
  const rules = ruleNarrative(fs);
  if (!process.env.ANTHROPIC_API_KEY) return { narrative: rules, source: "rules", generated_at: null, note: "No ANTHROPIC_API_KEY: showing rule text." };
  const hash = await sha256(JSON.stringify({ studio, fs: fs.map(({ id, metrics, severity }) => ({ id, metrics, severity })) }));
  const db = serviceDb();
  const cached = await db.from("insights").select("narrative,created_at").eq("findings_hash", hash).maybeSingle();
  if (cached.data) return { narrative: cached.data.narrative as NarrativeT, source: "llm", generated_at: cached.data.created_at };

  try {
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: MODEL, max_tokens: 4000, output_config: { effort: "low", format: zodOutputFormat(Narrative) },
      system: `You write the narrative text for Aedium Design's MIS dashboard. You receive findings computed by rules from the master tracker and Zoho Books. Write only from those findings: every number you use must appear in a finding's fact or metrics. Do not add advice the findings do not support.\n${RULES}\nPlain sentences, no markdown.`,
      messages: [{ role: "user", content: `Studio filter: ${studio ?? "all studios"}.\nFindings, highest severity first (JSON):\n${JSON.stringify(fs)}` }],
    });
    const out = res.parsed_output;
    if (!out || res.stop_reason === "refusal") return { narrative: rules, source: "rules", generated_at: null, note: "The model returned no usable text." };
    // Decisions must point at real findings; drop any that do not.
    out.decisions = out.decisions.filter((x) => fs.some((y) => y.id === x.finding_id)).slice(0, 3);
    if (out.decisions.length < 3) out.decisions.push(...rules.decisions.filter((r) => !out.decisions.some((x) => x.finding_id === r.finding_id)).slice(0, 3 - out.decisions.length));
    const created_at = new Date().toISOString();
    await db.from("insights").upsert({ findings_hash: hash, studio, narrative: out, model: MODEL, created_at });
    return { narrative: out, source: "llm", generated_at: created_at };
  } catch (e) {
    return { narrative: rules, source: "rules", generated_at: null, note: e instanceof Error ? e.message : String(e) };
  }
}

// The Aedium tool set: one definition, used by the in-app Ask tab (Claude API) and the MCP server
// (any MCP client: Claude, ChatGPT, Gemini, Cursor...). Inputs are zod schemas; JSON Schema is derived from them.
import { z } from "zod";
import type { Db } from "../supabase/server";
import { loadDashboard } from "../data";
import { recordStageEvent, recordDecision, draftEmail, type Actor } from "./actions";
import { AGENTS, RULES } from "./agents";
import { findings } from "./insights";
import { can, type Action, type Role } from "../rbac";
import { PoInput, stagePo, listPos, getPo, reviewPo, excelRows } from "../po";
import { fyPlan, escalations, projection, addProjection } from "../plan";
import { financeQueue, raiseInvoice, recordPayment } from "../finance";

export type ToolCtx = { sb: Db; actor: Actor };
export type Scope = "read" | "act";
type Def<S extends z.ZodRawShape> = {
  name: string; title: string; description: string; scope: Scope; input: S;
  need?: Action[];                // visible to roles holding any of these (default: data.read)
  run: (ctx: ToolCtx, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
};
const tool = <S extends z.ZodRawShape>(d: Def<S>) => d;
// A project director's key or session is locked to their studio.
const scoped = (actor: Actor, s?: string | null) => (actor.role === "project_manager" && actor.studio ? actor.studio : s ?? null);

// Same "active" rule as the dashboard (lib/data.ts isActive).
const ACTIVE = `status.in.("In progress","Not started","On hold"),and(status.is.null,yet_to_bill_amount.gt.0)`;
const LINE_COLS = "row_no,project_number,client_name,project_name,studio,status,project_stage,start_date,end_date,escalation_clause,split_value,billed_amount,yet_to_bill_amount,design_value,construction_value,spoc";
const clean = (s: unknown) => String(s ?? "").replace(/[%,()*\\]/g, " ").trim().slice(0, 80);
const studio = z.string().optional().describe("Studio name as in the tracker, e.g. 'Arch - Com', 'MEPF', 'Landscape'");
const agent = z.enum(["collections", "invoice_trigger", "contract_watch"]);
const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

export const TOOLS = [
  tool({
    name: "get_agent", title: "Load an agent's instructions", scope: "read",
    description: "Instructions for one Aedium agent (analyst, po_intake, collections, invoice_trigger, contract_watch, finance, planner). Call this when the person asks to run an agent, then follow the instructions. Works in clients that do not support MCP prompts.",
    input: { name: z.enum(["analyst", "po_intake", "collections", "invoice_trigger", "contract_watch", "finance", "planner"]) },
    run: async (_ctx, { name }) => { const a = AGENTS.find((x) => x.name === name)!; return { ...a, rules: RULES }; },
  }),
  tool({
    name: "search", title: "Search", scope: "read",
    description: "Search Aedium projects and invoices by text. Returns ids for fetch. (Search/fetch pair for clients such as ChatGPT deep research.)",
    input: { query: z.string() },
    run: async ({ sb }, { query }) => {
      const s = clean(query);
      const [p, i] = await Promise.all([
        sb.from("project_lines").select("row_no,project_number,client_name,project_name,studio,status").or(`client_name.ilike.%${s}%,project_name.ilike.%${s}%,project_number.ilike.%${s}%,studio.ilike.%${s}%`).limit(15),
        sb.from("v_open_invoices").select("invoice_number,customer_name,project_name,balance").or(`invoice_number.ilike.%${s}%,customer_name.ilike.%${s}%,project_name.ilike.%${s}%`).limit(10),
      ]);
      fail(p.error); fail(i.error);
      return { results: [
        ...(p.data ?? []).map((r) => ({ id: `project:${r.row_no}`, title: `${r.project_number} · ${r.client_name ?? ""} · ${r.studio ?? ""}`, text: `${r.project_name ?? ""} (${r.status ?? "no status"})` })),
        ...(i.data ?? []).map((r) => ({ id: `invoice:${r.invoice_number}`, title: `${r.invoice_number} · ${r.customer_name ?? ""}`, text: `${r.project_name ?? ""}, balance ${r.balance}` })),
      ] };
    },
  }),
  tool({
    name: "fetch", title: "Fetch", scope: "read",
    description: "Full record for an id returned by search: project:<summary row> or invoice:<invoice number>.",
    input: { id: z.string() },
    run: async ({ sb }, { id }) => {
      const [kind, ref] = [id.split(":")[0], id.slice(id.indexOf(":") + 1)];
      if (kind === "project") {
        const { data, error } = await sb.from("project_lines").select("*").eq("row_no", Number(ref)).maybeSingle(); fail(error);
        if (!data) throw new Error(`No project ${ref}`);
        const st = await sb.from("v_stages").select("seq,stage,pct,fee,billed_on,workflow_status").eq("project_number", data.project_number).eq("studio", data.studio).order("seq");
        return { id, title: `${data.project_number} · ${data.client_name} · ${data.studio}`, text: JSON.stringify({ ...data, stages: st.data ?? [] }), metadata: { source: "master tracker" } };
      }
      if (kind === "invoice") {
        const { data, error } = await sb.from("v_open_invoices").select("*").eq("invoice_number", ref).maybeSingle(); fail(error);
        if (!data) throw new Error(`No open invoice ${ref}`);
        return { id, title: `${data.invoice_number} · ${data.customer_name}`, text: JSON.stringify(data), metadata: { source: "Zoho Books" } };
      }
      throw new Error("Use an id from search: project:<n> or invoice:<number>.");
    },
  }),
  tool({
    name: "get_summary", title: "Dashboard summary", scope: "read",
    description: "Headline figures shown on the Aedium dashboard: contract value of active lines, billed in the report month, collected, outstanding, late, yet to bill, the stage pipeline counts, studios by contract value, and data-quality flags. Start here.",
    input: { studio },
    run: async ({ sb, actor }, { studio }) => {
      const d = await loadDashboard(sb, scoped(actor, studio));
      return {
        studio: d.studio ?? "All studios", today: d.today, report_month: d.reportMonth, kpi: d.kpi,
        pipeline: d.pipeline.map((p) => ({ status: p.status, count: p.count, value: p.value })),
        receivables_by_bucket: ["0-15", "16-30", "31-45", "46-90", "90+"].map((b) => ({ bucket: b, balance: d.open.filter((i) => i.bucket === b).reduce((s, i) => s + i.balance, 0) })),
        studios: d.studios.slice(0, 15), agent_queue_sizes: Object.fromEntries(Object.entries(d.queues).map(([k, v]) => [k, v.length])),
        data_confidence: { zoho_books: d.zohoIsSample ? "sample data" : "live", summary_vs_stage_mismatches: d.mismatches, tracker_checks_flagged: d.lastRun?.issues?.length ?? 0, last_import: d.lastRun?.finished_at ?? null },
      };
    },
  }),
  tool({
    name: "get_insights", title: "Rule findings", scope: "read",
    description: "Findings the Aedium rules engine computed from the data, highest severity first: id, area, severity (3 = act today), a plain fact sentence, the metrics behind it and the suggested next step. Use these to write a brief or decide what to do first.",
    input: { studio },
    run: async ({ sb, actor }, { studio }) => findings(await loadDashboard(sb, scoped(actor, studio))),
  }),
  tool({
    name: "order_book", title: "Order book", scope: "read",
    description: "Contract value, billed and yet-to-bill from the master tracker, grouped by studio, status, financial_year or client_name. scope 'active' (default) = status In progress, Not started or On hold, or no status but amount left to bill.",
    input: { group_by: z.enum(["studio", "status", "financial_year", "client_name"]), scope: z.enum(["active", "all"]).optional() },
    run: async ({ sb }, { group_by, scope }) => {
      let q = sb.from("project_lines").select(`${group_by},split_value,billed_amount,yet_to_bill_amount`).limit(5000);
      if (scope !== "all") q = q.or(ACTIVE);
      const { data, error } = await q; fail(error);
      const m = new Map<string, { group: string; lines: number; contract: number; billed: number; yet_to_bill: number }>();
      for (const r of (data ?? []) as unknown as Record<string, string | number | null>[]) {
        const k = String(r[group_by] ?? "Unassigned"); const g = m.get(k) ?? { group: k, lines: 0, contract: 0, billed: 0, yet_to_bill: 0 };
        g.lines++; g.contract += Number(r.split_value) || 0; g.billed += Number(r.billed_amount) || 0; g.yet_to_bill += Number(r.yet_to_bill_amount) || 0; m.set(k, g);
      }
      return [...m.values()].sort((a, b) => b.contract - a.contract).slice(0, 40);
    },
  }),
  tool({
    name: "find_projects", title: "Find projects", scope: "read",
    description: "Project lines (one per project x studio): project number, client, studio, status, stage, contract dates, contract value, billed and yet to bill. Filter by text (client, project name or number), studio or status. Sorted by contract value.",
    input: { search: z.string().optional(), studio, status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    run: async ({ sb }, { search, studio, status, limit }) => {
      let q = sb.from("project_lines").select(LINE_COLS).limit(limit ?? 20).order("split_value", { ascending: false, nullsFirst: false });
      const s = clean(search); if (s) q = q.or(`client_name.ilike.%${s}%,project_name.ilike.%${s}%,project_number.ilike.%${s}%`);
      if (studio) q = q.ilike("studio", `%${clean(studio)}%`);
      if (status) q = q.ilike("status", `%${clean(status)}%`);
      const { data, error } = await q; fail(error); return data;
    },
  }),
  tool({
    name: "project_stages", title: "Billing stages of a project", scope: "read",
    description: "Billing stages for one project number: seq, stage text, %, fee, billed date and workflow status (pending, in_progress, complete, client_approved, finance_notified, billed). The (project_number, studio, seq) triple identifies a stage for mark_stage.",
    input: { project_number: z.string(), studio },
    run: async ({ sb }, { project_number, studio }) => {
      let q = sb.from("v_stages").select("id,studio,seq,stage,pct,fee,billed_on,workflow_status,last_event,last_event_at").eq("project_number", clean(project_number).toUpperCase().replace(/\s/g, "")).order("studio").order("seq").limit(200);
      if (studio) q = q.ilike("studio", `%${clean(studio)}%`);
      const { data, error } = await q; fail(error); return data;
    },
  }),
  tool({
    name: "billing_by_month", title: "Billing by month", scope: "read",
    description: "Amount billed per month from the Billing Stages billed dates, optionally for one studio. Months are YYYY-MM.",
    input: { from_month: z.string().regex(/^\d{4}-\d{2}$/), to_month: z.string().regex(/^\d{4}-\d{2}$/), studio },
    run: async ({ sb }, { from_month, to_month, studio }) => {
      const end = new Date(Date.UTC(Number(to_month.slice(0, 4)), Number(to_month.slice(5, 7)), 0)).toISOString().slice(0, 10);
      let q = sb.from("billing_stages").select("billed_on,fee").gte("billed_on", `${from_month}-01`).lte("billed_on", end).limit(5000);
      if (studio) q = q.ilike("studio", `%${clean(studio)}%`);
      const { data, error } = await q; fail(error);
      const m = new Map<string, number>(); for (const r of data ?? []) { const k = String(r.billed_on).slice(0, 7); m.set(k, (m.get(k) ?? 0) + (Number(r.fee) || 0)); }
      return [...m.entries()].sort().map(([month, billed]) => ({ month, billed }));
    },
  }),
  tool({
    name: "open_invoices", title: "Open invoices", scope: "read",
    description: "Unpaid invoices from Zoho Books with balance, due date, days overdue and ageing bucket (0-15, 16-30, 31-45, 46-90, 90+).",
    input: { min_days_overdue: z.number().int().min(0).optional() },
    run: async ({ sb }, { min_days_overdue }) => {
      const { data, error } = await sb.from("v_open_invoices").select("invoice_number,customer_name,project_name,project_number,studio,date,due_date,total,balance,days_overdue,bucket").gte("days_overdue", min_days_overdue ?? 0).order("days_overdue", { ascending: false }).limit(100);
      fail(error); return data;
    },
  }),
  tool({
    name: "payments", title: "Payments received", scope: "read",
    description: "Payments received in Zoho Books between two dates (YYYY-MM-DD): amount received and TDS withheld.",
    input: { from: z.string(), to: z.string() },
    run: async ({ sb }, { from, to }) => {
      const { data, error } = await sb.from("zoho_payments").select("payment_number,customer_id,date,amount,tax_amount_withheld,invoices").gte("date", clean(from)).lte("date", clean(to)).order("date").limit(200);
      fail(error); return data;
    },
  }),
  tool({
    name: "contracts_ending", title: "Contracts ending", scope: "read",
    description: "Active project lines whose contract end date is within the next N days or already passed, with amount still to bill.",
    input: { within_days: z.number().int().min(1).max(730) },
    run: async ({ sb }, { within_days }) => {
      const until = new Date(Date.now() + within_days * 86400000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await sb.from("project_lines").select(LINE_COLS).or(ACTIVE).gt("yet_to_bill_amount", 0).lte("end_date", until).order("end_date").limit(50);
      fail(error); return (data ?? []).map((r) => ({ ...r, lapsed: (r.end_date ?? "") < today }));
    },
  }),
  tool({
    name: "agent_queue", title: "Agent queue", scope: "read",
    description: "Items an agent has found that need a human decision. collections: overdue invoices (ref = invoice number). invoice_trigger: completed stages with no invoice (ref = stage id). contract_watch: contracts ending within 60 days or lapsed in the last 6 months with billing left (ref = Summary row number). Items already approved or dismissed are left out.",
    input: { agent, limit: z.number().int().min(1).max(50).optional() },
    run: async ({ sb }, { agent, limit }) => {
      const d = await loadDashboard(sb);
      const n = limit ?? 10;
      if (agent === "collections") return d.queues.collections.slice(0, n).map((i) => ({ ref: i.invoice_number, project: i.project_name ?? i.customer_name, balance: i.balance, days_overdue: i.days_overdue, due_date: i.due_date }));
      if (agent === "invoice_trigger") return d.queues.invoice_trigger.slice(0, n).map((s) => ({ ref: String(s.id), project_number: s.project_number, client: s.label, studio: s.studio, seq: s.seq, stage: s.stage, fee: s.fee, status: s.workflow_status }));
      return d.queues.contract_watch.slice(0, n).map((l) => ({ ref: String(l.row_no), project_number: l.project_number, client: l.client_name, studio: l.studio, end_date: l.end_date, days_to_end: l.days, yet_to_bill: l.yet_to_bill_amount, escalation_clause: l.escalation_clause }));
    },
  }),
  tool({
    name: "draft_email", title: "Draft an email", scope: "read",
    description: "Draft the email an agent proposes for one queue item: a payment reminder (collections), an invoice request to Finance (invoice_trigger) or a contract extension (contract_watch). Returns to/subject/body text only; nothing is sent.",
    input: { agent, ref: z.string() },
    run: async ({ sb }, { agent, ref }) => draftEmail(sb, agent, ref),
  }),
  tool({
    name: "mark_stage", title: "Record a stage step", scope: "act", need: ["stage.complete", "stage.approve", "stage.notify_finance"],
    description: "Record a workflow step on one billing stage: complete, client_approved, finance_notified, or reopened. Identify the stage with project_number, studio and seq from project_stages. Shows on the dashboard at once and is logged with the key's name.",
    input: { project_number: z.string(), studio: z.string().nullable(), seq: z.number().int().min(1), event: z.enum(["complete", "client_approved", "finance_notified", "reopened"]), note: z.string().max(500).optional() },
    run: async ({ sb, actor }, { project_number, studio, seq, event, note }) => recordStageEvent(sb, actor, { project_number: project_number.toUpperCase().replace(/\s/g, ""), studio, seq }, event, note),
  }),
  tool({
    name: "decide_agent_item", title: "Approve or dismiss an agent item", scope: "act", need: ["agent.collections", "agent.invoice_trigger", "agent.contract_watch"],
    description: "Approve or dismiss an item from agent_queue. Approving an invoice_trigger item also records 'finance notified' on that stage. Approving collections or contract_watch does not send email; use draft_email for the text.",
    input: { agent, ref: z.string(), decision: z.enum(["approved", "dismissed"]), note: z.string().max(500).optional() },
    run: async ({ sb, actor }, { agent, ref, decision, note }) => recordDecision(sb, actor, agent, ref, decision, note),
  }),

  // ---------- PO intake: the assistant reads the PO (Outlook, folder, attachment) with its own connectors ----------
  tool({
    name: "get_po_schema", title: "How to extract a PO", scope: "read", need: ["po.stage"],
    description: "Call before stage_po. Returns the fields to extract from a client PO / work order, the studio names used in the tracker, the checks that will run, and examples. Read the PO with your own Outlook, file or attachment access first.",
    input: {},
    run: async ({ sb }) => {
      const { data } = await sb.from("project_lines").select("studio").not("studio", "is", null).limit(3000);
      return {
        studios: [...new Set((data ?? []).map((r) => r.studio))].sort(),
        fields: z.toJSONSchema(z.object(PoInput)),
        rules: [
          "Values in INR excluding GST. Percentages as 0-1 (10% = 0.1).",
          "One line per studio / vertical in the fee split; stages per studio. Combined POs have several lines, separate POs one.",
          "Stage % must add to 100% per studio, fees to the studio value, studio values to the PO total.",
          "Copy stage text as printed. Mark construction-period fees is_construction=true with the number of monthly instalments.",
          "Do not guess: leave a field out and say so in notes. Give confidence 0-1.",
          "An existing PO number is staged as an amendment and compared with the approved version. Additional area or rework normally comes with its own project number.",
        ],
      };
    },
  }),
  tool({
    name: "stage_po", title: "Stage an extracted PO for review", scope: "act", need: ["po.stage"],
    description: "Submit the fields you extracted from a PO. The server checks the numbers (split vs total, stage % = 100%, fees vs %), detects amendments of an existing PO number and returns the check results. Nothing reaches the tracker until a reviewer approves it.",
    input: PoInput,
    run: async ({ sb, actor }, input) => stagePo(sb, actor, input),
  }),
  tool({
    name: "list_pos", title: "List staged and approved POs", scope: "read",
    description: "POs submitted for review or already approved/rejected, newest first, with check results and amendment differences.",
    input: { status: z.enum(["pending_review", "approved", "rejected"]).optional() },
    run: async ({ sb }, { status }) => listPos(sb, status),
  }),
  tool({
    name: "get_po", title: "One PO with lines and stages", scope: "read",
    description: "Header, studio lines and stages of one staged or approved PO (po_id from list_pos or stage_po).",
    input: { po_id: z.number().int() },
    run: async ({ sb }, { po_id }) => getPo(sb, po_id),
  }),
  tool({
    name: "review_po", title: "Approve or reject a staged PO", scope: "act", need: ["po.review"],
    description: "Approve merges the PO into the tracker (new project lines and billing stages, or updates for an amendment). Needs the internal project number. If checks failed, a note explaining why it is still correct is required. Only call after the person confirms.",
    input: { po_id: z.number().int(), decision: z.enum(["approved", "rejected"]), project_number: z.string().optional(), note: z.string().max(500).optional() },
    run: async ({ sb, actor }, { po_id, decision, project_number, note }) => reviewPo(sb, actor, po_id, decision, note, project_number),
  }),
  tool({
    name: "tracker_rows_for_excel", title: "Rows for the master tracker workbook", scope: "read",
    description: "For an approved PO: the Summary and Billing Stages rows in the master tracker's column order, to append to the Excel workbook (use your own file or OneDrive access).",
    input: { po_id: z.number().int() },
    run: async ({ sb }, { po_id }) => excelRows(sb, po_id),
  }),

  // ---------- plan ----------
  tool({
    name: "fy_plan", title: "FY target vs billable", scope: "read",
    description: "Current financial year (Apr-Mar): billed so far, design stages still billable, construction instalments falling before 31 March, total outlook vs target, by studio.",
    input: { studio },
    run: async ({ sb, actor }, { studio }) => fyPlan(sb, scoped(actor, studio)),
  }),
  tool({
    name: "escalations", title: "Escalation estimates", scope: "read",
    description: "Active lines past (or within 90 days of) their contract end with amount left to bill: escalation rate parsed from the clause, years past end and the estimated uplift. An estimate: confirm against the PO clause.",
    input: { studio },
    run: async ({ sb, actor }, { studio }) => escalations(sb, scoped(actor, studio)),
  }),
  tool({
    name: "monthly_projection", title: "Monthly projection", scope: "read",
    description: "Week-by-week forecast vs actual billing for a month (YYYY-MM), with carry-forward from last month, unplanned and new-project billing, and variance.",
    input: { month: z.string().regex(/^\d{4}-\d{2}$/), studio },
    run: async ({ sb, actor }, { month, studio }) => projection(sb, month, scoped(actor, studio)),
  }),
  tool({
    name: "add_projection", title: "Add a forecast row", scope: "act", need: ["plan.projection"],
    description: "Add a forecast line to a month's projection: week 1-5, amount, and either a stage (project_number, studio, stage_seq) or a free-text description.",
    input: { month: z.string().regex(/^\d{4}-\d{2}$/), week: z.number().int().min(1).max(5), amount: z.number().positive(), description: z.string().min(1), project_number: z.string().optional(), studio: z.string().optional(), stage_seq: z.number().int().optional() },
    run: async ({ sb, actor }, input) => addProjection(sb, actor, input),
  }),

  // ---------- finance (Zoho Books mirror until the real Zoho connection) ----------
  tool({
    name: "finance_queue", title: "Finance queue", scope: "read", need: ["finance.invoice", "agent.collections"],
    description: "Stages sent to Finance and waiting for an invoice, plus stages invoiced from the app, oldest first.",
    input: {},
    run: async ({ sb }) => financeQueue(sb),
  }),
  tool({
    name: "raise_invoice", title: "Raise an invoice", scope: "act", need: ["finance.invoice"],
    description: "Raise the invoice for a stage in the finance queue (stage id from finance_queue). Records it in Zoho Books (mirror) and marks the stage invoiced. Only after the person confirms number and amount.",
    input: { stage_id: z.number().int(), invoice_number: z.string().optional(), amount: z.number().positive().optional(), date: z.string().optional(), terms_days: z.number().int().optional() },
    run: async ({ sb, actor }, input) => raiseInvoice(sb, actor, input),
  }),
  tool({
    name: "record_payment", title: "Record a payment", scope: "act", need: ["finance.payment"],
    description: "Record a payment received against an invoice: amount received and TDS withheld. Reduces the invoice balance in Zoho Books (mirror).",
    input: { invoice_number: z.string(), amount: z.number().positive(), tds: z.number().min(0).optional(), date: z.string().optional(), reference: z.string().optional() },
    run: async ({ sb, actor }, input) => recordPayment(sb, actor, input),
  }),
] as const;

export type AnyTool = (typeof TOOLS)[number];
// Tools a key or session may use: its scope (read/act) and its role.
export const toolsFor = (scope: Scope, role: Role = "admin") => TOOLS.filter((t) => {
  if (scope === "read" && t.scope === "act") return false;
  const need = ("need" in t && t.need) ? t.need as Action[] : ["data.read" as Action];
  return need.some((a) => can(role, a));
});

// JSON Schema for clients that want plain schemas (the Claude API in the Ask tab).
export function jsonSchema(t: AnyTool) {
  const s = z.toJSONSchema(z.object(t.input as z.ZodRawShape)) as Record<string, unknown>;
  delete s.$schema;
  return s as { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export async function runTool(name: string, ctx: ToolCtx, raw: unknown) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown tool ${name}`);
  if (!toolsFor("act", ctx.actor.role).some((x) => x.name === name)) throw new Error(`Your role cannot use ${name}.`);
  const input = z.object(t.input as z.ZodRawShape).parse(raw ?? {});
  return (t.run as (c: ToolCtx, i: unknown) => Promise<unknown>)(ctx, input);
}

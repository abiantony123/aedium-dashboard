#!/usr/bin/env node
// Mock Zoho Books MCP server (READ-ONLY, synthetic data) for testing the Aedium agents
// before the real Zoho MCP is connected. Responses mimic the Zoho Books API v3 envelope
// ({ code: 0, message: "success", <resource>: [...], page_context }) so agent prompts
// written against this mock carry over to the real connector.
//
// Env vars:
//   MOCK_TODAY  "as of" date for overdue/ageing maths (default 2026-10-19, matching the designs)
//   MOCK_DATA   path to the seed file (default ./data/seed.json)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.MOCK_DATA || join(here, "data", "seed.json");
const TODAY = process.env.MOCK_TODAY || "2026-10-19";

const DAY = 86400000;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);

// Re-read on every call so the seed can be edited while Claude is connected.
function load() {
  const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const contacts = new Map(db.contacts.map((c) => [c.contact_id, c]));
  const sos = new Map(db.salesorders.map((s) => [s.salesorder_id, s]));
  const invoices = db.invoices.map((inv) => enrichInvoice(inv, contacts, sos));
  return { ...db, contacts, sos, invoices };
}

function enrichInvoice(inv, contacts, sos) {
  const so = sos.get(inv.salesorder_id);
  const daysOverdue = inv.balance > 0 ? Math.max(0, daysBetween(inv.due_date, TODAY)) : 0;
  let status = "sent";
  if (inv.balance === 0) status = "paid";
  else if (daysOverdue > 0) status = "overdue";
  else if (inv.balance < inv.total) status = "partially_paid";
  return {
    ...inv,
    customer_name: contacts.get(inv.customer_id)?.contact_name ?? null,
    salesorder_number: so?.salesorder_number ?? null,
    currency_code: "INR",
    status,
    days_overdue: daysOverdue,
    custom_fields: so
      ? [
          { label: "Project Number", value: so.project_number },
          { label: "Studio", value: so.studio },
        ]
      : [],
  };
}

function paginate(rows, page = 1, per_page = 200) {
  const start = (page - 1) * per_page;
  return {
    rows: rows.slice(start, start + per_page),
    page_context: { page, per_page, has_more_page: start + per_page < rows.length, total: rows.length },
  };
}

const ok = (key, payload, extra = {}) => ({
  content: [{ type: "text", text: JSON.stringify({ code: 0, message: "success", [key]: payload, ...extra }, null, 2) }],
});
const notFound = (what, id) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ code: 1002, message: `${what} '${id}' does not exist.` }) }],
});

const inRange = (d, start, end) => (!start || d >= start) && (!end || d <= end);
const has = (hay, needle) => !needle || String(hay ?? "").toLowerCase().includes(needle.toLowerCase());

const log = (tool, args) => console.error(`[zoho-mock] ${new Date().toISOString()} ${tool} ${JSON.stringify(args)}`);

const server = new McpServer({ name: "zoho-books-mock", version: "0.1.0" });
const RO = { readOnlyHint: true, openWorldHint: false };
const paging = {
  page: z.number().int().min(1).optional().describe("Page number, default 1"),
  per_page: z.number().int().min(1).max(200).optional().describe("Rows per page, default 200"),
};
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

server.registerTool(
  "get_organization",
  { title: "Get organization", description: "Zoho Books organization details (currency, fiscal year, data centre) and the mock's as-of date.", inputSchema: {}, annotations: RO },
  async () => {
    log("get_organization", {});
    return ok("organization", load().organization, { as_of_date: TODAY });
  }
);

server.registerTool(
  "list_contacts",
  {
    title: "List customers",
    description: "List customer contacts. Optional search_text matches name or company.",
    inputSchema: { search_text: z.string().optional(), ...paging },
    annotations: RO,
  },
  async (a) => {
    log("list_contacts", a);
    const rows = [...load().contacts.values()].filter((c) => has(c.contact_name, a.search_text) || has(c.company_name, a.search_text));
    const { rows: r, page_context } = paginate(rows, a.page, a.per_page);
    return ok("contacts", r, { page_context });
  }
);

server.registerTool(
  "get_contact",
  { title: "Get customer", description: "Get one customer contact by contact_id.", inputSchema: { contact_id: z.string() }, annotations: RO },
  async ({ contact_id }) => {
    log("get_contact", { contact_id });
    const c = load().contacts.get(contact_id);
    return c ? ok("contact", c) : notFound("Contact", contact_id);
  }
);

server.registerTool(
  "list_sales_orders",
  {
    title: "List sales orders",
    description:
      "List sales orders. Finance creates one SO per client PO / work order; reference_number holds the client PO number and project_number the internal Aedium project number.",
    inputSchema: {
      customer_id: z.string().optional(),
      reference_number: z.string().optional().describe("Client PO / work-order number (partial match)"),
      project_number: z.string().optional().describe("Aedium project number, e.g. R-2627-007 (partial match)"),
      status: z.enum(["open", "closed", "void"]).optional(),
      ...paging,
    },
    annotations: RO,
  },
  async (a) => {
    log("list_sales_orders", a);
    const db = load();
    const rows = [...db.sos.values()]
      .filter((s) => (!a.customer_id || s.customer_id === a.customer_id) && (!a.status || s.status === a.status))
      .filter((s) => has(s.reference_number, a.reference_number) && has(s.project_number, a.project_number))
      .map((s) => ({ ...s, customer_name: db.contacts.get(s.customer_id)?.contact_name ?? null }));
    const { rows: r, page_context } = paginate(rows, a.page, a.per_page);
    return ok("salesorders", r, { page_context });
  }
);

server.registerTool(
  "get_sales_order",
  { title: "Get sales order", description: "Get one sales order by salesorder_id, including its invoices.", inputSchema: { salesorder_id: z.string() }, annotations: RO },
  async ({ salesorder_id }) => {
    log("get_sales_order", { salesorder_id });
    const db = load();
    const s = db.sos.get(salesorder_id);
    if (!s) return notFound("Sales order", salesorder_id);
    const invoices = db.invoices
      .filter((i) => i.salesorder_id === salesorder_id)
      .map(({ invoice_id, invoice_number, date, total, balance, status }) => ({ invoice_id, invoice_number, date, total, balance, status }));
    return ok("salesorder", { ...s, customer_name: db.contacts.get(s.customer_id)?.contact_name ?? null, invoices });
  }
);

server.registerTool(
  "list_invoices",
  {
    title: "List invoices",
    description:
      "List invoices with filters. status 'unpaid' = any balance > 0. Dates are invoice dates (YYYY-MM-DD). Each invoice carries days_overdue and custom_fields (Project Number, Studio).",
    inputSchema: {
      status: z.enum(["sent", "overdue", "paid", "partially_paid", "unpaid"]).optional(),
      customer_id: z.string().optional(),
      salesorder_id: z.string().optional(),
      reference_number: z.string().optional().describe("Client PO number (partial match)"),
      search_text: z.string().optional().describe("Matches invoice number, customer name or line-item description"),
      date_start: dateStr.optional(),
      date_end: dateStr.optional(),
      ...paging,
    },
    annotations: RO,
  },
  async (a) => {
    log("list_invoices", a);
    const rows = load()
      .invoices.filter((i) => !a.status || (a.status === "unpaid" ? i.balance > 0 : i.status === a.status))
      .filter((i) => (!a.customer_id || i.customer_id === a.customer_id) && (!a.salesorder_id || i.salesorder_id === a.salesorder_id))
      .filter((i) => has(i.reference_number, a.reference_number) && inRange(i.date, a.date_start, a.date_end))
      .filter((i) => !a.search_text || has(i.invoice_number, a.search_text) || has(i.customer_name, a.search_text) || i.line_items.some((l) => has(l.description, a.search_text)))
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    const { rows: r, page_context } = paginate(rows, a.page, a.per_page);
    return ok("invoices", r, { page_context });
  }
);

server.registerTool(
  "get_invoice",
  { title: "Get invoice", description: "Get one invoice by invoice_id or invoice_number, with payments applied to it.", inputSchema: { invoice_id: z.string().describe("invoice_id (I-9002) or invoice_number (INV-CM-2611)") }, annotations: RO },
  async ({ invoice_id }) => {
    log("get_invoice", { invoice_id });
    const db = load();
    const inv = db.invoices.find((i) => i.invoice_id === invoice_id || i.invoice_number === invoice_id);
    if (!inv) return notFound("Invoice", invoice_id);
    const payments = db.customerpayments
      .flatMap((p) => p.invoices.filter((x) => x.invoice_id === inv.invoice_id).map((x) => ({ payment_id: p.payment_id, payment_number: p.payment_number, date: p.date, amount_applied: x.amount_applied, tax_amount_withheld: p.tax_amount_withheld })));
    return ok("invoice", { ...inv, payments });
  }
);

server.registerTool(
  "list_customer_payments",
  {
    title: "List customer payments",
    description: "List payments received. amount is cash received; tax_amount_withheld is TDS deducted by the client.",
    inputSchema: { customer_id: z.string().optional(), date_start: dateStr.optional(), date_end: dateStr.optional(), ...paging },
    annotations: RO,
  },
  async (a) => {
    log("list_customer_payments", a);
    const db = load();
    const rows = db.customerpayments
      .filter((p) => (!a.customer_id || p.customer_id === a.customer_id) && inRange(p.date, a.date_start, a.date_end))
      .map((p) => ({ ...p, customer_name: db.contacts.get(p.customer_id)?.contact_name ?? null }))
      .sort((x, y) => (x.date < y.date ? 1 : -1));
    const { rows: r, page_context } = paginate(rows, a.page, a.per_page);
    return ok("customerpayments", r, { page_context });
  }
);

server.registerTool(
  "get_receivables_aging",
  {
    title: "Receivables ageing report",
    description: "AR ageing summary as of the mock's as-of date: open balance by bucket (current, 1-15, 16-30, 31-45, 46-90, 90+ days overdue) with the invoices in each.",
    inputSchema: { customer_id: z.string().optional() },
    annotations: RO,
  },
  async (a) => {
    log("get_receivables_aging", a);
    const buckets = [
      ["current", (d) => d === 0],
      ["1-15", (d) => d >= 1 && d <= 15],
      ["16-30", (d) => d >= 16 && d <= 30],
      ["31-45", (d) => d >= 31 && d <= 45],
      ["46-90", (d) => d >= 46 && d <= 90],
      ["90+", (d) => d > 90],
    ];
    const open = load().invoices.filter((i) => i.balance > 0 && (!a.customer_id || i.customer_id === a.customer_id));
    const report = buckets.map(([name, test]) => {
      const inv = open.filter((i) => test(i.days_overdue));
      return {
        bucket: name,
        balance: inv.reduce((s, i) => s + i.balance, 0),
        count: inv.length,
        invoices: inv.map(({ invoice_number, customer_name, balance, days_overdue }) => ({ invoice_number, customer_name, balance, days_overdue })),
      };
    });
    const total = open.reduce((s, i) => s + i.balance, 0);
    const late = open.filter((i) => i.days_overdue > 0).reduce((s, i) => s + i.balance, 0);
    return ok("aging", report, { as_of_date: TODAY, total_outstanding: total, total_overdue: late, open_invoices: open.length });
  }
);

await server.connect(new StdioServerTransport());
console.error(`[zoho-mock] ready · data=${DATA_PATH} · as_of=${TODAY}`);

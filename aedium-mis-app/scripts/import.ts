// Loads the master tracker (and the Zoho Books mirror) into Supabase.
//   npm run import -- --dry-run                       parse and check only, writes nothing
//   npm run import                                    replace tracker + Zoho tables
//   npm run import -- --file "<xlsx>" --zoho "<json>" other sources
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local. Re-running is safe: tables are
// replaced, while workflow events and agent decisions entered in the app are kept.
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { readTracker } from "./tracker.ts";

config({ path: ".env.local" });
const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const DRY = process.argv.includes("--dry-run");
// Zoho tables are now written by the app (Finance raises invoices, records payments): only reload them on request.
const WITH_ZOHO = process.argv.includes("--with-zoho");
const FILE = arg("--file", "../Master Tracker_Projects (1).xlsx");
const ZOHO = arg("--zoho", "../zoho-books-mock-mcp/data/seed.json");

const started = new Date();
console.log(`Reading ${FILE}`);
const t = await readTracker(FILE);
const dedupe = <T,>(xs: T[], key: (x: T) => string) => { const m = new Map<string, T>(); for (const x of xs) if (!m.has(key(x))) m.set(key(x), x); return [...m.values()]; };
const subs = dedupe(t.subs, (s) => s.loa);
const staff = dedupe(t.staff, (s) => s.name.toLowerCase());
const zoho = JSON.parse(readFileSync(ZOHO, "utf8"));

// ---- checks (business rules BR03-BR05): reported, never fatal ----
const issues: string[] = [];
const byKey = new Map<string, typeof t.stages>();
for (const s of t.stages) { const k = `${s.project_number} | ${s.studio} | line ${s.sl_no ?? "?"}`; byKey.set(k, [...(byKey.get(k) ?? []), s]); }
for (const [k, ss] of byKey) {
  const pct = ss.reduce((a, s) => a + (s.pct ?? 0), 0);
  if (pct > 0 && Math.abs(pct - 1) > 0.01) issues.push(`Stage % for ${k} adds to ${(pct * 100).toFixed(1)}%`);
}
const today = new Date().toISOString().slice(0, 10);
const futureBilled = t.stages.filter((s) => s.billed_on && s.billed_on > today);
for (const s of futureBilled) issues.push(`Billed date in the future: ${s.project_number} | ${s.studio} stage ${s.seq} on ${s.billed_on}`);
const reportMonth = t.stages.map((s) => s.billed_on).filter((d): d is string => !!d && d <= today).sort().at(-1)?.slice(0, 7) + "-01";

const counts = {
  project_lines: t.lines.length, billing_stages: t.stages.length, sub_consultants: subs.length,
  sub_consultant_stages: t.subStages.length, staff: staff.length,
  zoho_contacts: zoho.contacts.length, zoho_sales_orders: zoho.salesorders.length,
  zoho_invoices: zoho.invoices.length, zoho_payments: zoho.customerpayments.length, issues: issues.length,
  zoho_source: ZOHO.includes("mock") ? "sample" : "zoho",
};
console.log("Parsed:", counts, "report month:", reportMonth);
if (issues.length) console.log(`Data checks (${issues.length}):\n  ` + issues.slice(0, 15).join("\n  ") + (issues.length > 15 ? `\n  ...and ${issues.length - 15} more` : ""));
if (DRY) { console.log("Dry run: nothing written."); process.exit(0); }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false }, db: { schema: "mis" } });

const { data: run } = await sb.from("import_runs").insert({ source: FILE, started_at: started.toISOString() }).select("id").single();
async function replace(table: string, rows: object[], idCol = "id", keepPo = false) {
  // Rows added from approved POs (origin = 'po') survive a re-import of the Excel.
  const del = keepPo ? await sb.from(table).delete().eq("origin", "excel") : await sb.from(table).delete().not(idCol, "is", null);
  if (del.error) throw new Error(`${table} clear: ${del.error.message}`);
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await sb.from(table).insert(rows.slice(i, i + 500));
    if (ins.error) throw new Error(`${table} insert: ${ins.error.message}`);
  }
  console.log(`  ${table}: ${rows.length}`);
}
try {
  // children first, so foreign keys hold
  if (WITH_ZOHO) {
  await replace("zoho_payments", [], "payment_id");
  await replace("zoho_invoices", [], "invoice_id");
  await replace("zoho_sales_orders", [], "salesorder_id");
  await replace("zoho_contacts", zoho.contacts.map((c: any) => ({ contact_id: c.contact_id, contact_name: c.contact_name, company_name: c.company_name, gst_no: c.gst_no, payment_terms: c.payment_terms, email: c.email })), "contact_id");
  await replace("zoho_sales_orders", zoho.salesorders.map(({ salesorder_id, salesorder_number, customer_id, reference_number, date, status, total, project_number, project_name, studio }: any) => ({ salesorder_id, salesorder_number, customer_id, reference_number, date, status, total, project_number, project_name, studio })), "salesorder_id");
  await replace("zoho_invoices", zoho.invoices.map(({ invoice_id, invoice_number, customer_id, salesorder_id, reference_number, date, due_date, total, balance, line_items }: any) => ({ invoice_id, invoice_number, customer_id, salesorder_id, reference_number, date, due_date, total, balance, line_items })), "invoice_id");
  await replace("zoho_payments", zoho.customerpayments.map(({ payment_id, payment_number, customer_id, date, payment_mode, amount, tax_amount_withheld, reference_number, invoices }: any) => ({ payment_id, payment_number, customer_id, date, payment_mode, amount, tax_amount_withheld, reference_number, invoices })), "payment_id");
  } else console.log("  zoho_*: kept (pass --with-zoho to reload the sample Zoho data)");

  await replace("project_lines", t.lines, "id", true);
  await replace("billing_stages", t.stages.map(({ workflow_status, billed_note, ...s }) => ({ ...s, source_status: workflow_status })), "id", true);
  await replace("sub_consultants", subs);
  await replace("sub_consultant_stages", t.subStages);
  await replace("staff", staff);
  await sb.from("import_runs").update({ finished_at: new Date().toISOString(), ok: true, counts, issues, report_month: reportMonth }).eq("id", run?.id);
  console.log("Import finished.");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  await sb.from("import_runs").update({ finished_at: new Date().toISOString(), ok: false, error: msg, counts }).eq("id", run?.id);
  console.error("Import failed:", msg);
  process.exit(1);
}

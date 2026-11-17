// End-to-end test (npm run e2e): runs against the local dev server (DEMO_MODE=1) and Supabase, then deletes everything it created.
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import ExcelJS from "exceljs";
config({ path: ".env.local" });

const BASE = "http://localhost:3005";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "mis" }, auth: { persistSession: false } });
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const started = new Date().toISOString();
const PN = "R-2627-999", PO = "TEST-PO-0001";
let pass = 0, failN = 0;
const ok = (label: string, cond: boolean, extra = "") => { cond ? pass++ : failN++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + String(extra).slice(0, 170) : ""}`); };
const keyIds: number[] = [];
async function mkKey(name: string, role: string, studio: string | null = null) {
  const key = "ak_live_" + Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const { data, error } = await db.from("api_keys").insert({ name, scope: "act", role, studio, prefix: key.slice(0, 12), key_hash: await sha(key), created_by: "e2e-test" }).select("id").single();
  if (error) throw error; keyIds.push(data.id); return key;
}
async function mcp(key: string) {
  const c = new Client({ name: "e2e", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  const text = r.content?.[0]?.text ?? "";
  let json: any = null; try { json = JSON.parse(text); } catch { /* error text */ }
  return { err: !!r.isError, text, json };
};
const cookie = async (role: string, studio = "") => `aedium_demo=${await sha("aedium-demo:open")}; aedium_role=${encodeURIComponent(encodeURIComponent(`${role}|${studio}`))}`;

const po = (over: Record<string, unknown> = {}) => ({
  po_number: PO, client_name: "E2E Test Client", project_name: "E2E Test Tower", project_number: PN, location: "Bangalore", project_type: "Commercial",
  po_date: "2026-11-10", start_date: "2026-11-15", end_date: "2027-11-14", contract_validity: "12 months", escalation_clause: "10% every year after the end date",
  total_value: 1500000, source: "attachment", source_ref: "e2e-test.pdf", confidence: 0.95,
  lines: [{ studio: "Arch - Com", split_value: 1000000 }, { studio: "MEPF", split_value: 500000 }],
  stages: [
    { studio: "Arch - Com", stage: "Upon confirmation of appointment", pct: 0.1 },
    { studio: "Arch - Com", stage: "Upon approval of concept design", pct: 0.4 },
    { studio: "Arch - Com", stage: "Upon issue of GFC drawings", pct: 0.5 },
    { studio: "MEPF", stage: "Upon submission of DBR", pct: 0.3 },
    { studio: "MEPF", stage: "Upon issue of GFC drawings", pct: 0.7 },
  ],
  ...over,
});

try {
  // ---------- 0. schema ----------
  for (const t of ["purchase_orders", "po_lines", "po_stages", "fy_targets", "projections", "notifications", "user_roles"]) {
    const { error } = await db.from(t).select("*", { head: true, count: "exact" }); ok(`table mis.${t} exists`, !error, error?.message);
  }

  // ---------- 1. personas: tabs per role ----------
  const expect: Record<string, string[]> = {
    admin: ["brief", "cash", "plan", "finance", "agents", "ask", "studios", "mail"], ceo: ["brief", "cash", "plan", "finance", "agents", "ask", "studios", "mail"],
    project_manager: ["brief", "cash", "plan", "agents", "ask", "studios", "mail"], finance: ["brief", "cash", "plan", "finance", "agents", "ask", "mail"],
    hr: ["brief", "studios", "ask", "mail"], employee: ["studios", "mail"],
  };
  for (const [role, tabs] of Object.entries(expect)) {
    const html = await (await fetch(`${BASE}/`, { headers: { cookie: await cookie(role, role === "project_manager" ? "MEPF" : "") } })).text();
    const nav = html.match(/<nav class="tabs"[^]*?<\/nav>/)?.[0] ?? "";
    const got = [...nav.matchAll(/href="#(\w+)"/g)].map((m) => m[1]);
    ok(`persona ${role}: tabs`, JSON.stringify(got) === JSON.stringify(tabs), got.join(","));
  }
  const pmHtml = await (await fetch(`${BASE}/`, { headers: { cookie: await cookie("project_manager", "MEPF") } })).text();
  ok("project director locked to own studio", pmHtml.includes("Stage-to-cash") && pmHtml.includes("· MEPF"));

  // ---------- 2. PO intake through MCP ----------
  const admin = await mcp(await mkKey("e2e admin", "admin"));
  const tools = (await admin.listTools()).tools.map((t) => t.name);
  ok("admin key sees PO, plan and finance tools", ["stage_po", "review_po", "fy_plan", "raise_invoice", "tracker_rows_for_excel"].every((t) => tools.includes(t)), `${tools.length} tools`);
  const prompts = (await admin.listPrompts()).prompts.map((p) => p.name);
  ok("po_intake, finance, planner prompts", ["po_intake", "finance", "planner"].every((p) => prompts.includes(p)), prompts.join(","));
  const schema = await call(admin, "get_po_schema");
  ok("get_po_schema lists studios", schema.json?.studios?.includes("MEPF"), `${schema.json?.studios?.length} studios`);

  const bad = await call(admin, "stage_po", { ...po({ po_number: "TEST-PO-BAD" }), stages: po().stages.slice(0, 4) });
  const badFails = (bad.json?.checks ?? []).filter((c: any) => !c.ok && c.severity === "error").map((c: any) => c.rule);
  ok("bad PO: stage % check (BR04) and fee check (BR05) fail", badFails.some((r: string) => r.startsWith("BR04 MEPF")) && badFails.some((r: string) => r.startsWith("BR05 MEPF")), badFails.join(" | "));
  const badApprove = await call(admin, "review_po", { po_id: bad.json.po_id, decision: "approved" });
  ok("bad PO cannot be approved without a note", badApprove.err && /check/.test(badApprove.text), badApprove.text);
  const rej = await call(admin, "review_po", { po_id: bad.json.po_id, decision: "rejected", note: "e2e" });
  ok("bad PO rejected", rej.json?.status === "rejected");

  const good = await call(admin, "stage_po", po());
  ok("good PO staged, all error checks pass", !good.err && good.json?.status === "pending_review" && !(good.json.checks as any[]).some((c) => !c.ok && c.severity === "error"), `po_id ${good.json?.po_id}, kind ${good.json?.kind}`);
  const appr = await call(admin, "review_po", { po_id: good.json.po_id, decision: "approved" });
  ok("good PO approved into tracker", appr.json?.status === "approved", JSON.stringify(appr.json?.merged));
  const { data: lines } = await db.from("project_lines").select("studio,split_value,origin,yet_to_bill_amount").eq("project_number", PN);
  ok("2 project lines created (origin po)", lines?.length === 2 && lines.every((l) => l.origin === "po"), JSON.stringify(lines));
  const { data: st } = await db.from("v_stages").select("id,studio,seq,stage,fee,workflow_status").eq("project_number", PN).order("studio").order("seq");
  ok("5 billing stages created with fees", st?.length === 5 && st.reduce((a, s) => a + Number(s.fee), 0) === 1500000, `${st?.length} stages`);
  const xl = await call(admin, "tracker_rows_for_excel", { po_id: good.json.po_id });
  ok("Excel rows in tracker column order", xl.json?.sheets?.Summary?.rows?.length === 2 && xl.json.sheets["Billing Stages"].rows.length === 5);

  const amend = await call(admin, "stage_po", po({ total_value: 1600000, lines: [{ studio: "Arch - Com", split_value: 1000000 }, { studio: "MEPF", split_value: 600000 }],
    stages: [...po().stages.slice(0, 3), { studio: "MEPF", stage: "Upon submission of DBR", pct: 0.25 }, { studio: "MEPF", stage: "Upon issue of GFC drawings", pct: 0.6 }, { studio: "MEPF", stage: "Upon virtual completion", pct: 0.15 }] }));
  ok("same PO number staged as amendment v2 with differences", amend.json?.kind === "amendment" && amend.json?.version === 2 && (amend.json?.diff ?? []).filter((d: any) => d.field.startsWith("stage changed")).length === 2, (amend.json?.diff ?? []).map((d: any) => d.field).join(" | "));
  const ap2 = await call(admin, "review_po", { po_id: amend.json.po_id, decision: "approved" });
  const { data: mepf } = await db.from("project_lines").select("split_value").eq("project_number", PN).eq("studio", "MEPF").single();
  ok("amendment merged: MEPF split updated, stage added", ap2.json?.status === "approved" && Number(mepf?.split_value) === 600000 && ap2.json?.merged?.stages_added === 1 && ap2.json?.merged?.stages_updated === 2, JSON.stringify(ap2.json?.merged));

  // ---------- 3. stage workflow → finance ----------
  const s1 = (await db.from("v_stages").select("id,studio,seq,fee").eq("project_number", PN).eq("studio", "MEPF").eq("seq", 1).single()).data!;
  for (const ev of ["complete", "client_approved", "finance_notified"]) {
    const r = await call(admin, "mark_stage", { project_number: PN, studio: "MEPF", seq: 1, event: ev });
    ok(`mark_stage ${ev}`, !r.err, r.text.slice(0, 80));
  }
  const { data: notes } = await db.from("notifications").select("role,title").gte("created_at", started).eq("role", "finance");
  ok("finance notified in-app", (notes ?? []).some((n) => n.title.includes(PN)), (notes ?? []).map((n) => n.title).join(" | "));

  const fin = await mcp(await mkKey("e2e finance", "finance"));
  const finTools = (await fin.listTools()).tools.map((t) => t.name);
  ok("finance key: invoice tools, no PO review or stage marking", finTools.includes("raise_invoice") && !finTools.includes("review_po") && !finTools.includes("mark_stage"));
  const q = await call(fin, "finance_queue");
  ok("stage appears in finance queue", (q.json ?? []).some((x: any) => x.id === s1.id && x.workflow_status === "finance_notified"));
  const inv = await call(fin, "raise_invoice", { stage_id: s1.id });
  ok("invoice raised in Zoho mirror", !inv.err && /^INV-CM-\d+/.test(inv.json?.invoice_number), inv.text.slice(0, 120));
  const { data: s1b } = await db.from("v_stages").select("workflow_status,invoice_number").eq("id", s1.id).single();
  ok("stage now invoiced", s1b?.workflow_status === "invoiced" && s1b?.invoice_number === inv.json?.invoice_number);
  const payR = await call(fin, "record_payment", { invoice_number: inv.json.invoice_number, amount: 135000, tds: 15000 });
  ok("payment recorded, invoice cleared", !payR.err && payR.json?.balance === 0, payR.text.slice(0, 100));

  // ---------- 4. role limits ----------
  const pm = await mcp(await mkKey("e2e pm", "project_manager", "MEPF"));
  const pmTools = (await pm.listTools()).tools.map((t) => t.name);
  ok("project director key: no invoice or PO review tools", !pmTools.includes("raise_invoice") && !pmTools.includes("review_po") && pmTools.includes("mark_stage"));
  const other = await call(pm, "mark_stage", { project_number: PN, studio: "Arch - Com", seq: 1, event: "complete" });
  ok("project director blocked outside own studio", other.err && /MEPF/.test(other.text), other.text);
  const pmSum = await call(pm, "get_summary", { studio: "Arch - Com" });
  ok("project director summary forced to own studio", pmSum.json?.studio === "MEPF", pmSum.json?.studio);

  // ---------- 5. plan ----------
  const fy = await call(admin, "fy_plan");
  ok("fy_plan", fy.json?.fy && fy.json.total.outlook > 0, `FY ${fy.json?.fy}: outlook ${Math.round(fy.json?.total.outlook)}, ${fy.json?.months_left} months left`);
  const esc = await call(admin, "escalations");
  ok("escalations", Array.isArray(esc.json), `${esc.json?.length} lines; top uplift ${esc.json?.[0]?.uplift ?? 0}`);
  const month = new Date().toISOString().slice(0, 7);
  const add = await call(fin, "add_projection", { month, week: 2, amount: 250000, description: "E2E forecast row", project_number: PN, studio: "Arch - Com", stage_seq: 1 });
  ok("finance adds a forecast row", !add.err, add.text.slice(0, 80));
  const proj = await call(admin, "monthly_projection", { month });
  ok("monthly projection: forecast and actual (invoice raised this month)", proj.json?.totals.forecast >= 250000 && proj.json?.totals.actual >= Number(s1.fee), JSON.stringify(proj.json?.totals));

  // ---------- 6. export + insights ----------
  const ex = await fetch(`${BASE}/api/export`, { headers: { cookie: await cookie("admin") } });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await ex.arrayBuffer()) as any);
  ok("Excel export", ex.status === 200 && wb.worksheets.map((w) => w.name).join(",") === "Summary,Billing Stages,Purchase orders" && wb.getWorksheet("Summary")!.rowCount > 400, `${wb.getWorksheet("Summary")?.rowCount} summary rows`);
  const exEmp = await fetch(`${BASE}/api/export`, { headers: { cookie: await cookie("employee") } });
  ok("employee cannot export", exEmp.status === 403);
  const ins = await fetch(`${BASE}/api/insights`, { headers: { cookie: await cookie("admin") } });
  ok("insights API", ins.status === 200, (await ins.json()).source);
  const plan = await (await fetch(`${BASE}/`, { headers: { cookie: await cookie("admin") } })).text();
  ok("dashboard renders Plan, Finance, Mail, PO intake", ["What can we bill this year?", "Stages ready to bill.", "Every client conversation", "PO intake"].every((s) => plan.includes(s)));
  for (const c of [admin, fin, pm]) await c.close();
} catch (e) {
  failN++; console.log("ERROR", e instanceof Error ? e.stack : e);
} finally {
  // ---------- cleanup ----------
  const { data: pos } = await db.from("purchase_orders").select("id").in("po_number", [PO, "TEST-PO-BAD"]);
  const poIds = (pos ?? []).map((p) => p.id);
  const { data: invs } = await db.from("zoho_invoices").select("invoice_id,customer_id").eq("reference_number", PN);
  const invIds = (invs ?? []).map((i) => i.invoice_id);
  if (invIds.length) {
    const { data: pays } = await db.from("zoho_payments").select("payment_id,invoices");
    const payIds = (pays ?? []).filter((p) => (p.invoices ?? []).some((x: any) => invIds.includes(x.invoice_id))).map((p) => p.payment_id);
    if (payIds.length) await db.from("zoho_payments").delete().in("payment_id", payIds);
    await db.from("zoho_invoices").delete().in("invoice_id", invIds);
  }
  await db.from("zoho_contacts").delete().eq("contact_name", "E2E Test Client");
  await db.from("stage_events").delete().eq("project_number", PN);
  await db.from("billing_stages").delete().eq("project_number", PN);
  await db.from("project_lines").delete().eq("project_number", PN);
  await db.from("projections").delete().eq("project_number", PN);
  if (poIds.length) { await db.from("purchase_orders").update({ parent_id: null }).in("id", poIds); await db.from("purchase_orders").delete().in("id", poIds); }
  await db.from("notifications").delete().gte("created_at", started);
  if (keyIds.length) { await db.from("agent_runs").delete().in("key_id", keyIds); await db.from("api_keys").delete().in("id", keyIds); }
  const left = await Promise.all([
    db.from("project_lines").select("id", { count: "exact", head: true }).eq("project_number", PN),
    db.from("purchase_orders").select("id", { count: "exact", head: true }).in("po_number", [PO, "TEST-PO-BAD"]),
    db.from("zoho_invoices").select("invoice_id", { count: "exact", head: true }).eq("reference_number", PN),
  ]);
  console.log(`\n${pass} passed, ${failN} failed. Cleanup left: lines ${left[0].count}, POs ${left[1].count}, invoices ${left[2].count}`);
}

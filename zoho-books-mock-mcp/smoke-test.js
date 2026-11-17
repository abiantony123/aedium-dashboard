// Starts the mock server over stdio, lists its tools and calls a few of them.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server.js"], stderr: "ignore" }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const aging = await call("get_receivables_aging");
console.log("outstanding:", aging.total_outstanding, "overdue:", aging.total_overdue, "open:", aging.open_invoices);
for (const b of aging.aging) console.log(`  ${b.bucket.padEnd(7)} ${String(b.balance).padStart(9)}  ${b.invoices.map((i) => `${i.invoice_number}(${i.days_overdue}d)`).join(" ")}`);

const oct = await call("list_invoices", { date_start: "2026-10-01", date_end: "2026-10-31" });
console.log("billed in Oct:", oct.invoices.reduce((s, i) => s + i.total, 0));

const pays = await call("list_customer_payments", { date_start: "2026-10-01", date_end: "2026-10-31" });
console.log("collected in Oct (net of TDS):", pays.customerpayments.reduce((s, p) => s + p.amount, 0));

const inv = await call("get_invoice", { invoice_id: "INV-CM-2611" });
console.log("INV-CM-2611:", inv.invoice.status, inv.invoice.custom_fields.map((f) => f.value).join(" / "));

const missing = await client.callTool({ name: "get_invoice", arguments: { invoice_id: "NOPE" } });
console.log("missing invoice isError:", missing.isError === true);

await client.close();

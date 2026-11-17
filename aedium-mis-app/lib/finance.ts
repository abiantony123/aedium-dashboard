// Finance queue. Raising an invoice and recording a payment write to the Zoho Books mirror tables
// (zoho_invoices / zoho_payments), which stand in for Zoho until the real Zoho connection is added.
import type { Db } from "./supabase/server";
import { assertCan, type Role } from "./rbac";
import { who, notify, type Actor } from "./agents/actions";

export async function financeQueue(sb: Db) {
  const { data, error } = await sb.from("v_stages").select("id,project_number,studio,seq,project_name,stage,pct,fee,workflow_status,last_event_at,last_event_by,invoice_number")
    .in("workflow_status", ["finance_notified", "invoiced"]).order("last_event_at", { ascending: true }).limit(200);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const pns = [...new Set(rows.map((r) => r.project_number))];
  const { data: lines } = pns.length ? await sb.from("project_lines").select("project_number,studio,client_name").in("project_number", pns) : { data: [] };
  const client = new Map((lines ?? []).map((l) => [`${l.project_number}|${l.studio ?? ""}`, l.client_name]));
  return rows.map((r) => ({ ...r, client_name: client.get(`${r.project_number}|${r.studio ?? ""}`) ?? null }));
}

async function nextInvoiceNumber(sb: Db) {
  const { data } = await sb.from("zoho_invoices").select("invoice_number").order("invoice_number", { ascending: false }).limit(200);
  const n = Math.max(2700, ...(data ?? []).map((r) => Number(String(r.invoice_number).match(/(\d+)$/)?.[1] ?? 0)));
  return `INV-CM-${n + 1}`;
}

async function contactFor(sb: Db, clientName: string | null) {
  const name = clientName ?? "Unknown client";
  const { data } = await sb.from("zoho_contacts").select("contact_id").ilike("contact_name", name).maybeSingle();
  if (data) return data.contact_id as string;
  const id = `C-${Date.now().toString(36)}`;
  await sb.from("zoho_contacts").insert({ contact_id: id, contact_name: name, company_name: name, payment_terms: 30 });
  return id;
}

export async function raiseInvoice(sb: Db, actor: Actor, input: { stage_id: number; invoice_number?: string; date?: string; amount?: number; terms_days?: number }) {
  assertCan(actor.role, "finance.invoice");
  const { data: s, error } = await sb.from("v_stages").select("*").eq("id", input.stage_id).single();
  if (error || !s) throw new Error(`No billing stage ${input.stage_id}.`);
  if (s.workflow_status === "billed" || s.workflow_status === "invoiced") throw new Error(`That stage is already ${s.workflow_status}.`);
  const { data: line } = await sb.from("project_lines").select("client_name").eq("project_number", s.project_number).eq("studio", s.studio).limit(1).maybeSingle();
  const number = input.invoice_number?.trim() || await nextInvoiceNumber(sb);
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const due = new Date(Date.parse(date) + (input.terms_days ?? 30) * 86400000).toISOString().slice(0, 10);
  const amount = Math.round(input.amount ?? Number(s.fee ?? 0));
  if (!(amount > 0)) throw new Error("Invoice amount must be above zero.");
  const r = await sb.from("zoho_invoices").insert({
    invoice_id: `I-${Date.now().toString(36)}`, invoice_number: number, customer_id: await contactFor(sb, line?.client_name ?? null),
    reference_number: s.project_number, date, due_date: due, total: amount, balance: amount,
    line_items: [{ description: `${s.studio ?? ""} | ${s.stage ?? ""} (${((s.pct ?? 0) * 100).toFixed(2)}%)`, amount, project_number: s.project_number, stage_seq: s.seq }],
  });
  if (r.error) throw new Error(r.error.message);
  const e = await sb.from("stage_events").insert({ project_number: s.project_number, studio: s.studio, seq: s.seq, event: "invoiced", invoice_number: number, actor: actor.id, actor_email: who(actor) });
  if (e.error) throw new Error(e.error.message);
  await notify(sb, "admin" as Role, `Invoiced: ${number}`, `${line?.client_name ?? s.project_number} · ${s.stage ?? ""} · ₹${amount.toLocaleString("en-IN")}`, "cash", number);
  return { ok: true, invoice_number: number, amount, due_date: due, note: "Recorded in the Zoho Books mirror (sample Zoho)." };
}

export async function recordPayment(sb: Db, actor: Actor, input: { invoice_number: string; amount: number; tds?: number; date?: string; reference?: string }) {
  assertCan(actor.role, "finance.payment");
  const { data: inv } = await sb.from("zoho_invoices").select("invoice_id,customer_id,balance,invoice_number").eq("invoice_number", input.invoice_number).maybeSingle();
  if (!inv) throw new Error(`No invoice ${input.invoice_number}.`);
  const applied = Math.round(input.amount + (input.tds ?? 0));
  if (applied <= 0 || applied > Number(inv.balance) + 1) throw new Error(`Amount + TDS must be between ₹1 and the balance ₹${Number(inv.balance).toLocaleString("en-IN")}.`);
  const r = await sb.from("zoho_payments").insert({
    payment_id: `P-${Date.now().toString(36)}`, payment_number: `PMT-${Date.now().toString(36).slice(-5).toUpperCase()}`, customer_id: inv.customer_id,
    date: input.date ?? new Date().toISOString().slice(0, 10), payment_mode: "banktransfer", amount: Math.round(input.amount), tax_amount_withheld: Math.round(input.tds ?? 0),
    reference_number: input.reference ?? null, invoices: [{ invoice_id: inv.invoice_id, amount_applied: applied }],
  });
  if (r.error) throw new Error(r.error.message);
  const u = await sb.from("zoho_invoices").update({ balance: Math.max(0, Number(inv.balance) - applied) }).eq("invoice_id", inv.invoice_id);
  if (u.error) throw new Error(u.error.message);
  return { ok: true, invoice_number: inv.invoice_number, applied, balance: Math.max(0, Number(inv.balance) - applied) };
}

export async function notificationsFor(sb: Db, role: Role, limit = 15) {
  const roles = role === "admin" || role === "ceo" ? ["admin", "ceo", "finance", "project_manager"] : [role];
  const { data } = await sb.from("notifications").select("id,role,title,body,tab,ref,created_at,read_at").in("role", roles).order("id", { ascending: false }).limit(limit);
  return data ?? [];
}
export async function markNotificationsRead(sb: Db, ids: number[]) {
  if (ids.length) await sb.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids).is("read_at", null);
}

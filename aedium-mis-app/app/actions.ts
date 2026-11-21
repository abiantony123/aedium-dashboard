"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { supabaseServer, dataClient, demoMode, PASS_COOKIE, ROLE_COOKIE } from "@/lib/supabase/server";
import { recordStageEvent, recordDecision, draftEmail, type Actor, type AgentName } from "@/lib/agents/actions";
import { createKey, revokeKey } from "@/lib/agents/keys";
import { assertCan } from "@/lib/rbac";
import { reviewPo, getPo, excelRows } from "@/lib/po";
import { setTarget, addProjection, deleteProjection, autofillProjection, setConstruction } from "@/lib/plan";
import { raiseInvoice as raiseInv, recordPayment as recordPay, markNotificationsRead } from "@/lib/finance";

type Result = { ok: true; message: string } | { ok: false; message: string };

async function me() {
  const { sb, user } = await dataClient();
  if (!user) throw new Error("Your session has ended. Sign in again.");
  const actor: Actor = { id: user.id, email: user.email, via: "dashboard", role: user.role, studio: user.studio };
  return { sb, actor };
}
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Not saved." });
const done = (message: string): Result => { revalidatePath("/"); return { ok: true, message }; };

// ---- stages and agents ----
export async function markStage(input: { project_number: string; studio: string | null; seq: number; event: "complete" | "client_approved" | "finance_notified"; note?: string }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await recordStageEvent(sb, actor, { project_number: input.project_number, studio: input.studio, seq: input.seq }, input.event, input.note);
    return done({ complete: "Stage marked complete", client_approved: "Client approval recorded", finance_notified: "Sent to Finance" }[input.event]);
  } catch (e) { return fail(e); }
}
export async function decide(input: { agent: AgentName; ref: string; decision: "approved" | "dismissed" }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await recordDecision(sb, actor, input.agent, input.ref, input.decision);
    if (input.decision === "dismissed") return done("Dismissed");
    return done({ collections: "Approved. Send the reminder from your mailbox.", invoice_trigger: "Sent to Finance's queue", contract_watch: "Approved. Start the extension with the client." }[input.agent]);
  } catch (e) { return fail(e); }
}
export async function getDraft(input: { agent: AgentName; ref: string }) {
  try { const { sb } = await me(); return { ok: true as const, draft: await draftEmail(sb, input.agent, input.ref) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "No draft." }; }
}

// ---- PO review ----
export async function loadPo(id: number) {
  try { const { sb, actor } = await me(); assertCan(actor.role, "data.read"); return { ok: true as const, po: await getPo(sb, id) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "Not found." }; }
}
export async function reviewPoAction(input: { id: number; decision: "approved" | "rejected"; note?: string; project_number?: string }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    const r = await reviewPo(sb, actor, input.id, input.decision, input.note, input.project_number);
    return done(r.status === "approved" ? `Approved into the tracker as ${"project_number" in r ? r.project_number : ""}` : "Rejected");
  } catch (e) { return fail(e); }
}
export async function poExcelRows(id: number) {
  try { const { sb } = await me(); return { ok: true as const, rows: await excelRows(sb, id) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "No rows." }; }
}

// ---- plan ----
export async function saveTarget(input: { fy: string; studio: string; target: number }): Promise<Result> {
  try { const { sb, actor } = await me(); await setTarget(sb, actor, input.fy, input.studio, input.target); return done("Target saved"); } catch (e) { return fail(e); }
}
export async function saveConstruction(input: { project_number: string; studio: string | null; start: string; months: number | null }): Promise<Result> {
  try { const { sb, actor } = await me(); await setConstruction(sb, actor, input); return done("Construction start saved"); } catch (e) { return fail(e); }
}
export async function addForecast(input: { month: string; week: number; amount: number; description: string; project_number?: string | null; studio?: string | null; stage_seq?: number | null }): Promise<Result> {
  try { const { sb, actor } = await me(); await addProjection(sb, actor, input); return done("Forecast added"); } catch (e) { return fail(e); }
}
export async function removeForecast(id: number): Promise<Result> {
  try { const { sb, actor } = await me(); await deleteProjection(sb, actor, id); return done("Removed"); } catch (e) { return fail(e); }
}
export async function autofillForecast(input: { month: string; studio: string | null }): Promise<Result> {
  try { const { sb, actor } = await me(); const r = await autofillProjection(sb, actor, input.month, input.studio); return done(r.added ? `Added ${r.added} forecast rows from the pipeline` : "Nothing new to add from the pipeline"); } catch (e) { return fail(e); }
}

// ---- finance (Zoho Books mirror) ----
export async function raiseInvoice(input: { stage_id: number; invoice_number?: string; amount?: number; date?: string }): Promise<Result> {
  try { const { sb, actor } = await me(); const r = await raiseInv(sb, actor, input); return done(`Invoice ${r.invoice_number} raised`); } catch (e) { return fail(e); }
}
export async function recordPayment(input: { invoice_number: string; amount: number; tds?: number; date?: string }): Promise<Result> {
  try { const { sb, actor } = await me(); const r = await recordPay(sb, actor, input); return done(`Payment recorded. Balance ${r.balance ? "₹" + r.balance.toLocaleString("en-IN") : "cleared"}`); } catch (e) { return fail(e); }
}
export async function readNotifications(ids: number[]) {
  try { const { sb } = await me(); await markNotificationsRead(sb, ids); revalidatePath("/"); } catch { /* not critical */ }
}

// ---- Connect AI: API keys inherit the creator's role ----
export async function newApiKey(input: { name: string; scope: "read" | "act" }) {
  try {
    const { actor } = await me();
    assertCan(actor.role, "keys.manage");
    const { key } = await createKey(input.name.trim() || "Unnamed key", input.scope, actor.email, actor.role, actor.studio);
    revalidatePath("/");
    return { ok: true as const, key };
  } catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "Key not created." }; }
}
export async function revokeApiKey(id: number): Promise<Result> {
  try { const { actor } = await me(); assertCan(actor.role, "keys.manage"); await revokeKey(id); return done("Key revoked"); } catch (e) { return fail(e); }
}

export async function signOut() {
  if (demoMode()) { const c = await cookies(); c.delete(PASS_COOKIE); c.delete(ROLE_COOKIE); }
  else await (await supabaseServer()).auth.signOut();
  const { redirect } = await import("next/navigation");
  redirect("/login");
}

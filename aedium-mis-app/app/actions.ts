"use server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { supabaseServer, dataClient, demoMode, PASS_COOKIE, ROLE_COOKIE } from "@/lib/supabase/server";
import { recordStageEvent, recordDecision, draftEmail, notify, type Actor, type AgentName } from "@/lib/agents/actions";
import { agentForTool, createKey, logRun, logUiAction, revokeKey, serviceDb } from "@/lib/agents/keys";
import { runTool, toolsFor, type Scope } from "@/lib/agents/tools";
import { assertCan, isRole } from "@/lib/rbac";
import { reviewPo, getPo, excelRows, stagePo } from "@/lib/po";
import { setTarget, addProjection, deleteProjection, autofillProjection, setConstruction, escalationDraft, decideEscalation } from "@/lib/plan";
import { correctPo, approveFromInbox, skipDocument, searchPos, revisePo, nextProjectNumber, decideReviewNote } from "@/lib/inbox";
import { forecast } from "@/lib/forecast";
import { decideLeakage, refreshLeakage } from "@/lib/leakage";
import { raiseInvoice as raiseInv, recordPayment as recordPay, markNotificationsRead } from "@/lib/finance";
import { decideCodeCompliance, logProjectEmail } from "@/lib/compliance";

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
    await logUiAction(actor, "mark_stage", input);
    return done({ complete: "Stage marked complete", client_approved: "Client approval recorded", finance_notified: "Sent to Finance" }[input.event]);
  } catch (e) { return fail(e); }
}
export async function decide(input: { agent: AgentName; ref: string; decision: "approved" | "dismissed" }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await recordDecision(sb, actor, input.agent, input.ref, input.decision);
    await logUiAction(actor, "decide_agent_item", input);
    if (input.decision === "dismissed") return done("Dismissed");
    return done({ collections: "Approved. Send the reminder from your mailbox.", invoice_trigger: "Sent to Finance's queue", contract_watch: "Approved. Start the extension with the client." }[input.agent]);
  } catch (e) { return fail(e); }
}
export async function getDraft(input: { agent: AgentName; ref: string }) {
  try { const { sb } = await me(); return { ok: true as const, draft: await draftEmail(sb, input.agent, input.ref) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "No draft." }; }
}

// ---- compliance & mail evidence ----
export async function runComplianceDecision(input: { row_no: number; decision: "approved" | "dismissed"; note?: string }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await decideCodeCompliance(sb, actor, input.row_no, input.decision, input.note);
    await logUiAction(actor, "decide_code_compliance", input);
    return done(input.decision === "approved" ? "Code compliance verified and logged" : "Code compliance flagged for follow-up");
  } catch (e) { return fail(e); }
}
export async function logEmailAction(input: { project_number: string; subject: string; body: string; from?: string }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await logProjectEmail(sb, actor, input);
    await logUiAction(actor, "log_project_email", input);
    return done("Client email logged to project thread (Outlook mock)");
  } catch (e) { return fail(e); }
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
    await logUiAction(actor, "review_po", { ...input, po_id: input.id, project_number: "project_number" in r ? r.project_number : input.project_number });
    return done(r.status === "approved" ? `Approved into the tracker as ${"project_number" in r ? r.project_number : ""}` : "Rejected");
  } catch (e) { return fail(e); }
}
export async function poExcelRows(id: number) {
  try { const { sb } = await me(); return { ok: true as const, rows: await excelRows(sb, id) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "No rows." }; }
}
export async function stageSamplePo(mode: "new" | "amendment" | "reset"): Promise<Result> {
  try {
    const { sb, actor } = await me();
    assertCan(actor.role, "po.stage");
    const PO_NUM = "DEMO-PO-2026-001", PN = "R-2627-101";
    if (mode === "reset") {
      const { data: rows } = await sb.from("purchase_orders").select("id").eq("po_number", PO_NUM);
      const ids = (rows ?? []).map((r) => r.id);
      await sb.from("stage_events").delete().eq("project_number", PN);
      await sb.from("billing_stages").delete().eq("project_number", PN);
      await sb.from("project_lines").delete().eq("project_number", PN);
      await sb.from("projections").delete().eq("project_number", PN);
      if (ids.length) {
        await sb.from("purchase_orders").update({ parent_id: null }).in("id", ids);
        await sb.from("purchase_orders").delete().in("id", ids);
      }
      await logUiAction(actor, "sample_po", { mode });
      return done("Sample PO reset");
    }
    const landscapeTotal = mode === "amendment" ? 500000 : 400000;
    const baseStages = (studio: string, instMonths: number) => [
      { studio, stage: "Upon signed appointment and acceptance of the PO", pct: 0.2 },
      { studio, stage: "Upon submission and written client approval of coordinated GFC drawings", pct: 0.3 },
      { studio, stage: `Monthly site support over ${instMonths} months from the actual construction start`, pct: 0.4, is_construction: true, instalments: instMonths },
      { studio, stage: "Upon submission and written acceptance of closeout documents", pct: 0.1 },
    ];
    const r = await stagePo(sb, actor, {
      po_number: PO_NUM,
      client_name: "Example Habitat",
      project_name: "Sample Grove Campus",
      project_number: PN,
      location: "Bangalore",
      project_type: "Commercial",
      po_date: "2026-10-17",
      start_date: "2026-11-01",
      end_date: "2028-10-31",
      contract_validity: "24 months",
      escalation_clause: "10% every year after the end date",
      total_value: 600000 + landscapeTotal,
      source: "attachment",
      source_ref: "Aedium_PO_Synthetic_Filled.pdf",
      confidence: 0.98,
      lines: [
        { studio: "Arch - Com", split_value: 600000, design_value: 360000, construction_value: 240000 },
        { studio: "Landscape", split_value: landscapeTotal, design_value: Math.round(landscapeTotal * 0.6), construction_value: Math.round(landscapeTotal * 0.4) },
      ],
      stages: [...baseStages("Arch - Com", 24), ...baseStages("Landscape", 36)],
    });
    await logUiAction(actor, "sample_po", { mode, po_number: r.po_number, version: r.version });
    return done(`${r.po_number} v${r.version} (${r.kind}) staged for review`);
  } catch (e) { return fail(e); }
}

export async function getEscalationDraft(rowNo: number) {
  try { const { sb } = await me(); return { ok: true as const, draft: await escalationDraft(sb, rowNo) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "No draft." }; }
}
export async function setEscalation(input: { row_no: number; decision: "approved" | "dismissed" }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await decideEscalation(sb, actor, input.row_no, input.decision);
    await logUiAction(actor, "decide_escalation", input);
    return done(input.decision === "approved" ? "Escalation proposed. Send the notice from your mailbox." : "Escalation dismissed");
  } catch (e) { return fail(e); }
}

// ---- F1 PO intake inbox ----
export async function correctPoAction(input: { id: number; patch: Parameters<typeof correctPo>[3] }): Promise<Result> {
  try { const { sb, actor } = await me(); const r = await correctPo(sb, actor, input.id, input.patch); return done(r.failed ? `Saved. ${r.failed} check(s) still fail` : "Saved. All checks pass"); } catch (e) { return fail(e); }
}
export async function approveInboxPo(input: { id: number; note?: string; project_number?: string }): Promise<Result> {
  try { const { sb, actor } = await me(); const r = await approveFromInbox(sb, actor, input.id, input.note, input.project_number); return done(`Approved into the tracker as ${r.project_number}${r.changes ? ` · ${r.changes} change(s) logged` : ""}${r.override ? " · override logged" : ""}`); } catch (e) { return fail(e); }
}
export async function searchPosAction(input: { q: string; status?: string }) {
  try { const { sb, actor } = await me(); assertCan(actor.role, "data.read"); return { ok: true as const, items: await searchPos(sb, input.q, input.status) }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "Search failed.", items: [] }; }
}
export async function revisePoAction(id: number) {
  try { const { sb, actor } = await me(); const r = await revisePo(sb, actor, id); revalidatePath("/"); return { ok: true as const, po_id: r.po_id, message: r.existed ? "A version is already open for review." : "New version opened for editing. Approve it to update the tracker." }; }
  catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "Could not open a new version." }; }
}
export async function suggestProjectNumber(poDate: string | null) {
  try { const { sb } = await me(); return await nextProjectNumber(sb, poDate); } catch { return ""; }
}
export async function notAPo(input: { inbox_id: number; reason: string }): Promise<Result> {
  try { const { sb, actor } = await me(); await skipDocument(sb, actor, input.inbox_id, input.reason || "Not a purchase order"); return done("Moved to Activity as not a PO"); } catch (e) { return fail(e); }
}
export async function decideReviewNoteAction(input: { id: number; decision: "applied" | "dismissed" }): Promise<Result> {
  try { const { sb, actor } = await me(); await decideReviewNote(sb, actor, input.id, input.decision); return done(input.decision === "applied" ? "Suggestion marked as applied" : "Suggestion dismissed"); } catch (e) { return fail(e); }
}
export async function poFileUrl(inboxId: number) {
  try {
    const { sb, actor } = await me(); assertCan(actor.role, "data.read");
    const { data: row } = await sb.from("po_inbox").select("file_path").eq("id", inboxId).single();
    if (!row?.file_path) return { ok: false as const, message: "No file stored for this item." };
    const { data, error } = await sb.storage.from("po-files").createSignedUrl(row.file_path, 300);
    if (error) throw new Error(error.message);
    return { ok: true as const, url: data.signedUrl };
  } catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "No file." }; }
}

// ---- F2 forecast ----
export async function sendPriorities(input: { studio: string | null }): Promise<Result> {
  try {
    const { sb, actor } = await me(); assertCan(actor.role, "plan.projection");
    const f = await forecast(sb, input.studio);
    const byStudio = new Map<string, typeof f.movers>();
    for (const m of f.movers) byStudio.set(m.studio ?? "Unassigned", [...(byStudio.get(m.studio ?? "Unassigned") ?? []), m]);
    for (const [st, ms] of byStudio) await notify(sb, "project_manager", `Stages that move cash · ${st}`, ms.map((m) => `${m.client ?? m.project_number}: ${(m.stage ?? "").slice(0, 60)} · ₹${Math.round(m.fee).toLocaleString("en-IN")} · ${Math.round(m.p * 100)}% by ${f.quarter_end}`).join(" | "), "plan", st);
    return done(`Sent to ${byStudio.size} studio director${byStudio.size === 1 ? "" : "s"}`);
  } catch (e) { return fail(e); }
}

// ---- F4 leakage ----
export async function decideLeakageAction(input: { id: number; decision: "confirmed" | "corrected" | "dismissed"; reason?: string; corrected_value?: number }): Promise<Result> {
  try { const { sb, actor } = await me(); const r = await decideLeakage(sb, actor, input.id, input); return done(r.message); } catch (e) { return fail(e); }
}
export async function runLeakage(): Promise<Result> {
  try { const { sb, actor } = await me(); assertCan(actor.role, "leakage.decide"); const r = await refreshLeakage(sb, actor.email); return done(`Run complete · ${r.items} open items · ${r.new} new`); } catch (e) { return fail(e); }
}

// ---- plan ----
export async function saveTarget(input: { fy: string; studio: string; target: number }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await setTarget(sb, actor, input.fy, input.studio, input.target);
    await logUiAction(actor, "set_fy_target", input);
    return done("Target saved");
  } catch (e) { return fail(e); }
}
export async function saveConstruction(input: { project_number: string; studio: string | null; start: string; months: number | null }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await setConstruction(sb, actor, input);
    await logUiAction(actor, "set_construction_schedule", input);
    return done("Construction start saved");
  } catch (e) { return fail(e); }
}
export async function addForecast(input: { month: string; week: number; amount: number; description: string; project_number?: string | null; studio?: string | null; stage_seq?: number | null }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await addProjection(sb, actor, input);
    await logUiAction(actor, "add_projection", input);
    return done("Forecast added");
  } catch (e) { return fail(e); }
}
export async function removeForecast(id: number): Promise<Result> {
  try {
    const { sb, actor } = await me();
    await deleteProjection(sb, actor, id);
    await logUiAction(actor, "delete_projection", { id });
    return done("Removed");
  } catch (e) { return fail(e); }
}
export async function autofillForecast(input: { month: string; studio: string | null }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    const r = await autofillProjection(sb, actor, input.month, input.studio);
    await logUiAction(actor, "autofill_projection", { ...input, added: r.added });
    return done(r.added ? `Added ${r.added} forecast rows from the pipeline` : "Nothing new to add from the pipeline");
  } catch (e) { return fail(e); }
}

// ---- finance (Zoho Books mirror) ----
export async function raiseInvoice(input: { stage_id: number; invoice_number?: string; amount?: number; date?: string }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    const r = await raiseInv(sb, actor, input);
    await logUiAction(actor, "raise_invoice", { ...input, invoice_number: r.invoice_number, amount: r.amount });
    return done(`Invoice ${r.invoice_number} raised`);
  } catch (e) { return fail(e); }
}
export async function recordPayment(input: { invoice_number: string; amount: number; tds?: number; date?: string }): Promise<Result> {
  try {
    const { sb, actor } = await me();
    const r = await recordPay(sb, actor, input);
    await logUiAction(actor, "record_payment", input);
    return done(`Payment recorded. Balance ${r.balance ? "₹" + r.balance.toLocaleString("en-IN") : "cleared"}`);
  } catch (e) { return fail(e); }
}
export async function readNotifications(ids: number[]) {
  try { const { sb } = await me(); await markNotificationsRead(sb, ids); revalidatePath("/"); } catch { /* not critical */ }
}

// ---- Connect AI: API keys inherit the creator's role, plus live MCP test runner ----
export async function newApiKey(input: { name: string; scope: "read" | "act" }) {
  try {
    const { actor } = await me();
    assertCan(actor.role, "keys.manage");
    const name = input.name.trim() || "Unnamed key";
    const { key } = await createKey(name, input.scope, actor.email, actor.role, actor.studio);
    await logUiAction(actor, "api_key_create", { name, scope: input.scope });
    revalidatePath("/");
    return { ok: true as const, key };
  } catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "Key not created." }; }
}
export async function revokeApiKey(id: number): Promise<Result> {
  try {
    const { actor } = await me();
    assertCan(actor.role, "keys.manage");
    await revokeKey(id);
    await logUiAction(actor, "api_key_revoke", { id });
    return done("Key revoked");
  } catch (e) { return fail(e); }
}
export async function testMcpCall(input: { key_id?: number; client: string; tool: string; args: Record<string, unknown> }) {
  try {
    const { actor } = await me();
    assertCan(actor.role, "keys.manage");
    const sb = serviceDb();
    const { data: keyRow } = input.key_id
      ? await sb.from("api_keys").select("id,name,scope,role,studio,created_by").eq("id", input.key_id).is("revoked_at", null).maybeSingle()
      : { data: null };
    if (input.key_id && !keyRow) throw new Error("Selected API key was not found or has been revoked.");
    const keyScope: Scope = keyRow?.scope === "act" || keyRow?.scope === "read" ? keyRow.scope : "read";
    const keyRole = keyRow && isRole(keyRow.role) ? keyRow.role : actor.role;
    const keyActor: Actor = {
      id: null,
      email: keyRow?.created_by ?? actor.email,
      via: `mcp:${keyRow?.name ?? "Live test key"}`,
      role: keyRole,
      studio: keyRow ? (keyRow.studio ?? null) : actor.studio,
    };
    const allowed = toolsFor(keyScope, keyRole).some((t) => t.name === input.tool);
    if (!allowed) throw new Error(`Key scope (${keyScope}) or role (${keyRole}) cannot run ${input.tool}.`);
    const started = Date.now();
    const client = input.client.trim() || "Codex CLI";
    const agent = agentForTool(input.tool, input.args);
    const auditedInput = { ...input.args, _actor: keyActor.email, _role: keyActor.role, _studio: keyActor.studio, _agent: agent };
    try {
      const output = await runTool(input.tool, { sb, actor: keyActor }, input.args);
      const ms = Date.now() - started;
      await logRun({ key_id: keyRow?.id ?? null, key_name: keyRow?.name ?? "Live test key", client, tool: input.tool, input: auditedInput, ok: true, ms });
      revalidatePath("/");
      return { ok: true as const, output, ms, client, agent };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logRun({ key_id: keyRow?.id ?? null, key_name: keyRow?.name ?? "Live test key", client, tool: input.tool, input: auditedInput, ok: false, error: msg, ms: Date.now() - started });
      revalidatePath("/");
      return { ok: false as const, message: msg };
    }
  } catch (e) { return { ok: false as const, message: e instanceof Error ? e.message : "Test call failed." }; }
}

export async function signOut() {
  if (demoMode()) { const c = await cookies(); c.delete(PASS_COOKIE); c.delete(ROLE_COOKIE); }
  else await (await supabaseServer()).auth.signOut();
  const { redirect } = await import("next/navigation");
  redirect("/login");
}

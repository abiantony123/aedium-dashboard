// Write paths shared by the dashboard buttons, the Ask tab and the MCP server.
import type { Db } from "../supabase/server";
import { inr, niceDate } from "../format";
import { assertCan, type Action, type Role } from "../rbac";

export type Actor = { id: string | null; email: string; via: string; role: Role; studio: string | null };   // via: "dashboard" | "mcp:<key name>" ...
export type StageKey = { project_number: string; studio: string | null; seq: number };
export type StageEvent = "complete" | "client_approved" | "finance_notified" | "reopened";
export type AgentName = "collections" | "invoice_trigger" | "contract_watch";

export const who = (a: Actor) => (a.via === "dashboard" ? a.email : `${a.email} via ${a.via}`);
const EVENT_ACTION: Record<StageEvent, Action> = { complete: "stage.complete", client_approved: "stage.approve", finance_notified: "stage.notify_finance", reopened: "stage.complete" };
const AGENT_ACTION: Record<AgentName, Action> = { collections: "agent.collections", invoice_trigger: "agent.invoice_trigger", contract_watch: "agent.contract_watch" };

// A project director is scoped to their own studio.
export function assertStudio(actor: Actor, studio: string | null) {
  if (actor.role === "project_manager" && actor.studio && studio !== actor.studio) throw new Error(`You can only act on ${actor.studio} stages.`);
}

export async function notify(sb: Db, role: Role, title: string, body: string, tab: string, ref?: string) {
  await sb.from("notifications").insert({ role, title, body, tab, ref: ref ?? null });
}

export async function recordStageEvent(sb: Db, actor: Actor, key: StageKey, event: StageEvent, note?: string) {
  assertCan(actor.role, EVENT_ACTION[event]);
  assertStudio(actor, key.studio);
  let q = sb.from("v_stages").select("id,stage,workflow_status").eq("project_number", key.project_number).eq("seq", key.seq);
  q = key.studio == null ? q.is("studio", null) : q.eq("studio", key.studio);
  const { data: stage, error: e1 } = await q.maybeSingle();
  if (e1) throw new Error(e1.message);
  if (!stage) throw new Error(`No billing stage ${key.project_number} / ${key.studio ?? "-"} / ${key.seq}.`);
  if (stage.workflow_status === "billed") throw new Error("That stage is already billed in the tracker.");
  const { error } = await sb.from("stage_events").insert({ ...key, event, note: note ?? null, actor: actor.id, actor_email: who(actor) });
  if (error) throw new Error(error.message);
  if (event === "finance_notified")
    await notify(sb, "finance", `Raise invoice: ${key.project_number} · ${key.studio ?? ""}`, `${stage.stage ?? "Stage " + key.seq} is ready for billing (sent by ${who(actor)}).`, "finance", `${key.project_number}|${key.studio ?? ""}|${key.seq}`);
  return { ok: true, stage: stage.stage, event };
}

export async function recordDecision(sb: Db, actor: Actor, agent: AgentName, ref: string, decision: "approved" | "dismissed", note?: string) {
  assertCan(actor.role, AGENT_ACTION[agent]);
  let stageKey: StageKey | null = null;
  if (agent === "invoice_trigger" && decision === "approved") {
    const { data, error } = await sb.from("v_stages").select("project_number,studio,seq,workflow_status").eq("id", Number(ref)).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`No billing stage with id ${ref}.`);
    stageKey = { project_number: data.project_number, studio: data.studio, seq: data.seq };
  }
  const { error } = await sb.from("agent_decisions").insert({ agent, ref, decision, note: note ?? null, actor: actor.id, actor_email: who(actor) });
  if (error) throw new Error(error.message);
  if (stageKey) await recordStageEvent(sb, actor, stageKey, "finance_notified", "Approved from the invoice trigger agent");
  return { ok: true, agent, ref, decision };
}

// Drafts are text only. Nothing is ever sent from here.
export async function draftEmail(sb: Db, agent: AgentName, ref: string) {
  if (agent === "collections") {
    const { data: i } = await sb.from("v_open_invoices").select("*").eq("invoice_number", ref).maybeSingle();
    if (!i) throw new Error(`No open invoice ${ref}.`);
    return {
      to: i.customer_name ?? "Client accounts team",
      subject: `Payment reminder: ${i.invoice_number} (${inr(i.balance)}), ${i.days_overdue} days overdue`,
      body: `Dear ${i.customer_name ?? "team"},\n\nThis is a reminder that invoice ${i.invoice_number} dated ${niceDate(i.date)} for ${inr(i.total)}${i.project_name ? ` on ${i.project_name}` : ""} fell due on ${niceDate(i.due_date)} and ${inr(i.balance)} remains outstanding, now ${i.days_overdue} days past the 30-day terms.\n\nCould you confirm the expected payment date? If the payment has been released, please share the UTR so we can match it.\n\nRegards,\nAedium Design · Accounts`,
    };
  }
  if (agent === "invoice_trigger") {
    const { data: s } = await sb.from("v_stages").select("*").eq("id", Number(ref)).maybeSingle();
    if (!s) throw new Error(`No billing stage with id ${ref}.`);
    return {
      to: "Finance",
      subject: `Raise invoice: ${s.project_number} · ${s.studio ?? ""} · stage ${s.seq}`,
      body: `Hi Finance,\n\nPlease raise the invoice for this completed stage:\n\nProject number: ${s.project_number}\nProject: ${s.project_name ?? "-"}\nStudio: ${s.studio ?? "-"}\nStage: ${s.stage ?? "-"}\nStage %: ${s.pct != null ? (Number(s.pct) * 100).toFixed(2) + "%" : "-"}\nFee: ${inr(s.fee)} (excl. GST)\nStatus: ${String(s.workflow_status).replace("_", " ")}\n\nThe stage is recorded in the master tracker (Billing Stages row ${s.row_no}).\n\nThanks,\nProject Planning & MIS`,
    };
  }
  const { data: l } = await sb.from("project_lines").select("*").eq("row_no", Number(ref)).maybeSingle();
  if (!l) throw new Error(`No project line at Summary row ${ref}.`);
  return {
    to: l.client_name ?? "Client",
    subject: `Contract extension: ${l.project_name ?? l.project_number} (${l.studio ?? ""})`,
    body: `Dear ${l.client_name ?? "team"},\n\nOur appointment for ${l.project_name ?? l.project_number} (${l.studio ?? ""}) ${l.end_date ? `runs to ${niceDate(l.end_date)}` : "has no end date on record"}, while ${inr(l.yet_to_bill_amount)} of the agreed fee is still to be billed as the work progresses.\n\nWe would like to extend the contract validity to cover the remaining stages${l.escalation_clause ? `, with the escalation clause as agreed (${l.escalation_clause})` : ""}. Could we set up a short call this week to confirm the revised dates?\n\nRegards,\nAedium Design`,
  };
}

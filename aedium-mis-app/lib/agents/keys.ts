// API keys for the Aedium MCP server, and a unified audit log of every UI change and MCP/Agent call.
import { createClient } from "@supabase/supabase-js";
import type { Db } from "../supabase/server";
import type { Scope } from "./tools";

export function serviceDb(): Db {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("The MCP server needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.");
  return createClient(url, key, { db: { schema: "mis" }, auth: { persistSession: false } });
}

export async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function agentForTool(tool: string, input?: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "agent_queue" || tool === "decide_agent_item" || tool === "draft_email") {
    return {
      collections: "Collections agent",
      invoice_trigger: "Invoice trigger agent",
      contract_watch: "Contract watch agent",
      code_compliance: "Code compliance agent",
      email_evidence: "Email evidence agent",
    }[String(o.agent ?? "")] ?? "Collections agent";
  }
  if (["stage_po", "review_po", "get_po_schema", "list_pos", "get_po", "tracker_rows_for_excel", "sample_po"].includes(tool)) return "PO intake agent";
  if (["mark_stage", "project_stages"].includes(tool)) return "Invoice trigger agent";
  if (["raise_invoice", "record_payment", "finance_queue", "open_invoices", "payments"].includes(tool)) return "Finance agent";
  if (["fy_plan", "set_fy_target", "set_construction_schedule", "monthly_projection", "add_projection", "delete_projection", "autofill_projection"].includes(tool)) return "Planning agent";
  if (["escalations", "decide_escalation", "escalation_draft", "contracts_ending"].includes(tool)) return "Contract watch agent";
  if (["email_evidence_search", "log_project_email"].includes(tool)) return "Email evidence agent";
  if (["code_compliance_check", "decide_code_compliance"].includes(tool)) return "Code compliance agent";
  if (["api_key_create", "api_key_revoke"].includes(tool)) return "Connect AI";
  return "Aedium analyst";
}

export function summarizeChange(tool: string, input: unknown): { target: string; detail: string } {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const inrAmt = (v: unknown) => `₹${Math.round(Number(v ?? 0)).toLocaleString("en-IN")}`;
  switch (tool) {
    case "mark_stage":
      return {
        target: [o.project_number, o.studio, o.seq ? `#${o.seq}` : null].filter(Boolean).join(" · ") || "Stage",
        detail: `Marked stage ${String(o.event ?? "updated").replace(/_/g, " ")}${o.note ? ` (${String(o.note).slice(0, 60)})` : ""}`,
      };
    case "decide_agent_item":
      return {
        target: `${o.agent ?? "agent"} · ${o.ref ?? ""}`,
        detail: `${o.decision === "approved" ? "Approved" : "Dismissed"} queue item`,
      };
    case "stage_po":
      return {
        target: `${o.po_number ?? "PO"}${o.project_number ? ` · ${o.project_number}` : ""}`,
        detail: `Staged PO${o.total_value ? ` (${inrAmt(o.total_value)})` : ""}`,
      };
    case "review_po":
      return {
        target: `PO #${o.po_id ?? o.id ?? ""}${o.project_number ? ` · ${o.project_number}` : ""}`,
        detail: `${o.decision === "approved" ? "Approved into tracker" : "Rejected"}${o.note ? ` — ${String(o.note).slice(0, 60)}` : ""}`,
      };
    case "sample_po":
      return { target: "DEMO-PO-2026-001 · R-2627-101", detail: `Sample PO action: ${o.mode ?? "new"}` };
    case "raise_invoice":
      return {
        target: `Stage #${o.stage_id ?? ""}${o.invoice_number ? ` · ${o.invoice_number}` : ""}`,
        detail: `Raised invoice${o.amount ? ` for ${inrAmt(o.amount)}` : ""}`,
      };
    case "record_payment":
      return {
        target: String(o.invoice_number ?? "Invoice"),
        detail: `Recorded payment ${inrAmt(o.amount)}${o.tds ? ` (+ ${inrAmt(o.tds)} TDS)` : ""}`,
      };
    case "set_fy_target":
      return { target: `${o.fy ?? "FY"} · ${o.studio ?? "All"}`, detail: `Set FY target to ${inrAmt(o.target)}` };
    case "set_construction_schedule":
      return {
        target: `${o.project_number ?? ""}${o.studio ? ` · ${o.studio}` : ""}` || "Construction plan",
        detail: `Set construction start ${o.start ?? ""}${o.months ? ` (${o.months} mo)` : ""}`,
      };
    case "add_projection":
      return {
        target: `${o.month ?? ""}${o.week ? ` W${o.week}` : ""}${o.project_number ? ` · ${o.project_number}` : ""}`,
        detail: `Added forecast ${inrAmt(o.amount)} — ${String(o.description ?? "").slice(0, 50)}`,
      };
    case "delete_projection":
      return { target: `Forecast #${o.id ?? ""}`, detail: "Removed monthly forecast row" };
    case "autofill_projection":
      return {
        target: `${o.month ?? ""}${o.studio ? ` · ${o.studio}` : ""}`,
        detail: "Auto-filled projection from active pipeline",
      };
    case "decide_escalation":
      return {
        target: `Summary row ${o.row_no ?? ""}`,
        detail: `${o.decision === "approved" ? "Proposed" : "Dismissed"} escalation notice`,
      };
    case "decide_code_compliance":
      return {
        target: `Summary row ${o.row_no ?? ""}`,
        detail: `${o.decision === "approved" ? "Verified" : "Flagged"} NBC 2016 & bye-law checklist${o.note ? ` — ${String(o.note).slice(0, 50)}` : ""}`,
      };
    case "log_project_email":
      return {
        target: String(o.project_number ?? "Project"),
        detail: `Logged client email: "${String(o.subject ?? "").slice(0, 55)}"`,
      };
    case "code_compliance_check":
      return {
        target: String(o.project_number ?? o.studio ?? "Active lines"),
        detail: "Checked NBC 2016 & municipal bye-law compliance",
      };
    case "email_evidence_search":
      return {
        target: String(o.project_number ?? o.query ?? o.studio ?? "All threads"),
        detail: "Searched project email evidence & approvals",
      };
    case "api_key_create":
      return { target: String(o.name ?? "API key"), detail: `Created ${o.scope ?? "act"} MCP API key` };
    case "api_key_revoke":
      return { target: `Key #${o.id ?? ""}`, detail: "Revoked MCP API key" };
    default:
      return {
        target: [o.project_number, o.studio, o.client, o.month, o.query, o.search, o.agent, o.name].filter(Boolean).slice(0, 2).join(" · ") || "Workspace",
        detail: `Ran ${tool.replace(/_/g, " ")}`,
      };
  }
}

export async function createKey(name: string, scope: Scope, createdBy: string, role: string, studio: string | null) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = "ak_live_" + Buffer.from(bytes).toString("base64url");
  const { data, error } = await serviceDb().from("api_keys")
    .insert({ name: name.slice(0, 80), scope, prefix: key.slice(0, 12), key_hash: await sha256(key), created_by: createdBy, role, studio })
    .select("id,name,prefix,scope,created_at").single();
  if (error) throw new Error(error.message);
  return { key, record: data };
}

export type KeyInfo = { id: number; name: string; prefix: string; scope: Scope; role: string; studio: string | null; created_by: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null };

export async function listKeys(): Promise<KeyInfo[]> {
  const { data, error } = await serviceDb().from("api_keys").select("id,name,prefix,scope,role,studio,created_by,created_at,last_used_at,revoked_at").order("id", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as KeyInfo[];
}

export async function revokeKey(id: number) {
  const { error } = await serviceDb().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function verifyKey(key: string): Promise<KeyInfo | null> {
  if (!/^ak_live_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  const db = serviceDb();
  const { data } = await db.from("api_keys").select("id,name,prefix,scope,role,studio,created_by,created_at,last_used_at,revoked_at").eq("key_hash", await sha256(key)).is("revoked_at", null).maybeSingle();
  if (!data) return null;
  // last_used_at is informational; at most one write a minute per key.
  if (!data.last_used_at || Date.now() - Date.parse(data.last_used_at) > 60000)
    await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return data as KeyInfo;
}

export async function logRun(entry: { key_id: number | null; key_name: string; client: string | null; tool: string; input: unknown; ok: boolean; error?: string; ms: number }) {
  await serviceDb().from("agent_runs").insert({ ...entry, input: entry.input ?? null, error: entry.error ?? null });
}

export async function logUiAction(actor: { email: string; role: string; studio: string | null }, tool: string, input: unknown, ok = true, error?: string) {
  const payload = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : { value: input };
  await logRun({
    key_id: null,
    key_name: `${actor.email} (${actor.role}${actor.studio ? ` · ${actor.studio}` : ""})`,
    client: "Dashboard UI",
    tool,
    input: { ...payload, _actor: actor.email, _role: actor.role, _studio: actor.studio, _agent: agentForTool(tool, input) },
    ok,
    error,
    ms: 0,
  }).catch(() => { /* never break user actions if audit logging fails */ });
}

export type AuditRun = {
  id: number; key_id: number | null; key_name: string | null; client: string | null; tool: string; ok: boolean; error: string | null; ms: number | null; created_at: string;
  agent: string; actor: string; role: string | null; source: string; is_ui: boolean; target: string; detail: string;
};

export async function recentRuns(limit = 40): Promise<AuditRun[]> {
  const { data } = await serviceDb().from("agent_runs").select("id,key_id,key_name,client,tool,input,ok,error,ms,created_at").order("id", { ascending: false }).limit(limit);
  return (data ?? []).map((r) => {
    const inp = (r.input && typeof r.input === "object" ? r.input : {}) as Record<string, unknown>;
    const is_ui = r.client === "Dashboard UI";
    const { target, detail } = summarizeChange(r.tool, inp);
    return {
      id: r.id as number,
      key_id: (r.key_id as number | null) ?? null,
      key_name: (r.key_name as string | null) ?? null,
      client: (r.client as string | null) ?? null,
      tool: String(r.tool),
      ok: Boolean(r.ok),
      error: (r.error as string | null) ?? null,
      ms: (r.ms as number | null) ?? null,
      created_at: String(r.created_at),
      agent: String(inp._agent ?? agentForTool(String(r.tool), inp)),
      actor: String(inp._actor ?? r.key_name ?? "unknown"),
      role: inp._role ? String(inp._role) : null,
      source: is_ui ? "Dashboard UI" : `MCP · ${r.client ?? "Assistant"} (${r.key_name ?? "key"})`,
      is_ui,
      target,
      detail,
    };
  });
}

// Read-only rows for the Tracker tab (Excel-style grid): the Summary and Billing Stages sheets of the master tracker.
import { NextResponse } from "next/server";
import { dataClient } from "@/lib/supabase/server";
import { all } from "@/lib/data";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Kind = "text" | "money" | "pct" | "date" | "num";
type Col = { key: string; label: string; kind: Kind };
const SUMMARY: Col[] = [
  { key: "sl_no", label: "Sl. No.", kind: "text" }, { key: "financial_year", label: "FY", kind: "text" }, { key: "project_number", label: "Project number", kind: "text" },
  { key: "client_name", label: "Client", kind: "text" }, { key: "project_name", label: "Project", kind: "text" }, { key: "location", label: "Location", kind: "text" },
  { key: "studio", label: "Studio", kind: "text" }, { key: "project_type", label: "Type", kind: "text" }, { key: "contract_validity", label: "Validity", kind: "text" },
  { key: "start_date", label: "Start", kind: "date" }, { key: "end_date", label: "End", kind: "date" }, { key: "escalation_clause", label: "Escalation", kind: "text" },
  { key: "split_value", label: "Studio value", kind: "money" }, { key: "billed_pct", label: "Billed %", kind: "pct" }, { key: "billed_amount", label: "Billed", kind: "money" },
  { key: "yet_to_bill_amount", label: "Yet to bill", kind: "money" }, { key: "design_value", label: "Design", kind: "money" }, { key: "construction_value", label: "Construction", kind: "money" },
  { key: "status", label: "Status", kind: "text" }, { key: "project_stage", label: "Stage", kind: "text" }, { key: "spoc", label: "SPOC", kind: "text" },
];
const STAGES: Col[] = [
  { key: "sl_no", label: "Sl. No.", kind: "text" }, { key: "project_number", label: "Project number", kind: "text" }, { key: "project_name", label: "Project", kind: "text" },
  { key: "studio", label: "Studio", kind: "text" }, { key: "seq", label: "#", kind: "num" }, { key: "stage", label: "Stage", kind: "text" }, { key: "completion", label: "Proposed completion", kind: "text" },
  { key: "pct", label: "Fee %", kind: "pct" }, { key: "fee", label: "Fee", kind: "money" }, { key: "billed_on", label: "Billed on", kind: "date" },
  { key: "workflow_status", label: "Workflow", kind: "text" }, { key: "invoice_number", label: "Invoice #", kind: "text" }, { key: "assigned_to", label: "Assigned to", kind: "text" }, { key: "remarks", label: "Remarks", kind: "text" },
];

export async function GET(req: Request) {
  const { sb, user } = await dataClient();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!can(user.role, "data.read")) return NextResponse.json({ error: "Your role cannot open the tracker." }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const studio = user.role === "project_manager" && user.studio ? user.studio : sp.get("studio") || null;
  const client = sp.get("client") || null;
  const project = sp.get("project") || null;
  const sheet = sp.get("sheet") === "stages" ? "stages" : "summary";

  const lines = (await all<Record<string, unknown>>(sb, "project_lines", "*", "row_no")).filter((l) => (!studio || l.studio === studio) && (!client || l.client_name === client) && (!project || l.project_number === project));
  if (sheet === "summary") return NextResponse.json({ sheet, columns: SUMMARY, rows: lines });
  const pns = new Set(lines.map((l) => l.project_number as string));
  const stages = (await all<Record<string, unknown>>(sb, "v_stages", "*", "row_no")).filter((s) => (!studio || s.studio === studio) && (!client || pns.has(s.project_number as string)) && (!project || s.project_number === project));
  return NextResponse.json({ sheet, columns: STAGES, rows: stages });
}

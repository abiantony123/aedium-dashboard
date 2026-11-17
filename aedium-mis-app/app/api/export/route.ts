// Download the tracker as an .xlsx in the master tracker's column layout (Summary + Billing Stages + POs).
import ExcelJS from "exceljs";
import { dataClient } from "@/lib/supabase/server";
import { all, type Line, type Stage } from "@/lib/data";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const { sb, user } = await dataClient();
  if (!user) return new Response("Sign in first.", { status: 401 });
  if (!can(user.role, "data.read")) return new Response("Your role cannot export the tracker.", { status: 403 });
  const studio = user.role === "project_manager" && user.studio ? user.studio : new URL(req.url).searchParams.get("studio");

  const [lines, stages] = await Promise.all([
    all<Line & { origin: string; total_project_value: number | null; location: string | null; contract_validity: string | null; split_pct: number | null; yet_to_bill_pct: number | null }>(sb, "project_lines", "*"),
    all<Stage & { project_value: number | null; completion: string | null; assigned_to: string | null; remarks: string | null; origin: string }>(sb, "v_stages", "*"),
  ]);
  const L = lines.filter((l) => !studio || l.studio === studio).sort((a, b) => a.row_no - b.row_no);
  const S = stages.filter((s) => !studio || s.studio === studio).sort((a, b) => a.project_number.localeCompare(b.project_number) || String(a.studio).localeCompare(String(b.studio)) || a.seq - b.seq);
  const { data: pos } = await sb.from("purchase_orders").select("po_number,version,kind,status,client_name,project_number,project_name,total_value,start_date,end_date,escalation_clause,source,source_ref,extracted_by,reviewed_by,reviewed_at").order("id");

  const wb = new ExcelJS.Workbook();
  wb.creator = "Aedium MIS"; wb.created = new Date();
  const sheet = (name: string, headers: string[], rows: unknown[][]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(headers).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    ws.columns.forEach((c) => { c.width = 16; });
    return ws;
  };
  sheet("Summary",
    ["Sl. No.", "Financial Year", "Project Number", "Client Name", "Project Name", "Location", "Studio", "Project type", "Contract Validity", "Project Start Date", "Project End Date", "Escalation Clause", "Total Project Value in INR", "Project split", "Project split %", "Billed %", "Billed", "Yet to bill %", "Yet to bill", "Design Value", "Construction Value", "Project Status", "Project Stage", "Project SPOC", "Source"],
    L.map((l) => [l.sl_no, l.financial_year, l.project_number, l.client_name, l.project_name, l.location, l.studio, l.project_type, l.contract_validity, l.start_date, l.end_date, l.escalation_clause, l.total_project_value, l.split_value, l.split_pct, l.billed_pct, l.billed_amount, l.yet_to_bill_pct, l.yet_to_bill_amount, l.design_value, l.construction_value, l.status, l.project_stage, l.spoc, l.origin === "po" ? "Approved PO" : "Excel"]));
  sheet("Billing Stages",
    ["Sl. No.", "Project Number", "Project Name", "Service", "Project Value in INR", "Stage", "Proposed Completion", "Percentage", "Fee/stage in INR", "Billed", "Work Assigned to", "Remarks", "App status", "Invoice (app)", "Source"],
    S.map((s) => [s.sl_no, s.project_number, s.project_name, s.studio, s.project_value, s.stage, s.completion, s.pct, s.fee, s.billed_on, s.assigned_to, s.remarks, s.workflow_status, (s as { invoice_number?: string }).invoice_number ?? null, s.origin === "po" ? "Approved PO" : "Excel"]));
  sheet("Purchase orders",
    ["PO number", "Version", "Kind", "Status", "Client", "Project number", "Project name", "Value excl. GST", "Start", "End", "Escalation", "Source", "Source ref", "Extracted by", "Reviewed by", "Reviewed at"],
    (pos ?? []).map((p) => [p.po_number, p.version, p.kind, p.status, p.client_name, p.project_number, p.project_name, p.total_value, p.start_date, p.end_date, p.escalation_clause, p.source, p.source_ref, p.extracted_by, p.reviewed_by, p.reviewed_at]));

  const buf = await wb.xlsx.writeBuffer();
  const name = `aedium-master-tracker${studio ? "-" + studio.replace(/[^\w]+/g, "-") : ""}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return new Response(buf as ArrayBuffer, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}

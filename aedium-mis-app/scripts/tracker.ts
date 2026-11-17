// Reads the Aedium master tracker workbook into clean rows for Supabase.
// Normalises project numbers, statuses and the three date styles the sheet uses.
import ExcelJS from "exceljs";

export type ProjectLine = {
  sl_no: string; financial_year: string | null; project_number: string; client_name: string | null;
  project_name: string | null; location: string | null; studio: string | null; project_type: string | null;
  contract_validity: string | null; start_date: string | null; end_date: string | null; escalation_clause: string | null;
  total_project_value: number | null; split_value: number | null; split_pct: number | null;
  billed_pct: number | null; billed_amount: number | null; yet_to_bill_pct: number | null; yet_to_bill_amount: number | null;
  paid_to_sub: number | null; yet_to_pay_sub: number | null; sub_total_value: number | null;
  design_value: number | null; construction_value: number | null; short_closed_value: number | null;
  site_area: number | null; built_up_area: number | null; parking_area: number | null;
  status: string | null; status_raw: string | null; project_stage: string | null; spoc: string | null;
  construction_stage: string | null; construction_pct: number | null; construction_amount: number | null;
  expected_deliverable: string | null; current_stage: string | null; row_no: number;
};
export type BillingStage = {
  project_number: string; project_name: string | null; studio: string | null; project_value: number | null;
  seq: number; stage: string | null; completion: string | null; pct: number | null; fee: number | null;
  billed_on: string | null; billed_note: string | null; assigned_to: string | null; remarks: string | null;
  workflow_status: "pending" | "in_progress" | "complete" | "billed"; row_no: number; sl_no: string | null;
};
export type SubConsultant = {
  loa: string; financial_year: string | null; consultant_name: string | null; project_number: string | null;
  project_name: string | null; service: string | null; start_date: string | null; end_date: string | null;
  value: number | null; paid: number | null; yet_to_pay: number | null;
};
export type SubStage = {
  loa: string; consultant_name: string | null; stage: string | null; completion: string | null; pct: number | null;
  fee: number | null; invoice_date: string | null; invoice_no: string | null; paid_on: string | null; remarks: string | null; seq: number;
};
export type Staff = { name: string; designation: string | null };

function raw(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) return raw(((v as ExcelJS.CellFormulaValue).result ?? null) as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text;
    if ("error" in v) return null;
  }
  return v;
}
const str = (v: unknown) => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" || s === "-" ? null : s;
};
const num = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v); if (!s) return null;
  const n = Number(s.replace(/[,₹\s]/g, "").replace(/%$/, ""));
  return Number.isFinite(n) ? (s.endsWith("%") ? n / 100 : n) : null;
};
// Dates arrive as real dates, Excel serials, "31/10/2022", "31-10-2022", "28.07.2023" or US "11/14/2022".
export function date(v: unknown): string | null {
  if (v instanceof Date) return isNaN(+v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const s = str(v); if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
    let d = a, mo = b;                       // Indian day-first by default
    if (b > 12 && a <= 12) { d = b; mo = a; } // US month-first when it can only be that
    return real(y, mo, d);
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? real(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
}
// Only dates that exist on the calendar ("31/11/2027" is typed in the sheet; it becomes blank).
function real(y: number, mo: number, d: number) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || t.getUTCDate() !== d || t.getUTCMonth() !== mo - 1) return null;
  return t.toISOString().slice(0, 10);
}
const pn = (v: unknown) => str(v)?.replace(/\s+/g, "").toUpperCase() ?? null;

// One controlled vocabulary for Project Status (requirement R14).
export function normStatus(v: string | null): string | null {
  if (!v) return null;
  if (/^[\d.,\s]+$/.test(v)) return null;          // a number typed into the status column
  const s = v.toLowerCase().replace(/[^a-z]/g, "");
  if (s.startsWith("inprogress") || s === "ongoing" || s === "wip" || s.endsWith("stage") || s.includes("stagedbr")) return "In progress";
  if (s.includes("cancel")) return "Cancelled";
  if (s.startsWith("complete")) return "Completed";
  if (s.startsWith("terminat")) return "Terminated";
  if (s.includes("hold")) return "On hold";
  if (s.includes("short")) return "Short closed";
  if (s.includes("yet") || s.includes("notstart")) return "Not started";
  return v.trim();
}

export async function readTracker(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = (name: string) => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Sheet "${name}" not found in ${file}`);
    return ws;
  };
  const cell = (row: ExcelJS.Row, col: string) => raw(row.getCell(col).value);

  // ---- Summary: one row per project x studio line ----
  const lines: ProjectLine[] = [];
  sheet("Summary").eachRow((row, r) => {
    if (r < 3) return;
    const project_number = pn(cell(row, "D"));
    if (!project_number || !/^R-?\d/.test(project_number)) return;
    const statusRaw = str(cell(row, "AJ"));
    lines.push({
      row_no: r, sl_no: str(cell(row, "B")) ?? String(r), financial_year: str(cell(row, "C")), project_number,
      client_name: str(cell(row, "E")), project_name: str(cell(row, "F")), location: str(cell(row, "G")),
      studio: str(cell(row, "H")), project_type: str(cell(row, "I")), contract_validity: str(cell(row, "J")),
      start_date: date(cell(row, "K")), end_date: date(cell(row, "L")), escalation_clause: str(cell(row, "M")),
      total_project_value: num(cell(row, "N")), split_value: num(cell(row, "O")), split_pct: num(cell(row, "P")),
      billed_pct: num(cell(row, "Q")), billed_amount: num(cell(row, "R")),
      yet_to_bill_pct: num(cell(row, "S")), yet_to_bill_amount: num(cell(row, "T")),
      paid_to_sub: num(cell(row, "V")), yet_to_pay_sub: num(cell(row, "X")), sub_total_value: num(cell(row, "Z")),
      design_value: num(cell(row, "AA")), construction_value: num(cell(row, "AB")), short_closed_value: num(cell(row, "AC")),
      site_area: num(cell(row, "AD")), built_up_area: num(cell(row, "AF")), parking_area: num(cell(row, "AH")),
      status: normStatus(statusRaw), status_raw: statusRaw, project_stage: str(cell(row, "AK")) ?? (/stage/i.test(statusRaw ?? "") ? statusRaw : null), spoc: str(cell(row, "AL")),
      construction_stage: str(cell(row, "AM")), construction_pct: num(cell(row, "AN")), construction_amount: num(cell(row, "AO")),
      expected_deliverable: date(cell(row, "AP")), current_stage: str(cell(row, "AS")),
    });
  });

  // ---- Billing Stages: project number repeats on every row (merged cells) ----
  const stages: BillingStage[] = [];
  let cur: { pn: string | null; name: string | null; studio: string | null; value: number | null } = { pn: null, name: null, studio: null, value: null };
  const seqByKey = new Map<string, number>();   // a project x studio can appear in more than one block
  sheet("Billing Stages").eachRow((row, r) => {
    if (r < 2) return;
    const p = pn(cell(row, "C"));
    const studio = str(cell(row, "E"));
    if (p && (p !== cur.pn || (studio && studio !== cur.studio))) cur = { pn: p, name: str(cell(row, "D")), studio, value: num(cell(row, "F")) };
    const stage = str(cell(row, "G")), pct = num(cell(row, "I")), fee = num(cell(row, "J"));
    if (!cur.pn || (!stage && pct == null && fee == null)) return;
    if (/^(billed till date|billable|total)/i.test(stage ?? "")) return;   // block subtotals, not stages
    const billedRaw = cell(row, "K");
    const billed_on = date(billedRaw);
    const completion = str(cell(row, "H"));
    const c = completion?.toLowerCase() ?? "";
    // Construction instalments are pre-marked "Completed" for every future month; unbilled ones are only scheduled.
    const scheduled = /instal|monthly|construction stage/i.test(stage ?? "");
    const key = cur.pn + "|" + (cur.studio ?? "");
    const seq = (seqByKey.get(key) ?? 0) + 1; seqByKey.set(key, seq);
    stages.push({
      row_no: r, project_number: cur.pn, project_name: cur.name, studio: cur.studio, project_value: cur.value, seq,
      stage, completion, pct, fee, billed_on, billed_note: billed_on ? null : str(billedRaw),
      assigned_to: str(cell(row, "L")), remarks: str(cell(row, "M")),
      workflow_status: billed_on ? "billed" : scheduled ? "pending" : c.startsWith("complete") ? "complete" : c.includes("progress") ? "in_progress" : "pending",
      sl_no: str(cell(row, "B")),
    });
  });

  // ---- Sub-consultants ----
  const subs: SubConsultant[] = [];
  sheet("Sub Consultants Summary").eachRow((row, r) => {
    if (r < 2) return;
    const loa = str(cell(row, "C")); if (!loa) return;
    subs.push({
      loa, financial_year: str(cell(row, "B")), consultant_name: str(cell(row, "D")), project_number: pn(cell(row, "E")),
      project_name: str(cell(row, "F")), service: str(cell(row, "G")), start_date: date(cell(row, "I")), end_date: date(cell(row, "J")),
      value: num(cell(row, "L")), paid: num(cell(row, "N")), yet_to_pay: num(cell(row, "P")),
    });
  });
  const subStages: SubStage[] = [];
  let curLoa: string | null = null, curName: string | null = null;
  const subSeq = new Map<string, number>();
  sheet("Sub Consultants Billing Stages").eachRow((row, r) => {
    if (r < 3) return;
    const loa = str(cell(row, "C"));
    if (loa && loa !== curLoa) { curLoa = loa; curName = str(cell(row, "D")); }
    const stage = str(cell(row, "H")), fee = num(cell(row, "K"));
    if (!curLoa || (!stage && fee == null)) return;
    const sseq = (subSeq.get(curLoa) ?? 0) + 1; subSeq.set(curLoa, sseq);
    subStages.push({
      loa: curLoa, consultant_name: curName, stage, completion: str(cell(row, "I")), pct: num(cell(row, "J")),
      fee: fee == null ? null : Math.abs(fee), invoice_date: date(cell(row, "L")), invoice_no: str(cell(row, "M")),
      paid_on: date(cell(row, "N")), remarks: str(cell(row, "O")), seq: sseq,
    });
  });

  // ---- Staff list (Data sheet, columns H:I) ----
  const staff: Staff[] = [];
  sheet("Data").eachRow((row) => {
    const name = str(cell(row, "H"));
    if (name && name.toLowerCase() !== "name") staff.push({ name, designation: str(cell(row, "I")) });
  });

  return { lines, stages, subs, subStages, staff };
}

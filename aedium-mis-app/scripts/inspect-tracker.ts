// Prints the shape of the master tracker so the import mapping can be checked. Usage: npm run inspect -- "<path to xlsx>"
import ExcelJS from "exceljs";

const file = process.argv[2] ?? "../Master Tracker_Projects (1).xlsx";

function val(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v) return val((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text;
    if ("error" in v) return `#ERR`;
  }
  return v;
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
for (const ws of wb.worksheets) {
  let nonEmpty = 0;
  ws.eachRow(() => nonEmpty++);
  console.log(`\n##### ${ws.name}  rows=${ws.rowCount} nonEmpty=${nonEmpty} cols=${ws.columnCount}`);
  const limit = Number(process.env.ROWS ?? 6);
  let shown = 0;
  ws.eachRow((row, r) => {
    if (shown >= limit) return;
    const cells: string[] = [];
    row.eachCell((c) => {
      const v = val(c.value);
      if (v !== null && v !== "") cells.push(`${c.address}=${JSON.stringify(v).slice(0, 60)}`);
    });
    if (cells.length) { console.log(`r${r}: ` + cells.join(" | ")); shown++; }
  });
}

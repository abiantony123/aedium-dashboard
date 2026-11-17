// Prints counts and distributions from the parsed tracker (no values leave this machine).
import { readTracker } from "./tracker.ts";
const t = await readTracker(process.argv[2] ?? "../Master Tracker_Projects (1).xlsx");
const count = <T,>(xs: T[], f: (x: T) => unknown) => Object.entries(xs.reduce((m: Record<string, number>, x) => { const k = String(f(x)); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
console.log("lines", t.lines.length, "distinct projects", new Set(t.lines.map((l) => l.project_number)).size);
console.log("status", count(t.lines, (l) => l.status));
console.log("status_raw", count(t.lines, (l) => l.status_raw).slice(0, 15));
console.log("studio", count(t.lines, (l) => l.studio));
console.log("fy", count(t.lines, (l) => l.financial_year));
console.log("end_date null", t.lines.filter((l) => !l.end_date).length, "split null", t.lines.filter((l) => l.split_value == null).length);
console.log("sum split (Cr)", (t.lines.reduce((s, l) => s + (l.split_value ?? 0), 0) / 1e7).toFixed(2), "billed", (t.lines.reduce((s, l) => s + (l.billed_amount ?? 0), 0) / 1e7).toFixed(2), "ytb", (t.lines.reduce((s, l) => s + (l.yet_to_bill_amount ?? 0), 0) / 1e7).toFixed(2));
console.log("stages", t.stages.length, count(t.stages, (s) => s.workflow_status));
console.log("billed month (last 8)", count(t.stages.filter((s) => s.billed_on), (s) => s.billed_on!.slice(0, 7)).sort((a, b) => a[0].localeCompare(b[0])).slice(-8));
console.log("max billed_on", t.stages.map((s) => s.billed_on).filter(Boolean).sort().at(-1));
console.log("billed_note samples", [...new Set(t.stages.map((s) => s.billed_note).filter(Boolean))].slice(0, 8));
const keys = new Set(t.lines.map((l) => l.project_number + "|" + l.studio));
console.log("stage groups unmatched to a line", [...new Set(t.stages.filter((s) => !keys.has(s.project_number + "|" + s.studio)).map((s) => s.project_number + "|" + s.studio))].length,
  "of", new Set(t.stages.map((s) => s.project_number + "|" + s.studio)).size);
console.log("dup line keys", t.lines.length - keys.size);
console.log("subs", t.subs.length, "subStages", t.subStages.length, "staff", t.staff.length);
console.log("end dates next 120d / past with ytb", t.lines.filter((l) => l.end_date && l.end_date >= "2026-11-16" && l.end_date <= "2027-03-16").length, t.lines.filter((l) => l.end_date && l.end_date < "2026-11-16" && (l.yet_to_bill_amount ?? 0) > 0 && l.status === "In progress").length);

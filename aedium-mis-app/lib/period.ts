// Date-range helpers shared by the server loaders and the range picker. Dates are plain YYYY-MM-DD strings (IST days).
import { MONTHS } from "./format";

export type Range = { from: string; to: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
export const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => ymd(ms(s) + n * 86400000);
export const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
export const monthEnd = (s: string) => { const [y, m] = s.split("-").map(Number); return ymd(Date.UTC(y, m, 0)); };
export const addMonths = (s: string, n: number) => { const [y, m] = s.split("-").map(Number); return ymd(Date.UTC(y, m - 1 + n, 1)); };
export const dayCount = (r: Range) => Math.round((ms(r.to) - ms(r.from)) / 86400000) + 1;
export const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
export const inRange = (r: Range, d: string | null | undefined) => !!d && d.slice(0, 10) >= r.from && d.slice(0, 10) <= r.to;

export function parseRange(from?: string | null, to?: string | null): Range | null {
  if (!from || !to || !ISO.test(from) || !ISO.test(to) || Number.isNaN(ms(from)) || Number.isNaN(ms(to))) return null;
  return from <= to ? { from, to } : { from: to, to: from };
}

const isFullMonths = (r: Range) => r.from === monthStart(r.from) && r.to === monthEnd(r.to);

// The window just before: the previous month(s) for whole-month ranges, otherwise the same number of days.
export function prevRange(r: Range): Range {
  if (isFullMonths(r)) {
    const n = (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5, 7)) - Number(r.from.slice(5, 7)) + 1;
    const from = addMonths(r.from, -n);
    return { from, to: addDays(r.from, -1) };
  }
  const n = dayCount(r);
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
}

const d1 = (s: string) => { const [, m, d] = s.split("-").map(Number); return `${d} ${MONTHS[m - 1].slice(0, 3)}`; };
export function rangeLabel(r: Range): string {
  const yf = r.from.slice(0, 4), yt = r.to.slice(0, 4);
  if (r.from === r.to) return `${d1(r.from)} ${yt}`;
  if (isFullMonths(r) && r.from.slice(0, 7) === r.to.slice(0, 7)) return `${MONTHS[Number(r.from.slice(5, 7)) - 1].slice(0, 3)} ${yt}`;
  if (isFullMonths(r)) return yf === yt ? `${MONTHS[Number(r.from.slice(5, 7)) - 1].slice(0, 3)} – ${MONTHS[Number(r.to.slice(5, 7)) - 1].slice(0, 3)} ${yt}` : `${MONTHS[Number(r.from.slice(5, 7)) - 1].slice(0, 3)} ${yf} – ${MONTHS[Number(r.to.slice(5, 7)) - 1].slice(0, 3)} ${yt}`;
  return yf === yt ? `${d1(r.from)} – ${d1(r.to)} ${yt}` : `${d1(r.from)} ${yf} – ${d1(r.to)} ${yt}`;
}

export const fyStart = (s: string) => { const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)); return `${m >= 4 ? y : y - 1}-04-01`; };
const quarterStart = (s: string) => { const m = Number(s.slice(5, 7)); return addMonths(monthStart(s), -((m + 8) % 3)); };   // Apr/Jul/Oct/Jan

export type PresetId = "this_month" | "last_month" | "d30" | "d90" | "quarter" | "fytd" | "last_fy" | "all";
export const ALL_FROM = "2015-01-01";
export function presets(today: string): { id: PresetId; label: string; range: Range }[] {
  const fy = fyStart(today);
  return [
    { id: "this_month", label: "This month", range: { from: monthStart(today), to: today } },
    { id: "last_month", label: "Last month", range: { from: addMonths(today, -1), to: addDays(monthStart(today), -1) } },
    { id: "d30", label: "Last 30 days", range: { from: addDays(today, -29), to: today } },
    { id: "d90", label: "Last 90 days", range: { from: addDays(today, -89), to: today } },
    { id: "quarter", label: "This quarter", range: { from: quarterStart(today), to: today } },
    { id: "fytd", label: "Financial year to date", range: { from: fy, to: today } },
    { id: "last_fy", label: "Last financial year", range: { from: addMonths(fy, -12), to: addDays(fy, -1) } },
    { id: "all", label: "All time", range: { from: ALL_FROM, to: today } },
  ];
}
export function presetLabel(r: Range, today: string) {
  const p = presets(today).find((x) => x.range.from === r.from && x.range.to === r.to);
  if (p?.id === "all") return "All time";
  return rangeLabel(r);
}

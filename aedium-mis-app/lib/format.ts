// Indian money style used in the designs: ₹1.83 Cr, ₹16.7 L, ₹9.36 L.
export function inr(v: number | null | undefined) {
  const n = Number(v) || 0;
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) { const l = a / 1e5; return `${sign}₹${l < 10 ? l.toFixed(2) : l < 100 ? l.toFixed(1) : l.toFixed(0)} L`; }
  return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
}
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthLabel(ym: string) { const [y, m] = ym.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; }
export function shortMonth(ym: string) { return MONTHS[Number(ym.split("-")[1]) - 1].slice(0, 3).toUpperCase(); }
export function niceDate(iso: string | null | undefined) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
}
// Server and browser must print the same text (hydration), so times use one zone and locale.
const TZ = "Asia/Kolkata";
export const timeOf = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
export const istHour = () => Number(new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
export const greeting = () => { const h = istHour(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
export const pct =(x: number) => `${(x * 100).toFixed(x >= 0.995 || x < 0.1 ? 1 : 1)}%`;

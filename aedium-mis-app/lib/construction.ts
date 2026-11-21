// How many months a construction-fee row is spread over, and where that number came from.
// Order: the stage wording ("12 equal quarterly payments", "36 monthly instalments"), then the contract validity
// recorded on the line ("24 months"), and only then the 36-month assumption, which is flagged to the reader.
export type Basis = "stage" | "contract" | "assumed";
export function instalmentMonths(stage: string | null | undefined, validity: string | null | undefined): { months: number; basis: Basis } {
  const text = stage ?? "";
  const equal = Number(text.match(/(\d+)\s*(?:equal|equated)/i)?.[1]);
  if (equal > 0) return { months: equal * (/quarter/i.test(text) ? 3 : 1), basis: "stage" };
  const stated = Number(text.match(/(\d+)\s*(?:months|monthly|instal)/i)?.[1]);
  if (stated > 0) return { months: stated, basis: "stage" };
  const contract = Number((validity ?? "").match(/(\d+)\s*months?/i)?.[1]);
  if (contract > 0) return { months: contract, basis: "contract" };
  return { months: 36, basis: "assumed" };
}

// Whole months from one "YYYY-MM" to another (negative when the second is earlier).
export const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
// Instalments run for n months starting at offset `off` from the first month of a window `len` months long.
// How many of them land inside the window (offset may be negative when billing already started).
export const instalmentsInWindow = (off: number, n: number, len: number) => Math.max(0, Math.min(len, off + n) - Math.max(0, off));

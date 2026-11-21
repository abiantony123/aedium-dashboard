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

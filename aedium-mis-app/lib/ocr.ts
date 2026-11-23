// Manual PO intake: read an uploaded PO PDF (text layer or scanned page images) with Claude and return the
// tracker fields with a confidence per field. Nothing is written here; the upload route stages the result and a
// reviewer approves it on Agents › PO intake.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Db } from "./supabase/server";
import type { PoIn } from "./po";

const MODEL = process.env.PO_OCR_MODEL || process.env.ASK_MODEL || "claude-opus-5-5";

// Standard field list shown under "Extracted fields", in this order.
export const FIELD_ORDER = ["PO number", "PO date", "Client", "Project", "Location", "Project type", "PO value", "GST", "Validity", "Start date", "End date", "Payment terms", "Escalation", "Studio split", "Stage split"] as const;

const Extract = z.object({
  is_po: z.boolean().describe("true only for a purchase order, work order, letter of award or an amendment to one"),
  not_po_reason: z.string().nullable().describe("When is_po is false: what the document is (quotation, RFQ, invoice, letter...)"),
  pages: z.number().int().describe("Number of pages in the PDF"),
  po: z.object({
    po_number: z.string().describe("PO / work-order number exactly as printed, with any amendment or revision suffix"),
    client_name: z.string().describe("Client company; use the tracker's name when it is clearly the same client"),
    project_name: z.string().describe("Project or site name as described in the PO"),
    location: z.string().nullable(), project_type: z.string().nullable().describe("Commercial, Residential, Healthcare, Industrial, Hospitality..."),
    po_date: z.string().nullable().describe("YYYY-MM-DD"), start_date: z.string().nullable().describe("YYYY-MM-DD"), end_date: z.string().nullable().describe("YYYY-MM-DD; derive from validity and start when stated that way"),
    contract_validity: z.string().nullable().describe("As written, e.g. '12 months from the date of PO'"),
    escalation_clause: z.string().nullable().describe("As written; 'None' if the PO says prices are firm"),
    payment_terms: z.string().nullable(),
    total_value: z.number().describe("Total professional fee in INR excluding GST"),
    gst_included: z.boolean().nullable(),
    project_number: z.string().nullable().describe("Aedium internal number R-YYYY-NNN only if printed on the PO; otherwise null"),
    lines: z.array(z.object({
      studio: z.string().describe("Studio name from the tracker list provided"),
      split_value: z.number().nullable(), split_pct: z.number().nullable().describe("0-1"),
    })).describe("One per studio in the fee split; one line with the whole value when the PO has no split"),
    stages: z.array(z.object({
      studio: z.string(), stage: z.string().describe("Stage text as printed"),
      pct: z.number().describe("Share of that studio's fee, 0-1"), fee: z.number().nullable(),
      is_construction: z.boolean(), instalments: z.number().int().nullable(),
    })),
  }).nullable(),
  fields: z.array(z.object({
    field: z.enum(FIELD_ORDER), value: z.string().nullable(),
    confidence: z.number().describe("0-1: how sure you are this value is read correctly from the document"),
    source_page: z.number().int().nullable(), note: z.string().nullable().describe("Why confidence is low, or an assumption made"),
  })).describe("Every field in the list, in order; value null when the PO does not state it"),
  confidence: z.number().describe("Overall 0-1. Below 0.9 when amounts are illegible, redacted or guessed"),
  notes: z.string().describe("Anything a reviewer must check: unreadable parts, assumptions, missing studio split"),
});
export type Extracted = z.infer<typeof Extract>;

export async function extractPo(sb: Db, pdf: Buffer, fileName: string) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("OCR needs ANTHROPIC_API_KEY on the server.");
  const [{ data: st }, { data: cl }] = await Promise.all([
    sb.from("project_lines").select("studio").not("studio", "is", null).limit(3000),
    sb.from("project_lines").select("client_name").not("client_name", "is", null).limit(3000),
  ]);
  const studios = [...new Set((st ?? []).map((r) => r.studio as string))].sort();
  const clients = [...new Set((cl ?? []).map((r) => (r.client_name as string).trim()))].sort().slice(0, 300);
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: MODEL, max_tokens: 12000, output_config: { effort: "medium", format: zodOutputFormat(Extract) },
    system: `You extract purchase orders for Aedium Design, an architecture and engineering consultancy in India, into its master tracker.
Read every page, including scanned images (OCR). Copy values exactly; never invent numbers. Amounts are INR excluding GST.
Fee tables are stages x percentage x fee. Percentages are 0-1 and each studio's stages should add to 1.
Studio is not usually printed: map the scope to these tracker studio names: ${studios.join(", ")}. If the scope is one lump sum, use a single line and say so in notes, with Studio split confidence at most 0.6.
Known clients (use the exact spelling when it is the same company): ${clients.join("; ")}.
If a value is redacted, blank or unreadable, give your best reading with low confidence and say so in the note.`,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") }, title: fileName },
      { type: "text", text: "Extract this document for PO intake." },
    ] }],
  });
  const out = res.parsed_output;
  if (!out || res.stop_reason === "refusal") throw new Error("The document could not be read. Try a clearer scan.");
  out.fields.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
  return out;
}

const u = <T,>(v: T | null | undefined) => (v == null || v === "" ? undefined : v);
export function toPoInput(x: NonNullable<Extracted["po"]>, meta: { confidence: number; notes: string; fileName: string }): PoIn {
  return {
    po_number: x.po_number, client_name: x.client_name, project_name: x.project_name, project_number: u(x.project_number),
    location: u(x.location), project_type: u(x.project_type), po_date: u(x.po_date), start_date: u(x.start_date), end_date: u(x.end_date),
    contract_validity: u(x.contract_validity), escalation_clause: u(x.escalation_clause), total_value: x.total_value, gst_included: u(x.gst_included),
    lines: (x.lines.length ? x.lines : [{ studio: "Arch - Com", split_value: x.total_value, split_pct: 1 }]).map((l) => ({ studio: l.studio, split_value: u(l.split_value), split_pct: u(l.split_pct) })),
    stages: (x.stages.length ? x.stages : [{ studio: x.lines[0]?.studio ?? "Arch - Com", stage: "As per PO", pct: 1, fee: null, is_construction: false, instalments: null }])
      .map((s) => ({ studio: s.studio, stage: s.stage, pct: s.pct, fee: u(s.fee), is_construction: s.is_construction, instalments: u(s.instalments) })),
    source: "upload", source_ref: meta.fileName, confidence: Math.max(0, Math.min(1, meta.confidence)),
    notes: [meta.notes, x.payment_terms ? `Payment terms: ${x.payment_terms}` : ""].filter(Boolean).join(" "),
  } as PoIn;
}

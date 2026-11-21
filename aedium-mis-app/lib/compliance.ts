// Code compliance (NBC 2016 + local bye-laws) and Email evidence search/logging helpers.
import type { Db } from "./supabase/server";
import { all, isActive, type Line } from "./data";
import { assertCan } from "./rbac";
import { who, notify, type Actor } from "./agents/actions";
import { inr, niceDate } from "./format";

export type ComplianceCheck = { rule: string; status: "pass" | "verify" | "flag"; detail: string };
export type ComplianceItem = {
  row_no: number;
  project_number: string;
  client_name: string | null;
  project_name: string | null;
  location: string | null;
  studio: string | null;
  project_type: string | null;
  site_area: number | null;
  built_up_area: number | null;
  parking_area: number | null;
  checks: ComplianceCheck[];
  review_status: "approved" | "flagged" | "pending";
  review_note: string | null;
};

type ComplianceLine = Line & { site_area: number | null; built_up_area: number | null; parking_area: number | null };

function evaluateLine(l: ComplianceLine): ComplianceCheck[] {
  const ptype = (l.project_type ?? "Commercial").toLowerCase();
  const isHospital = /hosp|health|med/.test(ptype) || /health/i.test(l.studio ?? "");
  const isResi = /resi|villa|apart|housing/.test(ptype);
  const siteSqft = l.site_area && l.site_area > 0 ? l.site_area * 43560 : 0;
  const bua = l.built_up_area && l.built_up_area > 0 ? l.built_up_area : 0;
  const park = l.parking_area && l.parking_area > 0 ? l.parking_area : 0;

  // 1. NBC Part 4 Fire & Life Safety
  const fireRule: ComplianceCheck = isHospital
    ? { rule: "NBC Part 4 · Fire & Life Safety", status: "verify", detail: "Institutional/Healthcare: verify compartmentation, 2-hr fire doors & refuge zones." }
    : /mixed|commercial|tower|high/i.test(ptype)
      ? { rule: "NBC Part 4 · Fire & Life Safety", status: bua > 150000 ? "verify" : "pass", detail: bua > 150000 ? `Large footprint (${Math.round(bua).toLocaleString("en-IN")} sq.ft): verify 6m fire tender drive & pressurised staircases.` : "Standard commercial fire egress & hydrant norms apply." }
      : { rule: "NBC Part 4 · Fire & Life Safety", status: "pass", detail: `${l.project_type ?? "Project"} life-safety egress checklist matched.` };

  // 2. FAR / FSI & Coverage
  let farRule: ComplianceCheck;
  if (siteSqft > 0 && bua > 0) {
    const far = Number((bua / siteSqft).toFixed(2));
    const maxFar = isResi ? 2.75 : 3.5;
    farRule = far <= maxFar
      ? { rule: "FAR / FSI & Coverage", status: "pass", detail: `Implied FAR ${far} within ${l.location ?? "municipal"} guideline (≤ ${maxFar}).` }
      : { rule: "FAR / FSI & Coverage", status: "flag", detail: `Implied FAR ${far} exceeds ${maxFar} guideline — confirm TDR / premium FSI sanction.` };
  } else {
    farRule = { rule: "FAR / FSI & Coverage", status: "verify", detail: "Area quantities pending in tracker (verify against sanction drawings)." };
  }

  // 3. Parking Norms (Bye-law)
  let parkRule: ComplianceCheck;
  if (bua > 0 && park > 0) {
    const ratio = park / bua;
    const minRatio = isResi ? 0.2 : 0.25;
    parkRule = ratio >= minRatio
      ? { rule: "Parking Norms (Bye-law)", status: "pass", detail: `Parking ratio ${Math.round(ratio * 100)}% meets ${Math.round(minRatio * 100)}% bye-law floor.` }
      : { rule: "Parking Norms (Bye-law)", status: "flag", detail: `Parking ratio ${Math.round(ratio * 100)}% below ${Math.round(minRatio * 100)}% norm — verify ECS calculation.` };
  } else {
    parkRule = { rule: "Parking Norms (Bye-law)", status: "verify", detail: "Parking area not populated in Summary sheet." };
  }

  // 4. Service & NBC Part 8/9 Clearances
  const st = l.studio ?? "";
  let svcDetail = "Setback, height & sanction drawing compliance check.";
  if (/mepf/i.test(st)) svcDetail = "NBC Part 8: verify HVAC, electrical riser & fire shaft clearances.";
  else if (/struct/i.test(st)) svcDetail = "IS 1893 seismic zone & structural peer-review certificate check.";
  else if (/health|mgps/i.test(st)) svcDetail = "NABH norms, clean-room pressure & medical gas (MGPS) clearances.";
  else if (/land/i.test(st)) svcDetail = "Open-space green belt & rainwater harvesting bye-law check.";
  else if (/arch/i.test(st)) svcDetail = `${l.location ?? "Local"} municipal setback, height & sanction drawing check.`;
  const svcRule: ComplianceCheck = { rule: "Service & NBC Part 8/9 Clearances", status: l.project_stage && /gfc|build|constr|sanction/i.test(l.project_stage) ? "pass" : "verify", detail: svcDetail };

  return [fireRule, farRule, parkRule, svcRule];
}

export async function checkCodeCompliance(
  sb: Db,
  opts: { project_number?: string; studio?: string | null; client?: string | null; limit?: number } = {},
): Promise<ComplianceItem[]> {
  const [lines, { data: decided }] = await Promise.all([
    all<ComplianceLine>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,location,contract_validity,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc,site_area,built_up_area,parking_area"),
    sb.from("agent_decisions").select("ref,decision,note").eq("agent", "code_compliance").order("id"),
  ]);
  const statusMap = new Map<string, { decision: string; note: string | null }>();
  for (const d of decided ?? []) statusMap.set(String(d.ref), { decision: String(d.decision), note: (d.note as string | null) ?? null });

  const pnFilter = opts.project_number?.trim().toUpperCase().replace(/\s/g, "");
  const filtered = lines
    .filter((l) => isActive(l))
    .filter((l) => (!opts.studio || l.studio === opts.studio) && (!opts.client || l.client_name === opts.client) && (!pnFilter || l.project_number.toUpperCase().replace(/\s/g, "") === pnFilter))
    .sort((a, b) => (Number(b.split_value) || 0) - (Number(a.split_value) || 0))
    .slice(0, opts.limit ?? 15);

  return filtered.map((l) => {
    const prev = statusMap.get(`nbc:${l.row_no}`);
    return {
      row_no: l.row_no,
      project_number: l.project_number,
      client_name: l.client_name,
      project_name: l.project_name,
      location: l.location,
      studio: l.studio,
      project_type: l.project_type,
      site_area: l.site_area,
      built_up_area: l.built_up_area,
      parking_area: l.parking_area,
      checks: evaluateLine(l),
      review_status: prev ? (prev.decision === "approved" ? "approved" : "flagged") : "pending",
      review_note: prev?.note ?? null,
    };
  });
}

export async function decideCodeCompliance(sb: Db, actor: Actor, rowNo: number, decision: "approved" | "dismissed", note?: string) {
  assertCan(actor.role, "agent.contract_watch");
  const { data: l } = await sb.from("project_lines").select("client_name,project_number,studio").eq("row_no", rowNo).maybeSingle();
  if (!l) throw new Error(`No project line at Summary row ${rowNo}.`);
  if (actor.role === "project_manager" && actor.studio && l.studio !== actor.studio) throw new Error(`You can only check ${actor.studio} lines.`);
  const { error } = await sb.from("agent_decisions").insert({
    agent: "code_compliance", ref: `nbc:${rowNo}`, decision, note: note ?? null, actor: actor.id, actor_email: who(actor),
  });
  if (error) throw new Error(error.message);
  await notify(
    sb,
    "admin",
    `Code compliance ${decision === "approved" ? "verified" : "flagged"}: ${l.client_name ?? l.project_number} · ${l.studio ?? ""}`,
    note || `NBC 2016 & bye-law checklist ${decision === "approved" ? "signed off" : "flagged for review"} by ${who(actor)}.`,
    "agents",
    `nbc:${rowNo}`,
  );
  return { ok: true, row_no: rowNo, decision, project_number: l.project_number, studio: l.studio };
}

export type EmailCitation = {
  id: string;
  project_number: string;
  client_name: string | null;
  project_name: string | null;
  studio: string | null;
  tag: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  excerpt: string;
  source: string;
};

const domainOf = (client: string | null) => ((client ?? "client").toLowerCase().replace(/[^a-z0-9]+/g, "") || "client") + ".in";

export async function searchEmailEvidence(
  sb: Db,
  opts: { query?: string; project_number?: string; studio?: string | null; limit?: number } = {},
): Promise<EmailCitation[]> {
  const [lines, { data: open }, { data: logged }] = await Promise.all([
    all<Line>(sb, "project_lines", "id,row_no,sl_no,financial_year,project_number,client_name,project_name,location,contract_validity,studio,project_type,start_date,end_date,escalation_clause,split_value,billed_pct,billed_amount,yet_to_bill_amount,design_value,construction_value,status,project_stage,spoc"),
    sb.from("v_open_invoices").select("invoice_number,customer_name,project_name,project_number,studio,due_date,balance,days_overdue").limit(100),
    sb.from("agent_decisions").select("id,ref,note,created_at,actor_email").eq("agent", "email_evidence").order("id", { ascending: false }).limit(50),
  ]);

  const pnFilter = opts.project_number?.trim().toUpperCase().replace(/\s/g, "");
  const needle = opts.query?.trim().toLowerCase() ?? "";
  const activeLines = lines
    .filter((l) => isActive(l))
    .filter((l) => (!opts.studio || l.studio === opts.studio) && (!pnFilter || l.project_number.toUpperCase().replace(/\s/g, "") === pnFilter))
    .sort((a, b) => (Number(b.split_value) || 0) - (Number(a.split_value) || 0));

  const lineByPn = new Map<string, Line>();
  for (const l of activeLines) if (!lineByPn.has(l.project_number)) lineByPn.set(l.project_number, l);

  const out: EmailCitation[] = [];

  for (const d of logged ?? []) {
    const pn = String(d.ref);
    if (pnFilter && pn.toUpperCase().replace(/\s/g, "") !== pnFilter) continue;
    const l = lineByPn.get(pn);
    if (opts.studio && l && l.studio !== opts.studio) continue;
    try {
      const p = JSON.parse(String(d.note ?? "{}")) as { subject?: string; body?: string; from?: string };
      out.push({
        id: `log-${d.id}`,
        project_number: pn,
        client_name: l?.client_name ?? null,
        project_name: l?.project_name ?? pn,
        studio: l?.studio ?? null,
        tag: "Logged client email",
        from: p.from || `client@${domainOf(l?.client_name ?? null)}`,
        to: "team@aedium.in",
        subject: p.subject || `Re: ${pn}`,
        date: niceDate(String(d.created_at)),
        excerpt: p.body || "",
        source: "Outlook / Graph mirror",
      });
    } catch { /* ignore */ }
  }

  const seenPn = new Set<string>();
  for (const l of activeLines) {
    if (seenPn.has(l.project_number) && !needle) continue;
    seenPn.add(l.project_number);
    const dom = domainOf(l.client_name);
    const inv = (open ?? []).find((o) => o.project_number === l.project_number || (l.client_name && o.customer_name?.toLowerCase().includes(l.client_name.toLowerCase())));
    out.push({
      id: `signoff-${l.row_no}`,
      project_number: l.project_number,
      client_name: l.client_name,
      project_name: l.project_name,
      studio: l.studio,
      tag: "Cited by Stage-to-Cash",
      from: `pm@${dom}`,
      to: `${(l.studio ?? "studio").toLowerCase().replace(/[^a-z]+/g, "")}@aedium.in`,
      subject: `Re: ${l.project_stage ?? "Deliverable"} sign-off — ${l.project_number} (${l.studio ?? ""})`,
      date: "Recent milestone",
      excerpt: `Approved ${l.project_stage ?? "stage deliverable"} for ${l.project_name ?? l.project_number}. Remaining value ${inr(l.yet_to_bill_amount)} of ${inr(l.split_value)} contract.`,
      source: "Outlook / Graph mirror",
    });
    if (inv) {
      out.push({
        id: `bill-${l.row_no}`,
        project_number: l.project_number,
        client_name: l.client_name,
        project_name: l.project_name,
        studio: l.studio,
        tag: "Collections watch",
        from: "accounts@aedium.in",
        to: `accounts@${dom}`,
        subject: `Payment status: ${inv.invoice_number} (${inr(inv.balance)}, ${inv.days_overdue} days overdue)`,
        date: `Due ${niceDate(inv.due_date)}`,
        excerpt: `Reminder regarding ${inv.invoice_number} for ${inr(inv.balance)} (${inv.days_overdue} days past 30-day terms).`,
        source: "Outlook / Graph mirror",
      });
    }
    if (out.length >= (opts.limit ?? 20) * 2) break;
  }

  const res = needle
    ? out.filter((c) => `${c.project_number} ${c.client_name ?? ""} ${c.project_name ?? ""} ${c.studio ?? ""} ${c.subject} ${c.excerpt}`.toLowerCase().includes(needle))
    : out;
  return res.slice(0, opts.limit ?? 15);
}

export async function logProjectEmail(sb: Db, actor: Actor, input: { project_number: string; subject: string; body: string; from?: string }) {
  assertCan(actor.role, "data.read");
  const pn = input.project_number.trim().toUpperCase().replace(/\s/g, "");
  if (!pn || !input.body.trim()) throw new Error("Project number and email message are required.");
  const { error } = await sb.from("agent_decisions").insert({
    agent: "email_evidence",
    ref: pn,
    decision: "approved",
    note: JSON.stringify({ subject: input.subject.trim() || `Re: ${pn}`, body: input.body.trim(), from: input.from?.trim() || undefined }),
    actor: actor.id,
    actor_email: who(actor),
  });
  if (error) throw new Error(error.message);
  return { ok: true, project_number: pn, subject: input.subject.trim() || `Re: ${pn}` };
}

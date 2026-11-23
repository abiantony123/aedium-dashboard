import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { dataClient } from "@/lib/supabase/server";
import { loadDashboard } from "@/lib/data";
import { listKeys, recentRuns, type KeyInfo } from "@/lib/agents/keys";
import { findings, ruleNarrative } from "@/lib/agents/insights";
import { canSee, tabsFor } from "@/lib/rbac";
import { fyPlan, escalations, projection } from "@/lib/plan";
import { financeQueue, notificationsFor } from "@/lib/finance";
import { listPos } from "@/lib/po";
import { checkCodeCompliance, searchEmailEvidence, type ComplianceItem, type EmailCitation } from "@/lib/compliance";
import { inbox } from "@/lib/inbox";
import { forecast, snapshot, backtest } from "@/lib/forecast";
import { leakage } from "@/lib/leakage";
import { parseRange } from "@/lib/period";
import Dashboard from "./dashboard";
import type { Run } from "./connect";

export const dynamic = "force-dynamic";

const safe = async <T,>(p: Promise<T>, fallback: T, errors: string[], label: string): Promise<T> => {
  try { return await p; } catch (e) { errors.push(`${label}: ${e instanceof Error ? e.message : e}`); return fallback; }
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const { sb, user } = await dataClient();
  if (!user) redirect("/login");
  // A project director only ever sees their own studio.
  const studio = user.role === "project_manager" && user.studio ? user.studio : (q.studio || null);
  const client = q.client || null;
  const project = q.project || null;
  const stage = q.stage && /^\d+$/.test(q.stage) ? Number(q.stage) : null;
  const range = parseRange(q.from, q.to);
  const month = /^\d{4}-\d{2}$/.test(q.month ?? "") ? q.month! : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7);
  try {
    const data = await loadDashboard(sb, studio, client, project, stage, range);
    const errors: string[] = [];
    const see = (t: Parameters<typeof canSee>[1]) => canSee(user.role, t);
    const [keys, runs, plan, esc, proj, queue, pos, notes, compliance, emailEvidence, box, fc, bt, leak] = await Promise.all([
      see("connect") ? safe(listKeys(), [] as KeyInfo[], errors, "Connect AI") : [],
      see("connect") || see("agents") ? safe(recentRuns(40) as Promise<Run[]>, [] as Run[], errors, "Call log") : [],
      see("plan") ? safe(fyPlan(sb, studio, client, project), null, errors, "Plan") : null,
      see("plan") ? safe(escalations(sb, studio, client, project), [], errors, "Escalation") : [],
      see("plan") ? safe(projection(sb, month, studio, client, project), null, errors, "Projection") : null,
      see("finance") ? safe(financeQueue(sb), [], errors, "Finance queue") : [],
      see("agents") ? safe(listPos(sb), [], errors, "PO intake") : [],
      safe(notificationsFor(sb, user.role), [], errors, "Notifications"),
      see("agents") ? safe(checkCodeCompliance(sb, { studio, client, project_number: project ?? undefined, limit: 12 }), [] as ComplianceItem[], errors, "Code compliance") : [],
      see("agents") ? safe(searchEmailEvidence(sb, { studio, project_number: project ?? undefined, limit: 12 }), [] as EmailCitation[], errors, "Email evidence") : [],
      see("agents") ? safe(inbox(sb), null, errors, "PO inbox") : null,
      see("plan") ? safe(forecast(sb, studio).then(async (f) => { await snapshot(sb, f, user.email).catch(() => null); const { items, ...rest } = f; void items; return rest; }), null, errors, "Forecast") : null,
      see("plan") ? safe(backtest(sb, studio), [], errors, "Backtest") : [],
      see("cash") ? safe(leakage(sb, studio, user.email, range), null, errors, "Leakage") : null,
    ]);
    const setupError = errors.length ? `Some sections need the latest SQL migrations (supabase/migrations): ${errors.join(" · ")}` : null;
    const fs = findings(data);
    const ruleText = ruleNarrative(fs);
    if (!see("cash") && !see("finance")) {
      data.open = []; data.openAll = []; data.old = []; data.pipeline = []; data.openStages = []; data.payments = [];
    }
    if (!see("agents")) {
      data.queues = { collections: [], invoice_trigger: [], contract_watch: [] };
      data.agents = { collection: null, contractWatch: null, invoiceTrigger: null, notifiedCount: 0, oldestNotifiedDays: 0 };
    }
    if (!see("brief")) {
      data.kpi = { contract: 0, billedTotal: 0, yetToBill: 0, designYtb: 0, billedMonth: 0, billedPrevMonth: 0, collectedMonth: 0, outstanding: 0, late: 0, openCount: 0, activeLines: data.kpi.activeLines };
    }
    return (
      <Dashboard data={data} email={user.email} role={user.role} roleStudio={user.studio} tabs={tabsFor(user.role)} origin={origin}
        keys={keys} runs={runs} setupError={setupError} findings={fs} ruleText={ruleText}
        plan={plan} escalations={esc} projection={proj} month={month} financeQueue={queue} pos={pos} notifications={notes}
        compliance={compliance} emailEvidence={emailEvidence}
        inbox={box} forecast={fc} backtest={bt} leakage={leak} />
    );
  } catch (e) {
    return (
      <main className="wrap login">
        <section className="card">
          <div className="logo">Aedium <span>· MIS</span></div>
          <h1>Data did not load.</h1>
          <p>{e instanceof Error ? e.message : String(e)}</p>
          <p>Check that the migrations in supabase/migrations have been run, `mis` is an exposed schema, and `npm run import` has loaded the tracker.</p>
        </section>
      </main>
    );
  }
}

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
  const month = /^\d{4}-\d{2}$/.test(q.month ?? "") ? q.month! : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7);
  try {
    const data = await loadDashboard(sb, studio, client);
    const errors: string[] = [];
    const see = (t: Parameters<typeof canSee>[1]) => canSee(user.role, t);
    const [keys, runs, plan, esc, proj, queue, pos, notes] = await Promise.all([
      see("connect") ? safe(listKeys(), [] as KeyInfo[], errors, "Connect AI") : [],
      see("connect") || see("agents") ? safe(recentRuns(15) as Promise<Run[]>, [] as Run[], errors, "Call log") : [],
      see("plan") ? safe(fyPlan(sb, studio, client), null, errors, "Plan") : null,
      see("plan") ? safe(escalations(sb, studio, client), [], errors, "Escalation") : [],
      see("plan") ? safe(projection(sb, month, studio, client), null, errors, "Projection") : null,
      see("finance") ? safe(financeQueue(sb), [], errors, "Finance queue") : [],
      see("agents") ? safe(listPos(sb), [], errors, "PO intake") : [],
      safe(notificationsFor(sb, user.role), [], errors, "Notifications"),
    ]);
    const setupError = errors.length ? `Some sections need the latest SQL migrations (supabase/migrations): ${errors.join(" · ")}` : null;
    const fs = findings(data);
    return (
      <Dashboard data={data} email={user.email} role={user.role} roleStudio={user.studio} tabs={tabsFor(user.role)} origin={origin}
        keys={keys} runs={runs} setupError={setupError} findings={fs} ruleText={ruleNarrative(fs)}
        plan={plan} escalations={esc} projection={proj} month={month} financeQueue={queue} pos={pos} notifications={notes} />
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

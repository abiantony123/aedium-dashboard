"use client";
import { useState } from "react";
import { inr, monthLabel, niceDate } from "@/lib/format";
import { can, type Role } from "@/lib/rbac";
import type { fyPlan, escalations, projection } from "@/lib/plan";
import type { Dash } from "@/lib/data";
import { saveTarget, addForecast, removeForecast, autofillForecast, saveConstruction } from "./actions";

type Plan = Awaited<ReturnType<typeof fyPlan>>;
type Esc = Awaited<ReturnType<typeof escalations>>;
type Proj = Awaited<ReturnType<typeof projection>>;
type Run = (p: Promise<{ ok: boolean; message: string }>) => void;

type ConsItem = Plan["construction"][number];
function ConsRow({ c, editable, pending, run }: { c: ConsItem; editable: boolean; pending: boolean; run: Run }) {
  const [start, setStart] = useState(c.start ?? "");
  const [months, setMonths] = useState(c.months_set != null ? String(c.months_set) : "");
  const basis = c.months_set != null ? "set here" : c.basis === "stage" ? "from the PO wording" : c.basis === "contract" ? "from contract validity" : "assumed";
  return (
    <div className="crow2">
      <div className="pname"><b>{c.client ?? c.project ?? c.project_number}</b><span>{[c.studio, c.project_number.trim()].filter(Boolean).join(" · ")}</span></div>
      <div className="num">{inr(c.fee)}<small>{c.months} months · {basis}</small></div>
      {editable ? (
        <div className="acts">
          <input aria-label="Construction start month" className="field" type="month" value={start} onChange={(e) => setStart(e.target.value)} />
          <input aria-label="Duration in months" className="field" type="number" min={1} max={120} placeholder={`${c.months} mo`} value={months} onChange={(e) => setMonths(e.target.value)} />
          <button className="pill" disabled={pending || !start} onClick={() => run(saveConstruction({ project_number: c.project_number, studio: c.studio, start, months: months ? Number(months) : null }))}>Save</button>
        </div>
      ) : <div className="num">{c.start ? monthLabel(c.start) : "Not set"}</div>}
    </div>
  );
}

export default function PlanTab({ plan, esc, proj, month, role, studio, openStages, run, pending, setMonth }:
  { plan: Plan | null; esc: Esc; proj: Proj | null; month: string; role: Role; studio: string | null; openStages: Dash["openStages"]; run: Run; pending: boolean; setMonth: (m: string) => void }) {
  const [target, setTarget] = useState(plan?.total.target != null ? String(Math.round(plan.total.target / 1e5)) : "");
  const [form, setForm] = useState({ stage: "", week: "1", amount: "", description: "" });
  if (!plan || !proj) return <div className="banner">Plan needs the latest SQL migration (supabase/migrations/20261118000000_po_plan_finance_rbac.sql).</div>;
  const t = plan.total;
  const pct = (a: number, b: number | null) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const shift = (n: number) => { const [y, m] = month.split("-").map(Number); setMonth(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7)); };
  const maxWeek = Math.max(1, ...proj.weeks.map((w) => Math.max(w.forecast, w.actual)));
  const stagePick = openStages.find((s) => String(s.id) === form.stage);

  return (
    <>
      <div className="eyebrow">Plan · FY {plan.fy}{studio ? ` · ${studio}` : ""}</div>
      <h1>What can we bill this year? <em>And this month?</em></h1>

      <div className="p-grid">
        <section className="mult p-fy">
          <div className="mhead"><span>FY {plan.fy} OUTLOOK</span><span>{plan.months_left} MONTHS LEFT</span></div>
          <div className="x num">{inr(t.outlook)}</div>
          <div className="sub">Billed {inr(t.billed_ytd)} · design pending {inr(t.design_pending)} · construction {inr(t.construction_in_fy)}</div>
          <div className="mtrack"><i style={{ width: `${pct(t.outlook, t.target)}%` }} /></div>
          <div className="maxis"><span>0</span><span>{t.target != null ? `${pct(t.outlook, t.target)}% of target` : "No target set"}</span><span>{t.target != null ? inr(t.target) : "—"}</span></div>
          <div className="mnote">{t.target == null ? "Set a target to see the gap." : t.gap! > 0 ? `${inr(t.gap)} short of target even if every pending design stage is delivered this year.` : `Outlook clears the target by ${inr(-t.gap!)}.`}</div>
        </section>
        <section className="card p-target">
          <h2>FY target</h2>
          <p className="note">{plan.method}</p>
          <p className="note">Construction timing: {plan.timing.stage} from the stage wording, {plan.timing.contract} from the contract validity{plan.timing.assumed ? `, ${plan.timing.assumed} assumed at 36 months (no duration recorded)` : ""}. {plan.confirmed} with a confirmed start month.</p>
          {can(role, "plan.target") ? (
            <form className="p-form" onSubmit={(e) => { e.preventDefault(); const v = Number(target); if (v > 0) run(saveTarget({ fy: plan.fy, studio: studio ?? "All", target: v * 1e5 })); }}>
              <label htmlFor="p-target">Target for {studio ?? "the firm"} (₹ lakh)</label>
              <div className="row"><input id="p-target" className="field" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} placeholder="e.g. 1500" /><button className="pill pink" disabled={pending}>Save</button></div>
            </form>
          ) : <p className="note">Targets are set by Planning or leadership.</p>}
        </section>
      </div>

      <section className="card p-studios">
        <div className="dhead"><h2>By studio</h2><span className="note">Billed since 1 April + billable before 31 March</span></div>
        <div className="p-table" role="table">
          <div className="p-tr p-th" role="row"><span>Studio</span><span>Billed YTD</span><span>Design pending</span><span>Construction</span><span>Outlook</span><span>Target</span></div>
          {plan.rows.slice(0, 12).map((r) => (
            <div className="p-tr num" role="row" key={r.studio}>
              <span>{r.studio}</span><span>{inr(r.billed_ytd)}</span><span>{inr(r.design_pending)}</span><span>{inr(r.construction_in_fy)}</span>
              <span className="p-bar"><i style={{ width: `${Math.min(100, (r.outlook / Math.max(plan.rows[0]?.outlook ?? 1, 1)) * 100)}%` }} />{inr(r.outlook)}</span>
              <span>{r.target != null ? inr(r.target) : "—"}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-cons">
        <div className="dhead"><h2>Construction start</h2><span className="note">Instalments count from the confirmed month. Without one, from next month.</span></div>
        {!plan.construction_ready && <p className="note">To save start months, run <code>supabase/migrations/20261121000000_construction_plan.sql</code> in the Supabase SQL Editor.</p>}
        {plan.construction.length === 0 && <p className="note">No construction instalments are waiting on active lines.</p>}
        {plan.construction.map((c) => (
          <ConsRow key={`${c.project_number}|${c.studio}`} c={c} editable={plan.construction_ready && can(role, "plan.construction")} pending={pending} run={run} />
        ))}
      </section>

      <section className="card p-proj">
        <div className="dhead">
          <h2>Monthly projection</h2>
          <div className="acts">
            <button className="pill" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <span className="pill p-month">{monthLabel(month)}</span>
            <button className="pill" onClick={() => shift(1)} aria-label="Next month">›</button>
            {can(role, "plan.projection") && <button className="pill pink" disabled={pending} onClick={() => run(autofillForecast({ month, studio }))}>Auto-fill from pipeline</button>}
          </div>
        </div>
        <div className="p-kpis num">
          <div><b>{inr(proj.totals.forecast)}</b><span>Forecast</span></div>
          <div><b>{inr(proj.totals.actual)}</b><span>Actual</span></div>
          <div><b className={proj.totals.variance < 0 ? "t-pink" : "t-green"}>{proj.totals.variance >= 0 ? "+" : ""}{inr(proj.totals.variance)}</b><span>Variance</span></div>
          <div><b>{inr(proj.totals.carry_forward)}</b><span>Carried from last month</span></div>
          <div><b>{inr(proj.totals.unplanned)}</b><span>Unplanned / new project</span></div>
        </div>
        <div className="p-weeks">
          {proj.weeks.map((w) => (
            <div key={w.week} className="p-week">
              <div className="p-cols"><i className="f" style={{ height: `${(w.forecast / maxWeek) * 100}%` }} title={`Forecast ${inr(w.forecast)}`} /><i className="a" style={{ height: `${(w.actual / maxWeek) * 100}%` }} title={`Actual ${inr(w.actual)}`} /></div>
              <b>Week {w.week}</b><small>{inr(w.forecast)} · {inr(w.actual)}</small>
            </div>
          ))}
        </div>
        <div className="legend"><span><i style={{ background: "var(--blue-soft)" }} />Forecast</span><span><i style={{ background: "var(--fg)" }} />Actual</span><span>{proj.method}</span></div>

        <div className="p-rows">
          {proj.rows.length ? proj.rows.map((r) => (
            <div className="krow" key={r.id}>
              <div className="t"><b>W{r.week} · {inr(r.amount)} · {r.description}</b><small>{r.project_number ?? "manual"}{r.studio ? ` · ${r.studio}` : ""} · {r.status.replace("_", " ")} · {r.created_by ?? ""}</small></div>
              <span className={`tag ${r.status === "billed" ? "t-green" : "t-grey"}`}>{r.status === "billed" ? "Billed" : r.kind.replace("_", " ")}</span>
              {can(role, "plan.projection") && <button className="pill" disabled={pending} onClick={() => run(removeForecast(r.id))}>Remove</button>}
            </div>
          )) : <div className="empty">No forecast for {monthLabel(month)} yet. Auto-fill from the pipeline, or add rows below.</div>}
          {proj.carry_forward.map((r) => <div className="krow" key={`c${r.id}`}><div className="t"><b>Carry-forward · {inr(r.amount)} · {r.description}</b><small>Forecast for {monthLabel(r.month.slice(0, 7))}, not billed yet</small></div><span className="tag t-amber">Carried</span></div>)}
          {proj.unplanned.map((u) => <div className="krow" key={u.key}><div className="t"><b>{u.kind === "new_project" ? "New project" : "Unplanned"} · {inr(u.amount)} · {u.label}</b><small>{u.project_number} · {u.studio} · billed week {u.week}</small></div><span className="tag t-blue">{u.kind === "new_project" ? "New project" : "Unplanned"}</span></div>)}
        </div>

        {can(role, "plan.projection") && (
          <form className="p-add" onSubmit={(e) => {
            e.preventDefault();
            const amount = Number(form.amount || stagePick?.fee || 0);
            const description = form.description || stagePick?.stage || "";
            if (!amount || !description) return;
            run(addForecast({ month, week: Number(form.week), amount, description, project_number: stagePick?.project_number ?? null, studio: stagePick?.studio ?? studio, stage_seq: stagePick?.seq ?? null }));
            setForm({ stage: "", week: form.week, amount: "", description: "" });
          }}>
            <select className="field" aria-label="Stage" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
              <option value="">Free text (no stage)</option>
              {openStages.slice(0, 400).map((s) => <option key={s.id} value={s.id}>{s.label} · {s.studio} · {(s.stage ?? "").slice(0, 50)} · {inr(s.fee)}</option>)}
            </select>
            <select className="field" aria-label="Week" value={form.week} onChange={(e) => setForm({ ...form, week: e.target.value })}>{[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>Week {w}</option>)}</select>
            <input className="field" aria-label="Amount in rupees" inputMode="decimal" placeholder={stagePick ? `₹ ${Math.round(stagePick.fee ?? 0)}` : "Amount ₹"} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, "") })} />
            <input className="field" aria-label="Description" placeholder={stagePick?.stage?.slice(0, 40) ?? "Description"} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <button className="pill pink" disabled={pending}>Add forecast</button>
          </form>
        )}
      </section>

      <section className="card p-esc">
        <div className="dhead"><h2>Escalation</h2><span className="note">Rate read from each contract&apos;s clause, applied per started year after the end date on the amount still to bill. An estimate: confirm against the PO.</span></div>
        {esc.length ? esc.slice(0, 12).map((e) => (
          <div className="krow" key={e.row_no}>
            <div className="t"><b>{e.client_name ?? e.project_number} · {e.studio}</b><small>{e.clause} · ends {niceDate(e.end_date)} · {inr(e.yet_to_bill)} to bill</small></div>
            {e.periods ? <span className="tag t-pink">+{inr(e.uplift)} · {e.periods} yr</span> : <span className="tag t-amber">Steps up {niceDate(e.next_step_up)}</span>}
          </div>
        )) : <div className="empty">No active contract with an escalation clause is past or near its end date.</div>}
      </section>
    </>
  );
}

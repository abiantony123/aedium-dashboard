"use client";
// F2 · Plan › Forecast. Manual outlook vs probability-weighted billing, cash by 31 March, monthly bars, movers, payment dates, by studio.
import { useState } from "react";
import { inr, monthLabel } from "@/lib/format";
import { can, type Role } from "@/lib/rbac";
import type { Forecast } from "@/lib/forecast";
import { sendPriorities } from "./actions";

type F = Omit<Forecast, "items">;
type Run = (p: Promise<{ ok: boolean; message: string }>) => void;
const mon = (ym: string | null) => ym ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(ym.slice(5)) - 1] : "after Mar";

export default function ForecastView({ f, backtest, role, studio, run, pending }: { f: F | null; backtest: { month: string; forecast: number; actual: number | null }[]; role: Role; studio: string | null; run: Run; pending: boolean }) {
  const [view, setView] = useState<"month" | "studio" | "client">("month");
  if (!f) return <div className="banner">Forecast needs the latest SQL migration (supabase/migrations/20261122000000_po_inbox_forecast_leakage.sql).</div>;
  const m = f.manual, t = f.total;
  const scale = Math.max(m.outlook, t.high, 1);
  const w = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const likely = Math.max(0, t.expected - m.billed_ytd);
  const maxBar = Math.max(1, ...f.byMonth.map((b) => Math.max(b.high, b.collections)));
  const H = 190;

  return (
    <>
      <div className="eyebrow">F2 · Plan · FY {f.fy} · {f.months_left} months left · advisory{studio ? ` · ${studio}` : ""}</div>
      <h1>What will really be billed, <em>and when will the cash land?</em></h1>
      <div className="chips">
        <div className="seg sm" role="group" aria-label="View">
          {(["month", "studio", "client"] as const).map((v) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>By {v}</button>)}
        </div>
        <span className="ktag k-amber">Model {f.model} · cash uses Zoho Books sample data</span>
      </div>

      <div className="f2-top">
        <section className="card f2-head">
          <div className="f2-pair">
            <div><small>Manual outlook · assumes everything pending is billed</small><div className="f2-strike num">{inr(m.outlook)}</div><small>Billed {inr(m.billed_ytd)} · design pending {inr(m.design_pending)} · construction {inr(m.construction)}</small></div>
            <div><small className="t-blue">Probability-weighted billing, FY total</small><div className="f2-big num">{inr(t.expected)}</div><small>80% range {inr(t.low)} to {inr(t.high)} · includes {inr(m.billed_ytd)} already billed</small></div>
          </div>
          <div className="f2-track"><i className="b" style={{ width: w(m.billed_ytd) }} /><i className="l" style={{ left: w(m.billed_ytd), width: w(likely) }} /></div>
          <div className="legend"><span><i style={{ background: "var(--fg)" }} />Billed YTD {inr(m.billed_ytd)}</span><span><i style={{ background: "var(--blue)" }} />Likely before 31 Mar {inr(likely)}</span><span><i style={{ border: "1.5px solid var(--muted)" }} />Unlikely this FY {inr(f.unlikely)}</span></div>
          <div className="f2-why"><b className="t-pink">Why the gap.</b> {Math.round(f.stalled_share * 100)}% of design-pending value sits on lines with no billing or stage movement for over 12 months, and construction instalments depend on site progress. {f.method}</div>
        </section>
        <div className="f2-right">
          <section className="f2-cash">
            <div className="eyebrow" style={{ color: "#fff" }}>Cash in by 31 March</div>
            <div className="f2-big num">{inr(f.cash.total)}</div>
            <p>80% range {inr(f.cash.low)} to {inr(f.cash.high)}, using each client&apos;s payment history from Zoho Books (default {f.cash.default_days} days where a client has no history).</p>
            <div className="f2-cnote">Of {inr(f.cash.outstanding)} outstanding today, about {inr(f.cash.back_before_fy_end)} is expected back before March.{f.cash.dragger ? ` ${f.cash.dragger} drags the most.` : ""}</div>
          </section>
          <section className="card f2-bt">
            <div className="dhead"><h2>How close it has been</h2><small className="note">Backtest</small></div>
            {backtest.length ? backtest.slice(0, 4).map((b) => {
              const v = b.actual != null && b.forecast ? (b.actual - b.forecast) / b.forecast : null;
              return <div className="f2-btrow num" key={b.month}><span>{mon(b.month)}</span><span>F {inr(b.forecast)}</span><span>A {b.actual != null ? inr(b.actual) : "pending"}</span><span className={v == null ? "t-grey" : Math.abs(v) <= 0.1 ? "t-green" : "t-amber"}>{v == null ? "—" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`}</span></div>;
            }) : <div className="empty">First snapshot is taken today.</div>}
            <p className="note">F = forecast made at the start of the month, A = actual billed (master tracker). One snapshot a month is stored, so variance builds up month by month.</p>
          </section>
        </div>
      </div>

      {view === "month" && <section className="card f2-chart">
        <div className="dhead"><h2>Billing and collections by month</h2><div className="legend"><span><i style={{ background: "var(--blue)" }} />Billing, most likely</span><span><i style={{ border: "1.5px dashed var(--muted)" }} />80% range</span><span><i style={{ background: "var(--pink)" }} />Collections, most likely</span></div></div>
        <div className="f2-bars" style={{ height: H + 50 }}>
          {f.byMonth.map((b, k) => (
            <div key={b.month} className="f2-col">
              <div className="f2-pair2" style={{ height: H }}>
                <div className="f2-range" style={{ height: (b.high / maxBar) * H }} title={`80% range ${inr(b.low)} to ${inr(b.high)}`}><small>{inr(b.billing)}</small><i style={{ height: (b.billing / maxBar) * H }} /></div>
                <div className="f2-coll" style={{ height: (b.collections / maxBar) * H }} title={`Collections ${inr(b.collections)}`}><small className="t-pink">{inr(b.collections)}</small></div>
              </div>
              <span>{mon(b.month)}{k === 0 ? " (rest)" : ""}</span>
            </div>
          ))}
        </div>
      </section>}
      {view === "studio" && <Table title="Forecast by studio" rows={f.byStudio.map((r) => [r.studio, inr(r.manual), inr(r.forecast), r.manual ? r.forecast / r.manual : 0])} heads={["STUDIO", "MANUAL OUTLOOK", "FORECAST", "FORECAST AS SHARE OF OUTLOOK"]} />}
      {view === "client" && <Table title="Forecast by client (still to bill this FY)" rows={f.byClient.map((r) => [r.client, "", inr(r.forecast), r.forecast / Math.max(1, f.byClient[0]?.forecast ?? 1)])} heads={["CLIENT", "", "FORECAST", "SHARE OF TOP CLIENT"]} />}

      <div className="f2-row2">
        <section className="card f2-movers">
          <div className="dhead"><h2>Stages that move cash this quarter</h2><small className="note">Ranked by expected ₹ × probability · {studio ?? "all studios"}</small></div>
          <div className="f2-mh"><span>PROJECT · STAGE</span><span>VALUE</span><span>CHANCE BY {mon(f.quarter_end).toUpperCase()}</span><span>BILL</span><span>CASH BY</span></div>
          {f.movers.map((x) => (
            <div key={`${x.project_number}${x.studio}${x.seq}`} className="f2-mrow num">
              <div><b>{x.client ?? x.project_number} · {x.studio}</b><small>{(x.stage ?? "").slice(0, 60)}</small></div>
              <span>{inr(x.fee)}</span>
              <span className="f2-p"><i style={{ width: `${Math.round(x.p * 100)}%` }} />{Math.round(x.p * 100)}%</span>
              <span>{mon(x.month)}</span><span className="t-blue">{mon(x.cash_month)}</span>
            </div>
          ))}
          {!f.movers.length && <div className="empty">No unbilled milestone stages on active lines.</div>}
          {can(role, "plan.projection") && <div className="row" style={{ justifyContent: "flex-start", marginTop: 14, alignItems: "center" }}><button className="pill pink" disabled={pending} onClick={() => run(sendPriorities({ studio }))}>Send priorities to studios</button><span className="note">Each director sees the stages whose drawings unlock billing first.</span></div>}
        </section>
        <section className="card f2-pay">
          <div className="dhead"><h2>Expected payment dates</h2><span className="ktag k-amber">Zoho sample data</span></div>
          {f.payments.map((p) => (
            <div key={p.name} className="f2-prow"><div><b>{p.name}</b><small>{inr(p.open)} open · usually pays in {p.days} days</small></div><div className="r"><b>{p.due < f.months[0] ? "Overdue now" : p.due > f.months[f.months.length - 1] ? "after 31 Mar" : monthLabel(p.due)}</b><small className={p.confidence === "High" ? "t-green" : p.confidence === "Low" ? "t-amber" : "t-grey"}>{p.confidence} confidence</small></div></div>
          ))}
          {!f.payments.length && <div className="empty">No open invoices.</div>}
        </section>
      </div>

      {view === "month" && <Table title="By studio · manual outlook beside forecast" note="Manual column is today's Outlook tab; forecast is advisory." rows={f.byStudio.map((r) => [r.studio, inr(r.manual), inr(r.forecast), r.manual ? r.forecast / r.manual : 0])} heads={["STUDIO", "MANUAL OUTLOOK", "FORECAST", "FORECAST AS SHARE OF OUTLOOK"]} />}
    </>
  );
}

function Table({ title, note, heads, rows }: { title: string; note?: string; heads: string[]; rows: (string | number)[][] }) {
  return (
    <section className="card f2-table">
      <div className="dhead"><h2>{title}</h2>{note && <small className="note">{note}</small>}</div>
      <div className="f2-th">{heads.map((h, i) => <span key={i}>{h}</span>)}</div>
      {rows.map((r, i) => <div key={i} className="f2-tr num"><span>{r[0]}</span><span className="t-grey">{r[1]}</span><span>{r[2]}</span><span className="f2-share"><i style={{ width: `${Math.min(100, Number(r[3]) * 100)}%` }} /><b>{Math.round(Number(r[3]) * 100)}%</b></span></div>)}
    </section>
  );
}

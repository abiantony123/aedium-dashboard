"use client";
// F4 · Cash › Leakage. Weekly ranked list; each item is confirmed, corrected or dismissed by its owner, and logged.
import { useState, type ReactNode } from "react";
import { inr, niceDate } from "@/lib/format";
import { can, type Role } from "@/lib/rbac";
import type { Leakage, Kind } from "@/lib/leakage";
import { decideLeakageAction, runLeakage } from "./actions";

type Run = (p: Promise<{ ok: boolean; message: string }>) => void;
const TONE: Record<Kind, string> = { billed_not_collected: "t-pink", complete_not_billed: "t-amber", lapsed_with_value: "t-amber", stages_over_100: "t-pink", under_billed_fee: "t-blue", stalled_approval: "t-blue", tracker_mismatch: "t-grey" };
const REASONS = ["Already invoiced outside the tracker", "Client dispute, on hold", "Stage not actually complete", "Duplicate of another item", "Value is correct as recorded", "Other"];

export default function LeakageView({ l, role, roleStudio, studio, run, pending, rangeSlot, rangeLabel }: { l: Leakage | null; role: Role; roleStudio: string | null; studio: string | null; run: Run; pending: boolean; rangeSlot?: ReactNode; rangeLabel?: string | null }) {
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [open, setOpen] = useState<number | null>(null);
  const [corr, setCorr] = useState<{ id: number; value: string; reason: string } | null>(null);
  if (!l) return <div className="banner">Leakage needs the latest SQL migration (supabase/migrations/20261122000000_po_inbox_forecast_leakage.sql).</div>;
  const items = l.items.filter((i) => filter === "all" || i.kind === filter);
  const first = open ?? items[0]?.id ?? null;
  const mayDecide = (i: Leakage["items"][number]) => can(role, "leakage.decide") && (role !== "finance" || i.kind === "billed_not_collected") && (role !== "project_manager" || !roleStudio || i.studio === roleStudio || i.kind === "billed_not_collected");
  const k = l.kpi, bk = l.byKind;
  const ago = (iso: string) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return d <= 0 ? "Raised today" : d < 7 ? "Raised this week" : `Open ${d} days`; };

  return (
    <>
      <div className="page-top">
        <div className="eyebrow">F4 · Leakage · weekly run · {l.run ? `last ${niceDate(l.run.run_at)}` : "not run yet"}{studio ? ` · ${studio}` : ""}{rangeLabel ? ` · ${rangeLabel}` : ""}</div>
        {rangeSlot}
      </div>
      <h1>Where is the leakage? <em>Ranked by ₹ impact, owned by a director.</em></h1>
      <div className="chips">
        <span className="pill sm">{studio ?? "All studios"}</span>
        <button className="pill sm" onClick={() => {
          const csv = [["Kind", "Title", "Detail", "Amount", "Owner", "Evidence"], ...l.items.map((i) => [l.kinds[i.kind as Kind].label, i.title, i.detail ?? "", Math.round(Number(i.amount ?? 0)), i.owner, i.evidence ?? ""])].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
          const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "leakage.csv"; a.click();
        }}>Export list</button>
        {can(role, "leakage.decide") && role !== "finance" && <button className="pill sm" disabled={pending} onClick={() => run(runLeakage())}>Run now</button>}
      </div>

      <div className="f4-kpis num">
        <div className="f4-stake"><div><small>AT STAKE ON SIZED ITEMS</small><b>{inr(k.at_stake)}</b></div>
          <div className="r"><span>{inr(bk.billed_not_collected.amount)} unpaid · {inr(bk.complete_not_billed.amount)} unbilled</span><span>{inr(bk.lapsed_with_value.amount)} on lapsed contracts</span></div></div>
        <div className="card"><b>{k.open}</b><span>Open items</span></div>
        <div className="card"><b>{k.decided_week}</b><span>{l.ranged ? "Decided in period" : "Decided this week"}</span></div>
        <div className="card"><b>{inr(k.invoiced_after)}</b><span>Invoiced after confirm</span></div>
        <div className="card"><b>{k.median_days != null ? `${k.median_days.toFixed(1)} days` : "—"}</b><span>Median time to decide</span></div>
      </div>

      <div className="f4-filters">
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
        {(Object.keys(l.kinds) as Kind[]).map((kk) => <button key={kk} className={filter === kk ? "on" : ""} onClick={() => setFilter(kk)}>{l.kinds[kk].label} <b>{bk[kk].n}{bk[kk].amount ? ` · ${inr(bk[kk].amount)}` : ""}</b></button>)}
      </div>

      <div className="f4-grid">
        <section className="card f4-list">
          <div className="dhead"><h2>{l.ranged ? "Raised in this period" : <>This week&apos;s list</>}</h2><small className="note">Each item needs a director to confirm, correct or dismiss</small></div>
          {items.slice(0, 60).map((i, n) => {
            const on = i.id === first;
            return (
              <article key={i.id} className={`f4-item${on ? " on" : ""}`} onClick={() => setOpen(i.id)}>
                <i className="f4-n">{n + 1}</i>
                <div className="f4-body">
                  <div className="f4-meta"><span className={`ktag ${TONE[i.kind as Kind]}`}>{l.kinds[i.kind as Kind].label}</span><small>{ago(i.first_seen_at)}</small></div>
                  <b>{i.title}</b><small>{i.detail}</small>
                </div>
                <div className="f4-amt num"><b>{i.amount != null ? inr(i.amount) : "[₹]"}</b><small>{i.owner}</small></div>
                {on && (
                  <div className="f4-open" onClick={(e) => e.stopPropagation()}>
                    <div className="f4-ev">
                      <div><small>{i.seq != null ? "STAGE" : "PROJECT"}</small><b>{i.seq != null ? i.detail : i.project_number ?? "All lines"}</b></div>
                      <div><small>STATUS IN TRACKER</small><b>{i.kind === "complete_not_billed" ? "Complete · no billed date" : i.kind === "stalled_approval" ? "Complete · no client approval" : i.kind === "billed_not_collected" ? "Invoiced · unpaid" : l.kinds[i.kind as Kind].rule}</b></div>
                      <div><small>EVIDENCE</small><b>{i.evidence}</b></div>
                    </div>
                    {mayDecide(i) ? (
                      corr?.id === i.id ? (
                        <form className="f4-corr" onSubmit={(e) => { e.preventDefault(); if (!corr!.reason.trim()) return; run(decideLeakageAction({ id: i.id, decision: "corrected", reason: corr!.reason, corrected_value: corr!.value ? Number(corr!.value) : undefined })); setCorr(null); }}>
                          <input className="field" inputMode="decimal" placeholder={`Correct value ₹ (now ${i.amount != null ? Math.round(Number(i.amount)) : "unsized"})`} value={corr!.value} onChange={(e) => setCorr({ ...corr!, value: e.target.value.replace(/[^\d.]/g, "") })} />
                          <input className="field" placeholder="Reason, e.g. revised PO" value={corr!.reason} onChange={(e) => setCorr({ ...corr!, reason: e.target.value })} />
                          <button className="pill pink" disabled={pending}>Save correction</button><button type="button" className="pill" onClick={() => setCorr(null)}>Cancel</button>
                        </form>
                      ) : (
                        <div className="f4-acts">
                          <button className="pill pink" disabled={pending} onClick={() => run(decideLeakageAction({ id: i.id, decision: "confirmed" }))}>{i.kind === "complete_not_billed" || i.kind === "stalled_approval" ? "Confirm and send to Finance" : i.kind === "billed_not_collected" ? "Confirm and chase" : "Confirm"}</button>
                          <button className="pill" onClick={() => setCorr({ id: i.id, value: "", reason: "" })}>Correct value or status</button>
                          <select className="pill f4-dis" defaultValue="" onChange={(e) => { if (e.target.value) run(decideLeakageAction({ id: i.id, decision: "dismissed", reason: e.target.value })); }}>
                            <option value="" disabled>Dismiss: choose a reason</option>{REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                      )
                    ) : <p className="note">Owned by {i.owner}. Your role can view, not decide.</p>}
                    <p className="note">Your decision, reason and any corrected value are logged against the item.</p>
                  </div>
                )}
              </article>
            );
          })}
          {!items.length && <div className="empty">{l.ranged ? "Nothing open was first raised in this period. Widen the range or pick All time." : "Nothing open in this category."}</div>}
          {items.length > 60 && <p className="note">Showing the 60 largest of {items.length}. Export the list for all.</p>}
        </section>
        <div className="f4-side">
          <section className="card f4-owners">
            <h2>{l.ranged ? "Owners in this period" : "Owners this week"}</h2>
            {l.owners.map((o) => (
              <div key={o.owner} className="f4-orow"><div><b>{o.owner}</b><small>{o.open} open{o.amount ? ` · ${inr(o.amount)}` : ""}</small></div><span className={`ktag ${o.done && !o.open ? "k-green" : o.done ? "k-blue" : "k-amber"}`}>{o.done ? `${o.done} of ${o.done + o.open} done` : "Not started"}</span></div>
            ))}
            <p className="note">Undecided items roll into next Monday&apos;s list.</p>
          </section>
          <section className="card f4-log">
            <h2>Decision log</h2>
            {l.log.length ? l.log.map((d) => (
              <div key={d.id} className="f4-lrow"><small>{niceDate(d.decided_at)}</small><span><b className={d.status === "confirmed" ? "t-green" : d.status === "corrected" ? "t-blue" : "t-grey"}>{d.status[0].toUpperCase() + d.status.slice(1)}</b> {d.title}{d.reason ? `, reason: ${d.reason}` : ""}{d.corrected_value != null ? ` · corrected to ${inr(d.corrected_value)}` : ""} · {d.decided_by}</span></div>
            )) : <div className="empty">No decisions yet.</div>}
          </section>
          <section className="f4-how">
            <h2>How items are found</h2>
            <ul>{(Object.keys(l.kinds) as Kind[]).map((kk) => <li key={kk}>{l.kinds[kk].rule}</li>)}</ul>
            <p>Inputs: stage events, invoices, payments, tracker import and PO values.</p>
          </section>
        </div>
      </div>
    </>
  );
}

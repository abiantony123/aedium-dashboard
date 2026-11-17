"use client";
import { useState, useTransition } from "react";
import { inr, niceDate } from "@/lib/format";
import { can, type Role } from "@/lib/rbac";
import type { listPos, getPo } from "@/lib/po";
import { loadPo, reviewPoAction, poExcelRows } from "./actions";

type Pos = Awaited<ReturnType<typeof listPos>>;
type Full = Awaited<ReturnType<typeof getPo>>;
type Check = { rule: string; ok: boolean; severity: string; detail: string };
type Run = (p: Promise<{ ok: boolean; message: string }>) => void;

export default function PoIntake({ pos, role, run, pending, toast }: { pos: Pos; role: Role; run: Run; pending: boolean; toast: (m: string) => void }) {
  const [open, setOpen] = useState<Full | null>(null);
  const [pn, setPn] = useState("");
  const [note, setNote] = useState("");
  const [loading, startLoad] = useTransition();
  const pendingPos = pos.filter((p) => p.status === "pending_review");
  const show = (id: number) => startLoad(async () => { const r = await loadPo(id); if (r.ok) { setOpen(r.po); setPn(r.po.header.project_number ?? ""); setNote(""); } else toast(r.message); });
  const copyRows = (id: number) => startLoad(async () => {
    const r = await poExcelRows(id);
    if (!r.ok) return toast(r.message);
    const tsv = Object.entries(r.rows.sheets).map(([name, s]) => `${name}\n${[s.headers, ...s.rows].map((row) => row.map((v) => v ?? "").join("\t")).join("\n")}`).join("\n\n");
    navigator.clipboard?.writeText(tsv).then(() => toast("Rows copied. Paste them into the master tracker sheets."), () => toast("Copy failed; use Export tracker instead."));
  });

  return (
    <section className="card po-intake">
      <div className="dhead"><h2>PO intake</h2><span className="note">Staged by an assistant (Claude, ChatGPT, Gemini) through Connect AI · {pendingPos.length} to review</span></div>
      {pos.length ? pos.slice(0, 10).map((p) => {
        const checks = (p.checks as Check[] | null) ?? [];
        const failed = checks.filter((c) => !c.ok && c.severity === "error").length;
        return (
          <div className="frow" key={p.id}>
            <div className="t"><b>{p.po_number}{p.version > 1 ? ` v${p.version}` : ""} · {p.client_name}</b><small>{p.kind} · {p.project_number ?? "no project number"} · {p.source ?? "assistant"}{p.source_ref ? ` · ${p.source_ref}` : ""} · {p.extracted_by}</small></div>
            <div className="f-amt num"><b>{inr(p.total_value)}</b><small className={failed ? "t-pink" : "t-green"}>{failed ? `${failed} check(s) failed` : "checks passed"}</small></div>
            <div className="f-acts">
              <span className={`tag ${p.status === "approved" ? "t-green" : p.status === "rejected" ? "t-grey" : "t-amber"}`}>{p.status.replace("_", " ")}</span>
              <button className="pill" disabled={loading} onClick={() => show(p.id)}>{p.status === "pending_review" && can(role, "po.review") ? "Review" : "View"}</button>
              {p.status === "approved" && <button className="pill" disabled={loading} onClick={() => copyRows(p.id)}>Excel rows</button>}
            </div>
          </div>
        );
      }) : <div className="empty">No POs yet. In Claude, ChatGPT or Gemini (connected through Connect AI), ask: “Read the PO in my latest email from the client and stage it for Aedium.”</div>}

      {open && (
        <div className="f-modal" role="dialog" aria-modal="true" aria-labelledby="po-t" onClick={(e) => { if (e.target === e.currentTarget) setOpen(null); }}>
          <div className="sheet card po-sheet">
            <h2 id="po-t">{open.header.po_number} v{open.header.version} · {open.header.client_name}</h2>
            <p className="note">{open.header.kind} · {open.header.project_name} · {inr(open.header.total_value)} excl. GST · {open.header.start_date ? `${niceDate(open.header.start_date)} – ${niceDate(open.header.end_date)}` : "dates not given"} · escalation: {open.header.escalation_clause ?? "none stated"} · confidence {open.header.confidence != null ? `${Math.round(open.header.confidence * 100)}%` : "—"}</p>
            {open.header.raw?.notes && <div className="banner">Extractor notes: {open.header.raw.notes}</div>}
            <h3>Checks</h3>
            {((open.header.checks as Check[]) ?? []).map((c, i) => <div className="krow" key={i}><div className="t"><b>{c.rule}</b><small>{c.detail}</small></div><span className={`tag ${c.ok ? "t-green" : c.severity === "error" ? "t-pink" : "t-amber"}`}>{c.ok ? "OK" : c.severity}</span></div>)}
            {Array.isArray(open.header.diff) && open.header.diff.length > 0 && <>
              <h3>Changes vs the approved version</h3>
              {(open.header.diff as { field: string; from: unknown; to: unknown }[]).map((d, i) => <div className="krow" key={i}><div className="t"><b>{d.field}</b><small>{String(d.from ?? "—")} → {String(d.to ?? "—")}</small></div></div>)}
            </>}
            <h3>Studio split</h3>
            {open.lines.map((l) => <div className="krow" key={l.id}><div className="t"><b>{l.studio}</b><small>{l.split_pct != null ? `${(l.split_pct * 100).toFixed(1)}%` : ""}</small></div><span className="tag t-grey">{inr(l.split_value)}</span></div>)}
            <h3>Stages</h3>
            <div className="po-stages">{open.stages.map((s) => <div key={s.id}><span>{s.studio} · {s.seq}</span><span>{s.stage}</span><span className="num">{((s.pct ?? 0) * 100).toFixed(2)}%</span><span className="num">{inr(s.fee)}</span></div>)}</div>
            {open.header.status === "pending_review" && can(role, "po.review") ? (
              <form className="p-form" onSubmit={(e) => e.preventDefault()}>
                <label htmlFor="po-pn">Internal project number</label><input id="po-pn" className="field" value={pn} onChange={(e) => setPn(e.target.value)} placeholder="R-2627-001" />
                <label htmlFor="po-note">Review note (required if a check failed)</label><input id="po-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="row">
                  <button type="button" className="pill" onClick={() => setOpen(null)}>Close</button>
                  <button type="button" className="pill" disabled={pending} onClick={() => { run(reviewPoAction({ id: open.header.id, decision: "rejected", note })); setOpen(null); }}>Reject</button>
                  <button type="button" className="pill pink" disabled={pending} onClick={() => { run(reviewPoAction({ id: open.header.id, decision: "approved", note: note || undefined, project_number: pn || undefined })); setOpen(null); }}>Approve into tracker</button>
                </div>
              </form>
            ) : <div className="row"><button className="pill" onClick={() => setOpen(null)}>Close</button></div>}
          </div>
        </div>
      )}
    </section>
  );
}

"use client";
// F1 · Agents › PO intake. Detected list → selected PO (what changed, extracted fields, checks) → why held / what happens on approval.
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inr, niceDate, timeOf } from "@/lib/format";
import { can, type Role } from "@/lib/rbac";
import type { inbox as inboxFn } from "@/lib/inbox";
import type { getPo } from "@/lib/po";
import { loadPo, correctPoAction, approveInboxPo, notAPo, reviewPoAction, poFileUrl, searchPosAction, revisePoAction, suggestProjectNumber, decideReviewNoteAction } from "./actions";

type Box = Awaited<ReturnType<typeof inboxFn>>;
type Item = Box["items"][number];
type Full = Awaited<ReturnType<typeof getPo>>;
type Run = (p: Promise<{ ok: boolean; message: string }>) => void;
const GATE = 0.9;

const kindTag = (i: Item) => i.classification === "amendment" ? { t: "Amendment", c: "k-blue" } : i.classification === "duplicate" ? { t: "Duplicate", c: "k-grey" } : i.po ? { t: "New PO", c: "k-dark" } : { t: "Detected", c: "k-grey" };
const statusLine = (i: Item) => i.status === "merged" ? { t: `Merged ${i.merged_at ? niceDate(i.merged_at) : ""}`, c: "t-green" } : i.po?.status === "rejected" ? { t: "Rejected", c: "t-grey" }
  : !i.po ? { t: i.skip_reason ?? "Waiting for extraction", c: "t-amber" } : i.held ? { t: `Held · ${i.held.replace(/^Failed check: /, "")}`, c: "t-amber" } : { t: `Ready · ${i.checks.filter((c) => c.ok).length}/${i.checks.length} checks`, c: "t-green" };

export default function PoInbox({ box, role, run, pending, toast }: { box: Box | null; role: Role; run: Run; pending: boolean; toast: (m: string) => void }) {
  const [sel, setSel] = useState<number | null>(null);
  const [full, setFull] = useState<Full | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, startLoad] = useTransition();
  // Re-read the inbox from Supabase (new uploads, assistant-staged POs, decisions made elsewhere).
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const refresh = () => startRefresh(() => { router.refresh(); setLastRefresh(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())); });
  const items = useMemo(() => box?.items ?? [], [box]);
  // Search every PO already in the table (any status); a picked result opens in the same review panel.
  const [mode, setMode] = useState<"inbox" | "search">("inbox");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [results, setResults] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<Item | null>(null);
  const [searching, startSearch] = useTransition();
  const searchBox = useRef<HTMLInputElement>(null);
  const doSearch = (term = q, st = status) => startSearch(async () => {
    const r = await searchPosAction({ q: term, status: st });
    if (!r.ok) { toast(r.message); return; }
    setResults(r.items as Item[]);
    setPicked((p) => p ? (r.items as Item[]).find((x) => x.po_id === p.po_id) ?? p : p);
  });
  const openSearch = () => { setMode("search"); if (!results) doSearch("", status); setTimeout(() => searchBox.current?.focus(), 50); };
  // After any save the server data changes: keep search results and the picked PO current.
  useEffect(() => { if (mode === "search" && results) doSearch(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [box]);
  const cur = picked ?? items.find((i) => i.id === sel) ?? items[0] ?? null;
  const onRevised = (poId: number) => { setPicked(null); setMode("inbox"); setSel(-poId); setEditing(true); router.refresh(); };
  useEffect(() => {
    if (!cur?.po_id) { setFull(null); return; }
    let live = true;
    startLoad(async () => { const r = await loadPo(cur.po_id!); if (live && r.ok) setFull(r.po); });
    return () => { live = false; };
  }, [cur?.po_id, cur?.po?.checks]);
  if (!box) return <div className="banner">PO intake needs the latest SQL migration (supabase/migrations/20261122000000_po_inbox_forecast_leakage.sql).</div>;
  const k = box.kpi;
  const heldItem = items.find((i) => i.po?.status === "pending_review" && i.held && i.id !== cur?.id) ?? (cur?.held ? cur : null);

  return (
    <>
      <div className="eyebrow">F1 · PO intake · {box.mailboxConnected ? "auto-detected from the shared mailbox" : "uploads, folders and assistants · mailbox not connected yet"}</div>
      <h1>New and amended POs, staged <em>before anyone asks.</em></h1>
      <div className="chips f1-chips">
        {can(role, "po.stage") && <ManualIntake onDone={(id) => { setSel(id); setEditing(false); }} toast={toast} />}
        <button type="button" className={`pill sm f1-search-btn${mode === "search" ? " on" : ""}`} onClick={() => (mode === "search" ? (setMode("inbox"), setPicked(null)) : openSearch())} aria-pressed={mode === "search"} title="Find POs already in the tracker tables">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          {mode === "search" ? "Close search" : "Search POs"}
        </button>
        <button type="button" className={`pill sm f1-refresh${refreshing ? " busy" : ""}`} onClick={refresh} disabled={refreshing} title="Reload POs from the database" aria-label="Refresh PO intake">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
          {refreshing ? "Refreshing…" : lastRefresh ? `Refreshed ${lastRefresh}` : "Refresh"}
        </button>
        <span className="pill sm">{box.mailboxConnected ? <><i className="live" />Watching shared mailbox · Microsoft Graph · read-only</> : <><i className="live off" />Mailbox: needs Microsoft Graph consent from IT</>}</span>
        <span className="pill sm">{box.runs[0] ? `Last load ${timeOf(box.runs[0].finished_at ?? box.runs[0].started_at)} · ${box.runs[0].source} · ${box.runs[0].detected} detected` : "No scan yet"}</span>
      </div>
      <div className="f1-kpis num">
        <div className="card"><b>{k.detected_week}</b><span>Detected this week</span></div>
        <div className="card"><b>{k.ready}</b><span>Ready to approve</span></div>
        <div className="card"><b>{k.held}</b><span>Held for review</span></div>
        <div className="card"><b>{k.merged_today}</b><span>Merged today</span></div>
        <div className="card"><b>{k.median_hours != null ? `${k.median_hours < 48 ? Math.round(k.median_hours) + " h" : Math.round(k.median_hours / 24) + " d"}` : "—"}</b><span>Median email to tracker</span></div>
      </div>

      <div className="f1-grid">
        <section className="card f1-list">
          {mode === "search" ? (
            <>
              <div className="dhead"><h2>All POs</h2><button type="button" className="linkbtn" onClick={() => { setMode("inbox"); setPicked(null); }}>Back to detected</button></div>
              <form className="f1-sform" onSubmit={(e) => { e.preventDefault(); doSearch(); }}>
                <div className="f1-sinput"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
                  <input ref={searchBox} type="search" placeholder="PO number, client, project or R-number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search POs" /></div>
                <div className="f1-srow">
                  <select value={status} onChange={(e) => { setStatus(e.target.value); doSearch(q, e.target.value); }} aria-label="Status">
                    <option value="all">All statuses</option><option value="pending_review">Waiting for review</option><option value="approved">Approved</option><option value="rejected">Rejected</option>
                  </select>
                  <button className="pill sm pink" disabled={searching}>{searching ? "Searching…" : "Search"}</button>
                </div>
              </form>
              <p className="note f1-scount">{searching ? "Searching the purchase order table…" : results ? `${results.length}${results.length === 40 ? "+" : ""} PO${results.length === 1 ? "" : "s"} found` : ""}</p>
              {(results ?? []).map((i) => {
                const st = i.po?.status === "approved" ? { t: `Approved${i.po.reviewed_at ? ` ${niceDate(i.po.reviewed_at)}` : ""}`, c: "t-green" } : statusLine(i), conf = i.po?.confidence != null ? Number(i.po.confidence) : null;
                return (
                  <button key={`s${i.po_id}`} className={`f1-item${picked?.po_id === i.po_id ? " on" : ""}`} onClick={() => { setPicked(i); setEditing(false); }}>
                    <div className="f1-ih"><span className={`ktag ${i.po?.status === "approved" ? "k-green" : i.po?.status === "rejected" ? "k-grey" : "k-amber"}`}>{i.po?.status === "approved" ? "Approved" : i.po?.status === "rejected" ? "Rejected" : "In review"}</span><small>{i.po?.po_date ? niceDate(i.po.po_date) : niceDate(i.detected_at)}</small></div>
                    <b>{i.po?.client_name ?? "?"} · {i.po?.project_name ?? ""}</b>
                    <small>{i.po?.po_number}{(i.po?.version ?? 1) > 1 ? ` v${i.po?.version}` : ""} · {i.po?.project_number ?? "no project number"} · {inr(i.po?.total_value)}</small>
                    <div className="f1-conf"><i style={{ width: `${(conf ?? 0) * 100}%`, background: conf == null ? "var(--raised)" : conf >= GATE ? "var(--green)" : "var(--amber)" }} /><span>{conf != null ? `${Math.round(conf * 100)}%` : "—"}</span></div>
                    <small className={st.c}>{st.t}</small>
                  </button>
                );
              })}
              {results && !results.length && !searching && <div className="empty">No POs match “{q.trim()}”. Try a client name, part of the PO number, or an R-number.</div>}
            </>
          ) : <>
          <div className="dhead"><h2>Detected</h2><span className="pill sm">Newest</span></div>
          {items.length ? items.map((i) => {
            const kt = kindTag(i), st = statusLine(i), conf = i.po?.confidence != null ? Number(i.po.confidence) : null;
            return (
              <button key={i.id} className={`f1-item${!picked && cur?.id === i.id ? " on" : ""}`} onClick={() => { setPicked(null); setSel(i.id); setEditing(false); }}>
                <div className="f1-ih"><span className={`ktag ${kt.c}`}>{kt.t}</span><small>{niceDate(i.received_at ?? i.detected_at)}</small></div>
                <b>{i.po ? `${i.po.client_name ?? "?"} · ${i.po.project_name ?? ""}` : i.subject ?? i.attachment_name ?? "Document"}</b>
                <small>{i.po ? `${i.po.po_number}${i.po.version > 1 ? ` v${i.po.version}` : ""} · ${i.matched_project_number ?? "no project number yet"}` : `${i.attachment_name ?? ""}${i.attachment_pages ? ` · ${i.attachment_pages} pages` : ""}`}</small>
                <div className="f1-conf"><i style={{ width: `${(conf ?? 0) * 100}%`, background: conf == null ? "var(--raised)" : conf >= GATE ? "var(--green)" : "var(--amber)" }} /><span>{conf != null ? `${Math.round(conf * 100)}%` : "—"}</span></div>
                <small className={st.c}>{st.t}</small>
              </button>
            );
          }) : <div className="empty">Nothing detected yet. Load POs from a folder (npm run load-pos), upload one, or ask an assistant to stage it through Connect AI.</div>}
          {box.skipped.length > 0 && <p className="note" style={{ marginTop: 12 }}>{box.skipped.length} document(s) that are not POs are listed under Activity.</p>}
          <p className="note" style={{ marginTop: 12 }}>Emails that are not POs (quotes, RFQs, vendor invoices) are skipped and listed under Activity.</p>
          </>}
        </section>

        <section className="card f1-main">
          {!cur ? <div className="empty">Select a detected document.</div> : !cur.po ? (
            <>
              <span className="ktag k-grey">Detected</span>
              <h2 className="f1-title">{cur.subject ?? cur.attachment_name}</h2>
              <p className="note">{cur.sender ?? ""} · {cur.source} · {niceDate(cur.received_at ?? cur.detected_at)}</p>
              <div className="banner">{cur.skip_reason ?? "Not extracted yet. An assistant (Connect AI) reads the document and stages it with stage_po."}</div>
              {cur.file_path && <div className="row" style={{ marginTop: 14 }}><button className="pill" onClick={async () => { const r = await poFileUrl(cur.id); if (r.ok) window.open(r.url, "_blank", "noopener"); else toast(r.message); }}>Open source file</button></div>}
              {can(role, "po.review") && <div className="row" style={{ marginTop: 14 }}><button className="pill" disabled={pending} onClick={() => run(notAPo({ inbox_id: cur.id, reason: "Not a purchase order" }))}>Not a PO</button></div>}
            </>
          ) : (
            <Selected key={cur.po_id ?? cur.id} item={cur} full={full} loading={loading} role={role} run={run} pending={pending} toast={toast} editing={editing} setEditing={setEditing} onRevised={onRevised} />
          )}
        </section>

        <div className="f1-side">
          <section className="card f1-held">
            <div className="dhead"><h2>Why this one is held</h2>{heldItem && <span className="ktag k-amber">{heldItem.failed ? "Failed check" : "Low confidence"}</span>}</div>
            {heldItem ? <>
              <b className="f1-hname">{heldItem.po?.client_name} · {heldItem.po?.project_name}</b>
              <p>{heldItem.held}. {heldItem.failed ? "The PO cannot be merged until a reviewer corrects it or rejects it." : "A reviewer confirms the shaky fields before it can be merged."}</p>
              {heldItem.fields.filter((f) => Number(f.confidence) < GATE).map((f) => <p key={f.field} className="note">{f.field}: {f.value ?? "—"} · {Math.round(Number(f.confidence) * 100)}%{f.note ? ` · ${f.note}` : ""}</p>)}
              <div className="f1-gate">Approve still works for low-confidence (below {GATE * 100}%) and failed-check POs, after a confirm. The override is logged on the PO.</div>
              {can(role, "po.review") && <button className="pill wide" onClick={() => { setSel(heldItem.id); setEditing(true); }}>Open and correct</button>}
            </> : <p className="note">Nothing is held. Every staged PO passed its checks.</p>}
          </section>
          <section className="f1-what">
            <h2>What happens on approval</h2>
            {[`Tracker row${cur?.matched_project_number ? ` ${cur.matched_project_number}` : ""} created or updated; previous values kept in history.`, "Studio director notified of the change.", "Contract watch item for this project closes on its own when the new end date is in the future.", "Source email and file linked to the row as evidence."]
              .map((t, n) => <div key={n} className="f1-step"><i>{n + 1}</i><span>{t}</span></div>)}
          </section>
          <section className="card f1-time">
            <h2>Email to tracker</h2>
            <div className="srow"><span>Manual intake, median</span><b>Not measured</b></div>
            <div className="srow"><span>Auto-detected, median</span><b>{k.median_hours != null ? `${Math.round(k.median_hours)} hours` : "—"}</b></div>
            <p className="note">Measured from email receipt to tracker merge, so the gain is visible from week one.</p>
          </section>
        </div>
      </div>
    </>
  );
}

function Selected({ item, full, loading, role, run, pending, toast, editing, setEditing, onRevised }: { item: Item; full: Full | null; loading: boolean; role: Role; run: Run; pending: boolean; toast: (m: string) => void; editing: boolean; setEditing: (b: boolean) => void; onRevised: (poId: number) => void }) {
  const po = item.po!;
  const [pn, setPn] = useState(po.project_number ?? "");
  const [pnSuggested, setPnSuggested] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [revising, startRevise] = useTransition();
  useEffect(() => { setPn(po.project_number ?? ""); setPnSuggested(false); setForm({}); setConfirm(false); }, [po.id, po.project_number]);
  // No project number yet: suggest the next free R-number for the PO's financial year (editable).
  useEffect(() => {
    if (po.project_number || po.status !== "pending_review") return;
    let live = true;
    suggestProjectNumber(po.po_date ?? null).then((v) => { if (live && v) { setPn((cur) => cur || v); setPnSuggested(true); } });
    return () => { live = false; };
  }, [po.id, po.project_number, po.status, po.po_date]);
  const kt = kindTag(item);
  const conf = po.confidence != null ? Number(po.confidence) : null;
  const passed = item.checks.filter((c) => c.ok).length;
  const diff = (Array.isArray(po.diff) ? po.diff : []) as { field: string; from: unknown; to: unknown }[];
  const canApprove = can(role, "po.review") && po.status === "pending_review" && !!pn.trim();
  const overrideText = [item.failed ? `${item.failed} check(s) failed` : "", conf != null && conf < GATE ? `confidence is ${Math.round(conf * 100)}%` : "", item.held && !item.failed && !(conf != null && conf < GATE) ? item.held.toLowerCase() : ""].filter(Boolean).join(" and ");
  const approve = () => {
    if (item.held && !confirm) { setConfirm(true); return; }
    setConfirm(false);
    run(approveInboxPo({ id: po.id, project_number: pn.trim() || undefined }));   // the server logs any override
  };
  const fmt = (v: unknown) => v == null || v === "" ? "None" : typeof v === "number" ? inr(v) : String(v);
  const label: Record<string, string> = { end_date: "Contract end", start_date: "Contract start", total_value: "PO value", escalation_clause: "Escalation clause", contract_validity: "Validity", project_number: "Project number", client_name: "Client", project_name: "Project" };

  return (
    <>
      <div className="f1-ih"><span className={`ktag ${kt.c}`}>{kt.t}</span><span className={`ktag ${item.failed ? "k-amber" : "k-green"}`}>{passed} of {item.checks.length} checks pass</span></div>
      <h2 className="f1-title">{po.client_name} · {po.project_name}</h2>
      <p className="note">{po.po_number}{po.version > 1 ? ` v${po.version}` : ""} · {item.matched_project_number ? `matched to ${item.matched_project_number}` : "new project · Finance assigns the number"} · {inr(po.total_value)} excl. GST{po.end_date ? ` · valid to ${niceDate(po.end_date)}` : ""}</p>
      <div className="f1-big num"><b>{conf != null ? `${Math.round(conf * 100)}%` : "—"}</b><small>overall<br />confidence</small></div>
      <div className="f1-mail">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
        <div><b>{item.subject ?? po.source_ref ?? "Source document"}</b><small>{item.sender ? `From ${item.sender} · ` : ""}{item.source}{item.received_at ? ` · received ${niceDate(item.received_at)}` : ""}</small>
          <div className="row" style={{ marginTop: 10, justifyContent: "flex-start" }}>
            {item.attachment_name && <span className="pill sm">{item.attachment_name}{item.attachment_pages ? ` · ${item.attachment_pages} pages` : ""}</span>}
            {item.id > 0 && item.file_path && <button className="linkbtn" onClick={async () => { const r = await poFileUrl(item.id); if (r.ok) window.open(r.url, "_blank", "noopener"); else toast(r.message); }}>Open source file</button>}
          </div>
        </div>
      </div>

      {diff.length > 0 && <>
        <div className="dhead f1-sec"><h3>What changed</h3><span className="note">Tracker today vs this PO</span></div>
        <div className="f1-diff"><span>FIELD</span><span>IN TRACKER</span><span>IN THIS PO</span></div>
        {diff.slice(0, 8).map((d, i) => <div key={i} className="f1-drow"><b>{label[d.field] ?? d.field}</b><s>{fmt(d.from)}</s><span className="t-blue">{fmt(d.to)}</span></div>)}
      </>}

      <h3 className="f1-sec">Extracted fields</h3>
      {item.fields.length ? item.fields.map((f) => (
        <div key={f.field} className="f1-frow"><span>{f.field}</span><b>{f.value ?? "—"}</b><span className={`ktag sm ${Number(f.confidence) >= GATE ? "k-green" : "k-amber"}`}>{Math.round(Number(f.confidence) * 100)}%</span></div>
      )) : <p className="note">Staged without per-field confidence (overall {conf != null ? `${Math.round(conf * 100)}%` : "not given"}).</p>}
      {(po.raw as { notes?: string } | null)?.notes && <div className="banner">Extractor notes: {(po.raw as { notes?: string }).notes}</div>}

      <h3 className="f1-sec">Checks</h3>
      {item.checks.map((c, i) => <div key={i} className={`f1-check${c.ok ? "" : c.severity === "error" ? " hard" : " soft"}`}><span>{c.ok ? "✓" : c.severity === "error" ? "✕" : "!"}</span><div><b>{c.rule}</b><small>{c.detail}</small></div></div>)}

      {item.notes.length > 0 && <>
        <h3 className="f1-sec">Suggested fixes <span className="note">from the PO intake agent · nothing is changed until you edit the fields</span></h3>
        {item.notes.map((n) => (
          <div key={n.id} className={`f1-check${n.status === "open" ? " soft" : ""}`}>
            <span>{n.status === "applied" ? "✓" : n.status === "dismissed" ? "–" : "→"}</span>
            <div>
              <b>{n.suggestion}</b>
              <small>{n.check_rule}{n.proposed_value ? ` · use: ${n.proposed_value}` : ""}</small>
              <small>Evidence: {n.evidence}</small>
              {n.status === "open" && can(role, "po.review") && po.status === "pending_review" ? (
                <div className="row" style={{ marginTop: 6 }}>
                  <button className="pill" disabled={pending} onClick={() => { setEditing(true); run(decideReviewNoteAction({ id: n.id, decision: "applied" })); }}>Apply (edit fields)</button>
                  <button className="pill" disabled={pending} onClick={() => run(decideReviewNoteAction({ id: n.id, decision: "dismissed" }))}>Dismiss</button>
                </div>
              ) : n.status !== "open" && <small>{n.status === "applied" ? "Applied" : "Dismissed"}</small>}
            </div>
          </div>
        ))}
      </>}

      {full && <>
        <h3 className="f1-sec">Studio split and stages {loading && <span className="note">loading…</span>}</h3>
        {full.lines.map((l) => <div key={l.id} className="f1-frow"><span>{l.studio}</span><b>{l.split_pct != null ? `${(Number(l.split_pct) * 100).toFixed(1)}%` : ""}</b><span className="num">{inr(l.split_value)}</span></div>)}
        <div className="po-stages">{full.stages.map((s) => <div key={s.id}><span>{s.studio} · {s.seq}</span><span>{s.stage}</span><span className="num">{((s.pct ?? 0) * 100).toFixed(2)}%</span><span className="num">{inr(s.fee)}</span></div>)}</div>
      </>}

      {editing && full && can(role, "po.review") && po.status === "pending_review" && (
        <form className="f1-edit" onSubmit={(e) => {
          e.preventDefault();
          const patch: Record<string, unknown> = {};
          for (const [kk, v] of Object.entries(form)) if (v !== "" && !kk.startsWith("line:") && !kk.startsWith("stage:")) patch[kk] = kk === "total_value" ? Number(v) : v;
          const lines = Object.entries(form).filter(([kk, v]) => kk.startsWith("line:") && v !== "").map(([kk, v]) => ({ studio: kk.slice(5), split_value: Number(v) }));
          const stages = Object.entries(form).filter(([kk, v]) => kk.startsWith("stage:") && v !== "").map(([kk, v]) => ({ id: Number(kk.slice(6)), pct: Number(v) / 100 }));
          if (lines.length) patch.lines = lines; if (stages.length) patch.stages = stages;
          run(correctPoAction({ id: po.id, patch: patch as never })); setEditing(false);
        }}>
          <h3>Correct the extraction</h3>
          <div className="f1-egrid">
            {([["client_name", "Client", po.client_name], ["project_name", "Project name", po.project_name], ["location", "Location", (po.raw as { location?: string } | null)?.location ?? null], ["project_type", "Project type", (po.raw as { project_type?: string } | null)?.project_type ?? null], ["po_date", "PO date (YYYY-MM-DD)", po.po_date], ["project_number", "Project number", po.project_number], ["total_value", "PO value (₹, excl. GST)", po.total_value], ["start_date", "Start date (YYYY-MM-DD)", po.start_date], ["end_date", "End date (YYYY-MM-DD)", po.end_date], ["contract_validity", "Validity", po.contract_validity], ["escalation_clause", "Escalation clause", po.escalation_clause]] as const).map(([kk, lab, v]) => (
              <label key={kk}>{lab}<input className="field" placeholder={v != null ? String(v) : ""} value={form[kk] ?? ""} onChange={(e) => setForm({ ...form, [kk]: e.target.value })} /></label>
            ))}
            {full.lines.map((l) => <label key={l.id}>{l.studio} split (₹)<input className="field" placeholder={String(l.split_value ?? "")} value={form[`line:${l.studio}`] ?? ""} onChange={(e) => setForm({ ...form, [`line:${l.studio}`]: e.target.value })} /></label>)}
            {full.stages.map((s) => <label key={s.id}>{s.studio} · stage {s.seq} %<input className="field" placeholder={((s.pct ?? 0) * 100).toFixed(2)} value={form[`stage:${s.id}`] ?? ""} onChange={(e) => setForm({ ...form, [`stage:${s.id}`]: e.target.value })} /></label>)}
          </div>
          <p className="note">Leave a field empty to keep the extracted value. Saving re-runs every check and marks the corrected fields as verified.</p>
          <div className="row"><button type="button" className="pill" onClick={() => setEditing(false)}>Cancel</button><button className="pill pink" disabled={pending}>Save and re-check</button></div>
        </form>
      )}

      {po.status === "pending_review" && can(role, "po.review") ? (
        <>
        {confirm && <div className="f1-override" role="alert"><b>Approve anyway?</b> {overrideText ? `${overrideText[0].toUpperCase()}${overrideText.slice(1)}.` : ""} Approving writes this PO into the tracker tables now, and the override is logged against it. <button type="button" className="linkbtn" onClick={() => setConfirm(false)}>Cancel</button></div>}
        <div className="f1-acts">
          <label className="f1-pn">Project number{pnSuggested && pn && !po.project_number ? <small> · suggested</small> : null}<input className="field" value={pn} onChange={(e) => { setPn(e.target.value); setPnSuggested(false); }} placeholder="R-2627-001" /></label>
          <button className={`pill pink${confirm ? " f1-confirm" : ""}`} disabled={!canApprove || pending} title={!pn.trim() ? "Set the project number" : item.held ? `Held: ${item.held}. Approve writes it anyway after a confirm.` : ""} onClick={approve}>{confirm ? "Confirm and approve" : item.held ? "Approve anyway" : "Approve into tracker"}</button>
          <button className="pill" onClick={() => setEditing(!editing)}>Edit fields</button>
          <button className="pill" disabled={pending} onClick={() => { const note = prompt("Reason for rejecting"); if (note) run(reviewPoAction({ id: po.id, decision: "rejected", note })); }}>Reject</button>
          {item.id > 0 && <button className="pill" disabled={pending} onClick={() => run(notAPo({ inbox_id: item.id, reason: "Not a purchase order" }))}>Not a PO</button>}
        </div>
        </>
      ) : (
        <div className="f1-done">
          <p className="note">{po.status === "approved" ? `Approved by ${po.reviewed_by ?? "?"}${po.reviewed_at ? ` on ${niceDate(po.reviewed_at)}` : ""}${po.project_number ? ` as ${po.project_number}` : ""}.` : po.status === "rejected" ? `Rejected: ${po.review_note ?? ""}` : "Your role can view, not approve."}{po.review_note && po.status === "approved" ? ` Note: ${po.review_note}` : ""}</p>
          {can(role, "po.review") && (po.status === "approved" || po.status === "rejected") && (
            <button className="pill" disabled={revising || pending} onClick={() => startRevise(async () => { const r = await revisePoAction(po.id); toast(r.message); if (r.ok) onRevised(r.po_id); })}>{revising ? "Opening…" : "Edit as new version"}</button>
          )}
        </div>
      )}
      <p className="note" style={{ textAlign: "right", marginTop: 8 }}>Approval writes to the tracker exactly as manual intake does today.</p>
    </>
  );
}

export function PoActivity({ box }: { box: Box | null }) {
  if (!box) return null;
  return (
    <div className="f1-act">
      <section className="card">
        <h2>Scan and load runs</h2>
        {box.runs.length ? box.runs.map((r) => <div className="krow" key={r.id}><div className="t"><b>{r.source} · {r.detected} detected · {r.skipped} skipped · {r.scanned} scanned</b><small>{niceDate(r.started_at)} {timeOf(r.started_at)} · {r.run_by ?? ""}{r.error ? ` · ${r.error}` : ""}</small></div><span className={`tag ${r.ok ? "t-green" : "t-pink"}`}>{r.ok ? "OK" : "Failed"}</span></div>) : <div className="empty">No runs yet.</div>}
      </section>
      <section className="card">
        <h2>Skipped (not a PO)</h2>
        {box.skipped.length ? box.skipped.map((s) => <div className="krow" key={s.id}><div className="t"><b>{s.subject ?? s.attachment_name}</b><small>{s.sender ?? s.source} · {s.skip_reason}</small></div></div>) : <div className="empty">Nothing skipped.</div>}
      </section>
      <section className="card">
        <h2>Tracker change log</h2>
        {box.history.length ? box.history.map((h, i) => <div className="krow" key={i}><div className="t"><b>{h.project_number} · {h.studio} · {h.field}</b><small>{h.old_value ?? "—"} → {h.new_value ?? "—"} · {h.changed_by} · {niceDate(h.changed_at)}</small></div></div>) : <div className="empty">No merges yet. Every approved change is logged here with its previous value.</div>}
      </section>
    </div>
  );
}

// Manual PO intake: upload a PO PDF; the server stores it, reads it with OCR, runs the checks and stages it here for review.
const STEPS = ["Uploading the PDF", "Reading pages (OCR)", "Extracting PO fields", "Running tracker checks"];
function ManualIntake({ onDone, toast }: { onDone: (inboxId: number) => void; toast: (m: string) => void }) {
  const router = useRouter();
  const dlg = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [step, setStep] = useState(-1);
  const [res, setRes] = useState<{ ok: boolean; message: string; inbox_id?: number; is_po?: boolean; confidence?: number; fields?: number; low?: number; failed?: number; existed?: boolean } | null>(null);
  const busy = step >= 0 && !res;
  const pick = (f: File | null | undefined) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) { toast("Choose a PDF file."); return; }
    if (f.size > 20 * 1024 * 1024) { toast("The PDF is larger than 20 MB."); return; }
    setFile(f); setRes(null); setStep(-1);
  };
  const open = () => { setFile(null); setRes(null); setStep(-1); dlg.current?.showModal(); };
  const close = () => { if (!busy) dlg.current?.close(); };
  const upload = async () => {
    if (!file) return;
    setRes(null); setStep(0);
    // One request does all four steps; advance the indicator while it runs.
    const t = [setTimeout(() => setStep(1), 1200), setTimeout(() => setStep(2), 9000), setTimeout(() => setStep(3), 22000)];
    const fd = new FormData(); fd.append("file", file);
    try {
      const r = await fetch("/api/po-upload", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({ ok: false, message: `Upload failed (${r.status}).` }));
      setStep(4); setRes(j);
      if (j.ok) router.refresh();
    } catch { setRes({ ok: false, message: "Network error. Try again." }); }
    finally { t.forEach(clearTimeout); }
  };
  const review = () => { if (res?.inbox_id) onDone(res.inbox_id); dlg.current?.close(); };
  const kb = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

  return (
    <>
      <button type="button" className="pill pink sm f1-manual" onClick={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
        Manual PO intake
      </button>
      <dialog ref={dlg} className="f1-up" onCancel={(e) => { if (busy) e.preventDefault(); }} onClick={(e) => { if (e.target === dlg.current) close(); }}>
        <div className="f1-up-in">
          <div className="f1-up-h">
            <div><small>F1 · Manual PO intake</small><h2>Upload a purchase order</h2></div>
            <button type="button" className="f1-up-x" aria-label="Close" onClick={close} disabled={busy}><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg></button>
          </div>
          <p className="note">PDF only, up to 20 MB. Scanned POs are read with OCR. Every field gets a confidence score, and nothing reaches the tracker until a reviewer approves it.</p>

          {!busy && !res && (
            <div className={`f1-drop${over ? " over" : ""}${file ? " has" : ""}`} role="button" tabIndex={0}
              onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
              <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
              {file ? (
                <div className="f1-file">
                  <span className="f1-pdf">PDF</span>
                  <div><b>{file.name}</b><small>{kb(file.size)} · ready to read</small></div>
                  <button type="button" className="linkbtn" onClick={(e) => { e.stopPropagation(); setFile(null); }}>Change</button>
                </div>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 18v-6m0 0-2.5 2.5M12 12l2.5 2.5" /></svg>
                  <b>Drop the PO PDF here</b>
                  <small>or click to choose a file</small>
                </>
              )}
            </div>
          )}

          {step >= 0 && (
            <ol className="f1-steps">
              {STEPS.map((t, n) => {
                const state = res ? (res.ok ? "done" : n < step ? "done" : n === Math.min(step, 3) ? "err" : "") : n < step ? "done" : n === step ? "run" : "";
                return <li key={t} className={state}><i>{state === "done" ? "✓" : state === "err" ? "!" : n + 1}</i><span>{t}</span>{state === "run" && <em className="f1-spin" />}</li>;
              })}
            </ol>
          )}

          {res && (
            <div className={`f1-res ${!res.ok ? "bad" : res.is_po === false ? "warn" : (res.failed || res.low) ? "warn" : "good"}`}>
              <b>{!res.ok ? "Could not stage this PDF" : res.existed ? "Already uploaded" : res.is_po === false ? "Not recognised as a PO" : (res.failed || res.low) ? "Staged · needs a reviewer" : "Staged · ready to approve"}</b>
              <p>{res.message}</p>
              {res.ok && res.is_po && <div className="f1-res-k num">
                <span><b>{res.confidence != null ? `${Math.round(res.confidence * 100)}%` : "—"}</b>confidence</span>
                <span><b>{res.fields ?? 0}</b>fields read</span>
                <span><b>{res.low ?? 0}</b>to confirm</span>
                <span><b>{res.failed ?? 0}</b>checks failed</span>
              </div>}
            </div>
          )}

          <div className="f1-up-f">
            {!res ? <>
              <button type="button" className="pill" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="pill pink" disabled={!file || busy} onClick={upload}>{busy ? "Reading…" : "Upload and read"}</button>
            </> : <>
              <button type="button" className="pill" onClick={() => { setFile(null); setRes(null); setStep(-1); }}>Upload another</button>
              {res.ok && res.inbox_id ? <button type="button" className="pill pink" onClick={review}>Review fields</button> : <button type="button" className="pill pink" onClick={() => setRes(null)}>Try again</button>}
            </>}
          </div>
        </div>
      </dialog>
    </>
  );
}

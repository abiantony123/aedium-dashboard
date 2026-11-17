"use client";
import { useState } from "react";
import type { Dash } from "@/lib/data";
import { inr, greeting } from "@/lib/format";

const CHIPS = ["Where is the leakage this month?", "Which contracts expire this quarter?", "What is billable in the next 90 days?", "Which studio has the most left to bill?"];
const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

export default function Ask({ d, studioPick, starter, starterSource }: { d: Dash & { studio: string | null }; studioPick: React.ReactNode; starter: string; starterSource: "llm" | "rules" }) {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [trace, setTrace] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showQuery, setShowQuery] = useState(false);
  const k = d.kpi;
  const old = d.old;
  const projects = [...new Set(old.map((i) => i.project_name ?? i.customer_name))];
  const total = old.reduce((s, i) => s + i.balance, 0);
  const largest = [...old].sort((a, b) => b.balance - a.balance)[0];
  const maxD = old[0]?.days_overdue || 1;

  async function ask(text: string) {
    const t = text.trim(); if (!t || busy) return;
    setAsked(t); setAnswer(null); setTrace([]); setBusy(true); setShowQuery(false);
    try {
      const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: t, studio: d.studio }) });
      const j = await r.json();
      setAnswer(j.answer ?? j.error ?? "No answer came back."); setTrace(j.trace ?? []);
    } catch { setAnswer("The request did not reach the server. Check your connection and try again."); }
    finally { setBusy(false); }
  }

  return (
    <>
      <section className="card askhero">
        <div className="eyebrow">Ask the practice</div>
        <h1>{greeting()}. <em>What do you want to know?</em></h1>
        <form className="askbar" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
          <input id="askInput" aria-label="Question" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about projects, invoices, studios, contracts or billing" />
          {studioPick}
          <button className="pill pink" disabled={busy}>{busy ? "Asking…" : "Ask"}</button>
        </form>
        <div className="qchips">{CHIPS.map((c) => <button key={c} onClick={() => { setQ(c); ask(c); }}>{c}</button>)}</div>
      </section>
      <div className="d-grid">
        <section className="card answer">
          <div className="ubub"><span>{asked ?? "Which invoices are more than 90 days overdue?"}</span></div>
          {asked ? (
            <>
              <div className={`abub${busy ? " wait" : ""}`}>{busy ? "Reading the tracker and Zoho Books…" : answer}</div>
              <div className="qsrc">{busy ? "Working" : trace.length ? `Answered by Claude from ${trace.length} lookup${trace.length > 1 ? "s" : ""} in Supabase` : "Answered without a data lookup: check before relying on it"}
                {!busy && trace.length > 0 && <a href="#ask" onClick={(e) => { e.preventDefault(); setShowQuery(!showQuery); }}>{showQuery ? "Hide the query" : "Show the query"}</a>}</div>
              {showQuery && <pre className="qtrace">{trace.join("\n")}</pre>}
            </>
          ) : (
            <>
              <div className="abub swap" key={starterSource}>{starter}</div>
              {old.length > 0 && <>
                <div className="thead"><span>INVOICE · AMOUNT</span><span>DAYS OVERDUE</span></div>
                {old.map((i) => (
                  <div className="irow num" key={i.invoice_id}><b>{i.invoice_number} <span>· {inr(i.balance)}</span></b>
                    <div className="bar"><i style={{ width: `${(i.days_overdue / maxD) * 100}%`, background: i.days_overdue >= 150 ? "var(--pink)" : "var(--blue-soft)" }} /></div><em>{i.days_overdue}</em></div>
                ))}
              </>}
              <div className="qsrc">Figures from the Zoho Books ageing view{d.zohoIsSample ? " (sample data)" : ""} · {starterSource === "llm" ? "worded by AI from rule findings" : "rule text"}<a href="#ask" onClick={(e) => { e.preventDefault(); setShowQuery(!showQuery); }}>{showQuery ? "Hide the query" : "Show the query"}</a></div>
              {showQuery && <pre className="qtrace">{`select * from v_open_invoices where bucket = '90+' order by days_overdue desc\n-> ${old.length} rows, ${inr(total)}`}</pre>}
            </>
          )}
          <div className="btns"><a className="pill solid" href="#agents">Draft reminders</a><button className="pill" onClick={() => { setAsked(null); setAnswer(null); }}>Back to starter</button></div>
        </section>
        <div className="d-right">
          <section className="card pinned">
            <div className="phead"><h2>Pinned</h2><small>Cached, not AI-generated</small></div>
            <div className="tiles num">
              <div className="tile"><b>{inr(k.contract)}</b><span>Contract value</span></div>
              <div className="tile"><b>{inr(k.billedMonth)}</b><span>Billed in month</span></div>
              <div className="tile"><b>{inr(k.collectedMonth)}</b><span>Collected</span></div>
              <div className="tile"><b>{inr(k.outstanding)}</b><span>Outstanding</span></div>
              <div className="tile"><b>{inr(k.late)}</b><span>Late</span></div>
              <div className="tile"><b>{inr(k.yetToBill)}</b><span>Yet to bill</span></div>
            </div>
          </section>
          <section className="card evid">
            <h2>Evidence from email</h2>
            <q>&quot;What was agreed about extending the [project] timeline?&quot;</q>
            <div className="mail"><b>[Email subject]</b><span>[Sender role] to [client role] · [date]</span><i>[Quoted sentence that supports the answer]</i></div>
            <p>Not connected yet. Needs the Outlook connection; HR, legal and partner mail will not be indexed.</p>
          </section>
          <section className="card asked">
            <h2>Try asking</h2>
            {["Which projects have the most left to bill?", "How much did we bill each month this year?", "What is still to bill on our largest project?"].map((x) => <div className="qrow" key={x} role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => { setQ(x); ask(x); }} onKeyDown={(e) => { if (e.key === "Enter") { setQ(x); ask(x); } }}>{x}</div>)}
          </section>
        </div>
      </div>
    </>
  );
}

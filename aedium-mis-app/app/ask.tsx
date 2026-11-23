"use client";
// Ask tab: an AI copilot. An empty chat is a greeting with a large centred input (ChatGPT/Claude style)
// and suggestions; once a question is asked the input moves to the bottom of the conversation.
// Every answer shows its lookups; follow-ups carry the earlier turns.
import { useEffect, useRef, useState } from "react";
import type { Dash } from "@/lib/data";
import { greeting } from "@/lib/format";

const SUGGEST: { tag: string; q: string }[] = [
  { tag: "Overdue", q: "Which invoices are more than 90 days overdue?" },
  { tag: "Leakage", q: "Where is the leakage this month?" },
  { tag: "Contracts", q: "Which contracts expire this quarter?" },
  { tag: "Billing", q: "What is billable in the next 90 days?" },
  { tag: "Studios", q: "Which studio has the most left to bill?" },
  { tag: "Trend", q: "How much did we bill each month this year?" },
];

type Turn = { id: number; q: string; a: string | null; trace: string[]; error?: boolean };

// `starter` / `starterSource` are still passed by the dashboard; the copilot no longer shows a starter message.
export default function Ask({ d, studioPick }: { d: Dash & { studio: string | null }; studioPick: React.ReactNode; starter?: string; starterSource?: "llm" | "rules" }) {
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const busy = turns.some((t) => t.a === null);
  const empty = turns.length === 0;
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (turns.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns]);
  useEffect(() => { const b = boxRef.current; if (b) { b.style.height = "auto"; b.style.height = `${Math.min(b.scrollHeight, empty ? 220 : 160)}px`; } }, [q, empty]);

  async function ask(text: string) {
    const t = text.trim(); if (!t || busy) return;
    const id = Date.now();
    const history = turns.filter((x) => x.a && !x.error).slice(-4).map((x) => ({ q: x.q, a: x.a! }));
    setTurns((p) => [...p, { id, q: t, a: null, trace: [] }]); setQ("");
    const done = (patch: Partial<Turn>) => setTurns((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: t, studio: d.studio, history }) });
      const j = await r.json();
      done({ a: j.answer ?? j.error ?? "No answer came back.", trace: j.trace ?? [], error: !j.answer });
    } catch { done({ a: "The request did not reach the server. Check your connection and try again.", error: true }); }
  }

  const copy = async (t: Turn) => { try { await navigator.clipboard.writeText(t.a ?? ""); setCopied(t.id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ } };

  const composer = (
    <form className={`cp-compose${empty ? " big" : ""}`} onSubmit={(e) => { e.preventDefault(); ask(q); }}>
      <textarea ref={boxRef} id="askInput" rows={empty ? 3 : 1} aria-label="Question" value={q} autoFocus={empty} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(q); } }}
        placeholder={empty ? "Ask anything about projects, invoices, studios, contracts or billing…" : "Ask a follow-up…"} />
      <div className="cp-tools">
        {studioPick}
        <button className="cp-send" disabled={busy || !q.trim()} aria-label="Send">{busy ? "…" : "↑"}</button>
      </div>
    </form>
  );

  return (
    <section className={`card cp${empty ? " is-empty" : ""}`}>
      <header className="cp-head">
        <div className="cp-id"><span className="cp-logo" aria-hidden>✦</span><div><b>Aedium Copilot</b><small>Answers from the master tracker and Zoho Books{d.zohoIsSample ? " (sample)" : ""}</small></div></div>
        {!empty && <button className="cp-new" onClick={() => { setTurns([]); setOpen(null); }} disabled={busy}>New chat</button>}
      </header>

      {empty ? (
        <div className="cp-start">
          <h1>{greeting()}. <em>What do you want to know?</em></h1>
          {composer}
          <div className="cp-sugg">
            {SUGGEST.map((s) => <button key={s.q} onClick={() => ask(s.q)}><small>{s.tag}</small>{s.q}</button>)}
          </div>
          <p className="cp-note">Read-only: the copilot looks data up but never changes it. Every answer shows the lookups behind it.</p>
        </div>
      ) : (
        <>
          <div className="cp-thread" aria-live="polite">
            {turns.map((t) => (
              <div key={t.id} className="cp-turn">
                <div className="cp-msg me"><div className="cp-text">{t.q}</div></div>
                <div className="cp-msg ai">
                  <span className="cp-av" aria-hidden>✦</span>
                  <div className="cp-body">
                    {t.a === null ? (
                      <div className="cp-text cp-wait"><span className="cp-dots" aria-hidden><i /><i /><i /></span>Reading the tracker and Zoho Books…</div>
                    ) : (
                      <>
                        <div className={`cp-text${t.error ? " err" : ""}`}>{t.a}</div>
                        {!t.error && (
                          <div className="cp-foot">
                            <span>{t.trace.length ? `${t.trace.length} lookup${t.trace.length > 1 ? "s" : ""} in Supabase` : "No data lookup: check before relying on it"}</span>
                            {t.trace.length > 0 && <button className="cp-act" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? "Hide sources" : "Sources"}</button>}
                            <button className="cp-act" onClick={() => copy(t)}>{copied === t.id ? "Copied" : "Copy"}</button>
                          </div>
                        )}
                        {open === t.id && <pre className="qtrace">{t.trace.join("\n")}</pre>}
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          {composer}
          <p className="cp-note">Enter to send · Shift+Enter for a new line</p>
        </>
      )}
    </section>
  );
}

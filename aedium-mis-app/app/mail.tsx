"use client";
import { useMemo, useState } from "react";
import type { ClientNode, Dash } from "@/lib/data";
import { inr, niceDate, timeOf } from "@/lib/format";
import type { AgentName } from "@/lib/agents/actions";

type Note = { id: number; title: string; body: string | null; tab: string | null; created_at: string; read_at: string | null };
type ThreadMsg = { id: string; tag: string; tone: string; from: string; to: string; subject: string; date: string; body: string };

const domainOf = (client: string) => (client.toLowerCase().replace(/[^a-z0-9]+/g, "") || "client") + ".in";

// Mocked Outlook / Microsoft Graph mail view: dynamic project threads from tracker + Finance/Agent outbox (R18).
export default function MailTab({
  projects, clients, open, notifications, onDraft, toast,
}: {
  projects: Dash["timeline"];
  clients: ClientNode[];
  open: Dash["open"];
  notifications: Note[];
  onDraft?: (agent: AgentName, ref: string) => void;
  toast?: (m: string) => void;
}) {
  const [view, setView] = useState<"threads" | "outbox">("threads");
  const [q, setQ] = useState("");
  const [logged, setLogged] = useState<Record<string, ThreadMsg[]>>({});
  const [replySub, setReplySub] = useState("");
  const [replyBody, setReplyBody] = useState("");

  const items = useMemo(() => {
    const seen = new Set<string>();
    const list: { project_number: string; client: string; name: string; location: string | null; type: string | null; contract: number; billed: number; yetToBill: number; studios: { studio: string | null; value: number; stage: string | null }[] }[] = [];
    for (const c of clients) {
      for (const p of c.projects) {
        if (seen.has(p.project_number)) continue;
        seen.add(p.project_number);
        list.push({
          project_number: p.project_number, client: c.client, name: p.name ?? p.project_number,
          location: p.location, type: p.type, contract: p.contract, billed: p.billed, yetToBill: p.yetToBill,
          studios: p.studios,
        });
      }
    }
    for (const l of projects) {
      if (seen.has(l.project_number)) continue;
      seen.add(l.project_number);
      list.push({
        project_number: l.project_number, client: l.client_name ?? l.project_number, name: l.project_name ?? l.project_number,
        location: l.location, type: l.project_type, contract: Number(l.split_value ?? 0), billed: Number(l.billed_amount ?? 0), yetToBill: Number(l.yet_to_bill_amount ?? 0),
        studios: [{ studio: l.studio, value: Number(l.split_value ?? 0), stage: l.project_stage }],
      });
    }
    return list;
  }, [clients, projects]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const xs = needle ? items.filter((p) => `${p.client} ${p.name} ${p.project_number} ${p.studios.map((s) => s.studio).join(" ")}`.toLowerCase().includes(needle)) : items;
    return xs.slice(0, 30);
  }, [items, q]);

  const [picked, setPicked] = useState<string>("");
  const selected = filtered.find((p) => p.project_number === picked) ?? filtered[0] ?? null;

  const threads = useMemo<ThreadMsg[]>(() => {
    if (!selected) return [];
    const dom = domainOf(selected.client);
    const primaryStudio = selected.studios[0]?.studio ?? "Architecture";
    const stageName = selected.studios.find((s) => s.stage)?.stage ?? "Design Deliverable";
    const splitSummary = selected.studios.map((s) => `${s.studio ?? "Studio"} (${inr(s.value)})`).join(", ");
    const projOpen = open.filter((o) => o.project_number === selected.project_number || o.customer_name?.toLowerCase().includes(selected.client.toLowerCase()));
    const overdue = projOpen[0];
    const billedPct = selected.contract ? Math.round((selected.billed / selected.contract) * 100) : 0;

    const base: ThreadMsg[] = [
      {
        id: `${selected.project_number}-po`,
        tag: "PO Intake source",
        tone: "t-blue",
        from: `contracts@${dom}`,
        to: "bd@aedium.in, mis@aedium.in",
        subject: `Work Order & Fee Split — ${selected.name} (${selected.project_number})`,
        date: "Contract onboarding",
        body: `Confirmed consultancy appointment for ${selected.name}${selected.location ? ` (${selected.location})` : ""} totaling ${inr(selected.contract)} excl. GST across ${splitSummary}. Standard 30-day invoice terms apply per agreed stage schedule.`,
      },
      {
        id: `${selected.project_number}-signoff`,
        tag: "Cited by Stage-to-Cash",
        tone: "t-green",
        from: `pm@${dom}`,
        to: `${primaryStudio.toLowerCase().replace(/[^a-z]+/g, "")}@aedium.in`,
        subject: `Re: ${stageName} deliverable sign-off — ${selected.project_number} (${primaryStudio})`,
        date: "Recent milestone",
        body: `We have reviewed the ${stageName} submission for ${selected.name} and approve proceeding to the next milestone. Please share the corresponding stage invoice with our accounts team.`,
      },
      {
        id: `${selected.project_number}-billing`,
        tag: overdue ? "Collections watch" : "Contract watch",
        tone: overdue ? "t-pink" : "t-amber",
        from: "accounts@aedium.in",
        to: `accounts@${dom}`,
        subject: overdue
          ? `Payment status: ${overdue.invoice_number} (${inr(overdue.balance)}, ${overdue.days_overdue} days overdue)`
          : `Billing & schedule summary — ${selected.project_number}`,
        date: overdue ? `Due ${niceDate(overdue.due_date)}` : "Active schedule",
        body: overdue
          ? `Following up on invoice ${overdue.invoice_number} for ${inr(overdue.balance)} (${overdue.days_overdue} days past due). Total project billing stands at ${billedPct}% (${inr(selected.yetToBill)} remaining to bill).`
          : `${billedPct}% of ${inr(selected.contract)} billed to date; ${inr(selected.yetToBill)} remains in the pipeline across ${selected.studios.length} studio line(s).`,
      },
    ];
    return [...base, ...(logged[selected.project_number] ?? [])];
  }, [selected, open, logged]);

  return (
    <>
      <div className="eyebrow">Mail · Outlook / Microsoft Graph (demo mirror)</div>
      <div className="e-head">
        <div>
          <h1>Every client conversation, <em>filed by project.</em></h1>
          <p className="lede">Client approvals, PO attachments and Finance notification emails matched by project number and client domain (Outlook / Graph mock for demo).</p>
        </div>
        <div className="seg" role="group" aria-label="Mail view">
          <button aria-pressed={view === "threads"} onClick={() => setView("threads")}>Project threads (Outlook mock)</button>
          <button aria-pressed={view === "outbox"} onClick={() => setView("outbox")}>Finance &amp; Agent Outbox ({notifications.length})</button>
        </div>
      </div>

      {view === "threads" ? (
        <div className="m-grid">
          <section className="card m-list" aria-label="Projects">
            <div className="dhead"><h2>Projects</h2><span className="note">{filtered.length}</span></div>
            <input className="field m-search" type="search" aria-label="Filter projects" placeholder="Search client or project…" value={q} onChange={(e) => setQ(e.target.value)} />
            {filtered.map((p) => {
              const count = 3 + (logged[p.project_number]?.length ?? 0);
              const active = selected?.project_number === p.project_number;
              return (
                <button type="button" className={`m-proj m-pick${active ? " on" : ""}`} key={p.project_number} onClick={() => setPicked(p.project_number)}>
                  <b>{p.client}</b>
                  <small>{p.project_number} · {p.studios.map((s) => s.studio).filter(Boolean).join(", ")}</small>
                  <span className="tag t-grey">{count} threads</span>
                </button>
              );
            })}
            {filtered.length === 0 && <p className="note">No matching projects.</p>}
          </section>

          <section className="card m-thread">
            {selected ? (
              <>
                <div className="dhead">
                  <div>
                    <h2>{selected.name}</h2>
                    <span className="note">{selected.client} · {selected.project_number} · {inr(selected.contract)} contract · {inr(selected.yetToBill)} to bill</span>
                  </div>
                  <span className="tag t-green">Outlook mock connected</span>
                </div>
                <div className="m-msgs">
                  {threads.map((m) => (
                    <article className="m-msg" key={m.id}>
                      <div className="dmeta"><span className={`tag ${m.tone}`}>{m.tag}</span><span>{m.date}</span></div>
                      <h3>{m.subject}</h3>
                      <div className="m-addr">From <b>{m.from}</b> → {m.to}</div>
                      <p>{m.body}</p>
                    </article>
                  ))}
                </div>
                <form className="m-log" onSubmit={(e) => {
                  e.preventDefault();
                  const sub = replySub.trim() || `Re: ${selected.name} (${selected.project_number})`;
                  const body = replyBody.trim();
                  if (!body) return;
                  const entry: ThreadMsg = {
                    id: `${selected.project_number}-${Date.now()}`,
                    tag: "Logged reply",
                    tone: "t-blue",
                    from: `client@${domainOf(selected.client)}`,
                    to: "team@aedium.in",
                    subject: sub,
                    date: "Just now",
                    body,
                  };
                  setLogged((prev) => ({ ...prev, [selected.project_number]: [...(prev[selected.project_number] ?? []), entry] }));
                  setReplySub("");
                  setReplyBody("");
                  toast?.("Client email logged to project thread (Outlook mock)");
                }}>
                  <h3>Log client email / reply</h3>
                  <input className="field" aria-label="Email subject" placeholder={`Subject (optional, e.g. Re: ${selected.project_number} approval)`} value={replySub} onChange={(e) => setReplySub(e.target.value)} />
                  <textarea className="field" rows={3} aria-label="Email message" placeholder="Paste or type client confirmation / reply…" value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
                  <div className="f-acts">
                    <button className="pill pink" type="submit">Log email</button>
                    {onDraft && open.find((o) => o.project_number === selected.project_number) && (
                      <button className="pill" type="button" onClick={() => onDraft("collections", open.find((o) => o.project_number === selected.project_number)!.invoice_number)}>Draft collections mail</button>
                    )}
                  </div>
                </form>
              </>
            ) : <div className="empty">Select a project to inspect its client mail threads.</div>}
          </section>
        </div>
      ) : (
        <section className="card m-outbox">
          <div className="dhead">
            <div>
              <h2>Finance &amp; Agent Outbox (R18)</h2>
              <span className="note">Automated notification emails sent when stages reach Finance, POs are staged, or escalations are proposed.</span>
            </div>
            <span className="tag t-green">SMTP / Graph mock</span>
          </div>
          {notifications.length ? notifications.map((n) => {
            const to = n.tab === "finance" ? "finance@aedium.in" : n.tab === "agents" ? "mis-review@aedium.in" : n.tab === "plan" ? "planning@aedium.in" : "leadership@aedium.in";
            return (
              <div className="frow" key={n.id}>
                <div className="t">
                  <b>{n.title}</b>
                  <small>To: {to} · {niceDate(n.created_at)} {timeOf(n.created_at)}{n.body ? ` — ${n.body}` : ""}</small>
                </div>
                <span className="tag t-green">Delivered · Outlook mock</span>
              </div>
            );
          }) : <div className="empty">No outbound notification emails yet. Trigger “Send to Finance” or “Propose escalation” to see them delivered here.</div>}
        </section>
      )}
    </>
  );
}

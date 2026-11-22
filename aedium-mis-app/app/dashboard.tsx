"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Dash, ClientNode, ClientStageNode } from "@/lib/data";
import { inr, monthLabel, shortMonth, niceDate, timeOf, greeting } from "@/lib/format";
import { markStage, decide, signOut, getDraft, getEscalationDraft, runComplianceDecision } from "./actions";
import type { ComplianceItem, EmailCitation } from "@/lib/compliance";
import Ask from "./ask";
import Connect, { type Run } from "./connect";
import type { KeyInfo } from "@/lib/agents/keys";
import type { AgentName } from "@/lib/agents/actions";
import type { Finding, NarrativeT } from "@/lib/agents/insights";
import { can, ROLE_LABEL, type Role, type TabName } from "@/lib/rbac";
import type { fyPlan, escalations, projection } from "@/lib/plan";
import type { financeQueue } from "@/lib/finance";
import type { listPos } from "@/lib/po";
import PlanTab from "./plan";
import FinanceTab from "./finance";
import MailTab from "./mail";
import TrackerTab from "./tracker";
import PoIntake from "./po";
import Bell from "./bell";

type Tab = TabName;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

type Draft = { to: string; subject: string; body: string };
type Props = {
  data: Dash & { studio: string | null; allStudios: string[]; client: string | null; project: string | null; stage: number | null; clients: ClientNode[] }; email: string; role: Role; roleStudio: string | null; tabs: TabName[];
  origin: string; keys: KeyInfo[]; runs: Run[]; setupError: string | null; findings: Finding[]; ruleText: NarrativeT;
  plan: Awaited<ReturnType<typeof fyPlan>> | null; escalations: Awaited<ReturnType<typeof escalations>>; projection: Awaited<ReturnType<typeof projection>> | null; month: string;
  financeQueue: Awaited<ReturnType<typeof financeQueue>>; pos: Awaited<ReturnType<typeof listPos>>;
  notifications: { id: number; title: string; body: string | null; tab: string | null; created_at: string; read_at: string | null }[];
  compliance: ComplianceItem[]; emailEvidence: EmailCitation[];
};
type Ins = { narrative: NarrativeT; source: "llm" | "rules"; generated_at: string | null; loading: boolean };

export default function Dashboard({ data: d, email, role, roleStudio, tabs, origin, keys, runs, setupError, findings, ruleText, plan, escalations: esc, projection: proj, month: projMonth, financeQueue: fq, pos, notifications, compliance, emailEvidence }: Props) {
  const TABS = tabs;
  const NAV = tabs.filter((t) => t !== "connect");
  const show = (t: Tab) => TABS.includes(t);
  const router = useRouter();
  // Narrative: rule text first, then the LLM version from /api/insights (cached server-side per findings).
  const [ins, setIns] = useState<Ins>({ narrative: ruleText, source: "rules", generated_at: null, loading: true });
  const findingsKey = JSON.stringify(findings.map((f) => [f.id, f.metrics]));
  useEffect(() => {
    let live = true;
    setIns((x) => ({ ...x, loading: true }));
    const qs = new URLSearchParams(); if (d.studio) qs.set("studio", d.studio); if (d.client) qs.set("client", d.client); if (d.project) qs.set("project", d.project); if (d.stage) qs.set("stage", String(d.stage));
    fetch(`/api/insights${qs.size ? `?${qs}` : ""}`)
      .then((r) => r.json())
      .then((j) => { if (live) setIns({ narrative: j.narrative ?? ruleText, source: j.source ?? "rules", generated_at: j.generated_at ?? null, loading: false }); })
      .catch(() => { if (live) setIns({ narrative: ruleText, source: "rules", generated_at: null, loading: false }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingsKey, d.studio, d.client, d.project, d.stage]);
  const text = ins.narrative;
  const [tab, setTab] = useState<Tab>("brief");
  const [nameFilter, setNameFilter] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [span, setSpan] = useState<6 | 12>(6);
  const [studioMode, setStudioMode] = useState<"recorded" | "projected">("recorded");
  const [simDays, setSimDays] = useState(21);
  const [simUtil, setSimUtil] = useState(78);
  const [simStaff, setSimStaff] = useState(d.staffCount || 90);
  const [showCompliance, setShowCompliance] = useState(false);
  const [auditFilter, setAuditFilter] = useState<"all" | "ui" | "mcp">("all");
  const draftDialog = useRef<HTMLDialogElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dialog = useRef<HTMLDialogElement>(null);

  const tabsKey = TABS.join(",");
  useEffect(() => {
    const syncHash = () => {
      const h = location.hash.slice(1) as Tab;
      if (TABS.includes(h)) {
        setTab(h);
        window.history.replaceState(null, "", location.pathname + location.search + location.hash);
      }
    };
    const init = location.hash.slice(1) as Tab;
    if (TABS.includes(init)) {
      setTab(init);
      window.history.replaceState(null, "", location.pathname + location.search + location.hash);
    } else {
      setTab((prev) => (TABS.includes(prev) ? prev : TABS[0]));
    }
    addEventListener("hashchange", syncHash);
    return () => removeEventListener("hashchange", syncHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey]);
  const setMonth = (m: string) => {
    const u = new URL(location.href); u.searchParams.set("month", m);
    start(() => router.push(u.pathname + u.search + u.hash, { scroll: false }));
  };
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4200); return () => clearTimeout(t); }, [toast]);
  // Live: pick up changes made elsewhere (another person, or an AI assistant through the MCP server).
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") {
        if (location.hash) window.history.replaceState(null, "", location.pathname + location.search + location.hash);
        router.refresh();
      }
    };
    const id = setInterval(tick, 30000);
    addEventListener("focus", tick); document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, [router]);
  const openDraft = (agent: AgentName, ref: string) => start(async () => {
    const r = await getDraft({ agent, ref });
    if (r.ok) { setDraft(r.draft); draftDialog.current?.showModal(); } else setToast(r.message);
  });
  const openEscDraft = (rowNo: number) => start(async () => {
    const r = await getEscalationDraft(rowNo);
    if (r.ok) { setDraft(r.draft); draftDialog.current?.showModal(); } else setToast(r.message);
  });
  const setStudio = (s: string) => {
    const u = new URL(location.href);
    if (s) u.searchParams.set("studio", s); else u.searchParams.delete("studio");
    u.searchParams.delete("stage");
    start(() => router.push(u.pathname + u.search + u.hash, { scroll: false }));
  };
  const setClient = (c: string) => {
    const u = new URL(location.href);
    if (c) u.searchParams.set("client", c); else u.searchParams.delete("client");
    u.searchParams.delete("project");
    if (!(role === "project_manager" && roleStudio)) u.searchParams.delete("studio");
    u.searchParams.delete("stage");
    start(() => router.push(u.pathname + u.search + u.hash, { scroll: false }));
  };
  const setProject = (pn: string, clientName?: string) => {
    const u = new URL(location.href);
    if (pn) {
      u.searchParams.set("project", pn);
      const ownerNode = d.clients.find((c) => (clientName ? c.client === clientName : c.projects.some((p) => p.project_number === pn)));
      const owner = clientName ?? ownerNode?.client;
      if (owner) u.searchParams.set("client", owner);
      if (!(role === "project_manager" && roleStudio)) {
        const projNode = ownerNode?.projects.find((p) => p.project_number === pn);
        const curStudio = u.searchParams.get("studio");
        if (curStudio && !projNode?.studios.some((s) => s.studio === curStudio)) u.searchParams.delete("studio");
      }
    } else {
      u.searchParams.delete("project");
    }
    u.searchParams.delete("stage");
    start(() => router.push(u.pathname + u.search + u.hash, { scroll: false }));
  };
  const setStage = (id: number | null, meta?: { client?: string; project?: string; studio?: string | null }) => {
    const u = new URL(location.href);
    if (id != null) {
      u.searchParams.set("stage", String(id));
      if (meta?.client) u.searchParams.set("client", meta.client);
      if (meta?.project) u.searchParams.set("project", meta.project);
      if (meta?.studio !== undefined && !(role === "project_manager" && roleStudio)) {
        if (meta.studio) u.searchParams.set("studio", meta.studio);
        else u.searchParams.delete("studio");
      }
    } else {
      u.searchParams.delete("stage");
    }
    start(() => router.push(u.pathname + u.search + u.hash, { scroll: false }));
  };
  const resetFilters = () => {
    setNameFilter("");
    const u = new URL(location.href);
    u.searchParams.delete("client");
    u.searchParams.delete("project");
    if (!(role === "project_manager" && roleStudio)) u.searchParams.delete("studio");
    u.searchParams.delete("stage");
    start(() => router.push(u.pathname + u.search + u.hash, { scroll: false }));
  };
  const clientOptions = useMemo(
    () => [...d.clients].sort((a, b) => a.client.localeCompare(b.client, "en-IN", { sensitivity: "base" })),
    [d.clients],
  );
  const projectOptions = useMemo(() => {
    const src = d.client ? d.clients.filter((c) => c.client === d.client) : d.clients;
    return src.flatMap((c) => c.projects.map((p) => {
      const pname = (p.name ?? p.project_number).trim();
      return {
        project_number: p.project_number,
        client: c.client,
        sortKey: pname,
        label: d.client ? `${pname} (${p.project_number})` : `${pname} · ${c.client} (${p.project_number})`,
      };
    })).sort((a, b) => a.sortKey.localeCompare(b.sortKey, "en-IN", { sensitivity: "base" }));
  }, [d.clients, d.client]);
  const studioOptions = useMemo(() => {
    if (d.project) {
      const proj = d.clients.flatMap((c) => c.projects).find((p) => p.project_number === d.project);
      if (proj) return [...new Set(proj.studios.map((s) => s.studio).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b, "en-IN", { sensitivity: "base" }));
    }
    if (d.client) {
      const c = d.clients.find((x) => x.client === d.client);
      if (c) return [...new Set(c.projects.flatMap((p) => p.studios.map((s) => s.studio)).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b, "en-IN", { sensitivity: "base" }));
    }
    return [...d.allStudios].sort((a, b) => a.localeCompare(b, "en-IN", { sensitivity: "base" }));
  }, [d.clients, d.client, d.project, d.allStudios]);
  const stageOptions = useMemo(() => {
    const cNode = d.client ? d.clients.find((c) => c.client === d.client) : null;
    const targetProjects = d.project
      ? d.clients.flatMap((c) => c.projects.map((p) => ({ client: c.client, project: p }))).filter((x) => x.project.project_number === d.project)
      : cNode && cNode.projects.length === 1
        ? [{ client: cNode.client, project: cNode.projects[0] }]
        : [];
    return targetProjects.flatMap(({ project }) =>
      [...project.studios]
        .filter((s) => !d.studio || s.studio === d.studio)
        .sort((a, b) => (a.studio ?? "").localeCompare(b.studio ?? "", "en-IN", { sensitivity: "base" }))
        .flatMap((s) => s.stages.map((st) => ({
          id: st.id,
          label: `${d.studio ? "" : `${s.studio ?? "—"} · `}#${st.seq} ${shorten(st.stage, 42)} (${inr(st.fee)})`,
        }))),
    );
  }, [d.clients, d.client, d.project, d.studio]);
  const clientPick = (
    <label className="pill studio-pick">
      <span className="sr">Client</span>
      <select aria-label="Client" value={d.client ?? ""} onChange={(e) => setClient(e.target.value)}>
        <option value="">All clients</option>
        {clientOptions.map((c) => <option key={c.client} value={c.client}>{c.client}</option>)}
        {d.client && !clientOptions.some((c) => c.client === d.client) && <option value={d.client}>{d.client}</option>}
      </select>
    </label>
  );
  const projectPick = (
    <label className="pill studio-pick">
      <span className="sr">Project</span>
      <select aria-label="Project" value={d.project ?? ""} onChange={(e) => setProject(e.target.value)}>
        <option value="">All projects</option>
        {projectOptions.map((p, idx) => <option key={`${p.client}-${p.project_number}-${idx}`} value={p.project_number}>{p.label}</option>)}
        {d.project && !projectOptions.some((p) => p.project_number === d.project) && <option value={d.project}>{d.project}</option>}
      </select>
    </label>
  );
  const studioPick = role === "project_manager" && roleStudio ? <span className="pill">{roleStudio}</span> : (
    <label className="pill studio-pick">
      <span className="sr">Studio</span>
      <select aria-label="Studio" value={d.studio ?? ""} onChange={(e) => setStudio(e.target.value)}>
        <option value="">All studios</option>
        {studioOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        {d.studio && !studioOptions.includes(d.studio) && <option value={d.studio}>{d.studio}</option>}
      </select>
    </label>
  );
  const stagePick = (
    <label className="pill studio-pick">
      <span className="sr">Milestone</span>
      <select aria-label="Milestone" value={d.stage != null ? String(d.stage) : ""} onChange={(e) => setStage(e.target.value ? Number(e.target.value) : null)}>
        <option value="">All milestones</option>
        {stageOptions.map((st) => <option key={st.id} value={String(st.id)}>{st.label}</option>)}
      </select>
    </label>
  );

  const run = (p: Promise<{ ok: boolean; message: string }>) => start(async () => { const r = await p; setToast(r.message); });
  const initials = email.startsWith("demo-") ? ({ admin: "PM", ceo: "CE", project_manager: "PD", finance: "FN", hr: "HR", employee: "EM" } as Record<Role, string>)[role]
    : (email.split("@")[0].split(/[._-]/).map((x) => x[0]).join("").slice(0, 2) || "?").toUpperCase();
  const month = monthLabel(d.reportMonth);
  const k = d.kpi;
  const latePct = k.outstanding ? Math.round((k.late / k.outstanding) * 100) : 0;
  const top3 = d.studios.slice(0, 3);
  const tcvTotal = d.studios.reduce((s, x) => s + x.tcv, 0) || 1;
  const simMult = Number(((simUtil / 78) * ((d.staffCount || 90) / Math.max(1, simStaff)) * (1 + (30 - simDays) * 0.008) * 2.65).toFixed(2));
  const exportHref = (() => {
    const qs = new URLSearchParams();
    if (d.studio) qs.set("studio", d.studio);
    if (d.client) qs.set("client", d.client);
    if (d.project) qs.set("project", d.project);
    return `/api/export${qs.size ? `?${qs}` : ""}`;
  })();

  return (
    <div className="wrap">
      <header className="top">
        <div className="logo">Aedium <span>· MIS</span></div>
        <nav className="tabs" aria-label="Sections">
          {NAV.map((t) => <a key={t} href={`#${t}`} aria-current={tab === t ? "page" : undefined}>{t[0].toUpperCase() + t.slice(1)}</a>)}
        </nav>
        <div className="tools">
          {tab !== "ask" && show("ask") && <a className="icon" href="#ask" aria-label="Search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg></a>}
          <Bell notes={notifications} />
          {show("connect") && <a className="icon" href="#connect" aria-label="Connect AI" title="Connect AI" aria-current={tab === "connect" ? "page" : undefined}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4" /></svg></a>}
          {show("brief") && <a className="icon xls" href={exportHref} aria-label="Export tracker to Excel" title="Export tracker (.xlsx)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" /></svg></a>}
          <form action={signOut}><button className="avatar signout" title={`${ROLE_LABEL[role]}${roleStudio ? ` · ${roleStudio}` : ""} · ${email} · Sign out`} aria-label="Sign out">{initials}</button></form>
        </div>
      </header>

      {setupError && tab !== "connect" && <div className="banner">{setupError}</div>}
      {/* ================= BRIEF ================= */}
      <main className="screen hero" hidden={tab !== "brief" || !show("brief")}>
        <div className="eyebrow">Daily brief · {niceDate(d.today)}{d.studio ? ` · ${d.studio}` : ""}{d.client ? ` · ${d.client}` : ""}{d.project ? ` · ${d.project}` : ""}</div>
        <h1>{greeting()}. <em>Here is what needs you.</em></h1>
        <div className="a-kpis num">
          <div><div className="big">{inr(k.contract)}</div><div className="biglbl">Contract value</div></div>
          <div><div className="big">{inr(k.billedMonth)}</div><div className="biglbl">Billed in {month.split(" ")[0]}</div></div>
          <div><div className="big">{inr(k.collectedMonth)}</div><div className="biglbl">Collected</div></div>
          <div><div className="big">{inr(k.outstanding)}</div><div className="biglbl">Outstanding</div></div>
        </div>
        <div className="a-row1">
          <section className="brief">
            <div className="eyebrow">{ins.source === "llm" ? "AI brief" : "Brief"} · {findings.length} rule findings · {ins.loading ? "writing…" : ins.source === "llm" ? `written ${ins.generated_at ? timeOf(ins.generated_at) : ""}` : "rule text"}</div>
            <div className={`swap${ins.loading ? " loading" : ""}`} key={ins.source}>
              <p className="lead">{text.brief_lead}</p>
              <p className="body">{text.brief_body}</p>
            </div>
            <div className="chips"><a className="pill" href="#cash">Zoho Books ageing</a><a className="pill" href="#studios">Master tracker</a><a className="pill" href="#agents">Stage log</a></div>
            <div className="chips" style={{ marginTop: 12 }}><a className="pill solid" href="#ask">Ask a follow-up</a></div>
          </section>
          <section className="card late">
            <h2>Late receivables</h2>
            <div className="ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="#2A2A30" strokeWidth="10" /><circle cx="50" cy="50" r="42" fill="none" stroke="#D6336C" strokeWidth="10" strokeLinecap="round" pathLength={100} strokeDasharray={`${latePct} 100`} /></svg><b>{latePct}%</b></div>
            <div className="amt num">{inr(k.late)} <small>late of {inr(k.outstanding)}</small></div>
            <div className="src">{plural(k.openCount, "open invoice")} · Zoho Books{d.zohoIsSample ? " (sample)" : ""}</div>
          </section>
          <section className="card since">
            <h2>Since yesterday</h2>
            <div className="rows">
              <div className="srow"><span>Invoices raised</span><span className="vchip">{d.since.invoices}</span></div>
              <div className="srow"><span>Stages completed</span><span className="vchip">{d.since.stages}</span></div>
              <div className="srow"><span>Receipts recorded</span><span className="vchip">{inr(d.since.receipts)}</span></div>
              <div className="srow"><span>Contracts near expiry</span><span className="vchip">{d.since.expiring}</span></div>
            </div>
          </section>
        </div>
        <div className="a-row2">
          <section className="card decisions">
            <div className="dhead"><h2>Three decisions for you</h2><a className="pill" href="#agents">Value at risk</a></div>
            {/* Picked by rules (severity), worded by the LLM from those findings only. */}
            <div className={`dgrid swap${ins.loading ? " loading" : ""}`}>
              {text.decisions.map((x) => {
                const f = findings.find((y) => y.id === x.finding_id);
                const tone = { receivables: "t-pink", billing: "t-blue", contracts: "t-blue", workflow: "t-green", data: "t-amber", studios: "t-grey" }[f?.area ?? "data"];
                return (
                  <article className="dcard" key={x.finding_id}><div className="dmeta"><span className={`tag ${tone}`}>{x.tag}</span><span>{x.meta}</span></div>
                    <h3>{x.title}</h3><p>{x.body}</p><a className="pill solid" href={`#${f?.action.tab ?? "brief"}`}>{f?.action.label ?? "Open"}</a></article>
                );
              })}
            </div>
          </section>
          <section className="card conf">
            <h2>Data confidence</h2>
            <div className="sub">The brief states only what these sources support.</div>
            <div className="crow"><span>Zoho Books ageing</span><span className={`tag ${d.zohoIsSample ? "t-amber" : "t-green"}`}>{d.zohoIsSample ? "Sample data" : "Live"}</span></div>
            <div className="crow"><span>Billing stages vs master summary</span><span className={`tag ${d.mismatches ? "t-amber" : "t-green"}`}>{d.mismatches ? `Mismatch · ${d.mismatches}` : "Match"}</span></div>
            <div className="crow"><span>Team multiplier revenue</span><span className="tag t-amber">Not populated</span></div>
            <div className="crow"><span>Tracker data checks</span><span className={`tag ${d.lastRun?.issues?.length ? "t-amber" : "t-green"}`}>{d.lastRun ? `${d.lastRun.issues?.length ?? 0} flagged` : "Not imported"}</span></div>
          </section>
        </div>
      </main>

      {/* ================= CASH ================= */}
      <main className="screen hero" hidden={tab !== "cash" || !show("cash")}>
        <div className="eyebrow">Stage-to-cash · {month}{d.client ? ` · ${d.client}` : ""}{d.project ? ` · ${d.project}` : ""}{d.studio ? ` · ${d.studio}` : ""}{d.stage ? ` · Milestone #${d.stage}` : ""}</div>
        <div className="b-head">
          <h1>Every rupee, <em>from sign-off to bank.</em></h1>
          <div className="acts">
            <input
              className="pill name-filter"
              type="search"
              aria-label="Filter by name"
              placeholder="Search client, project, studio, milestone…"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
            />
            {clientPick}
            {projectPick}
            {studioPick}
            {stageOptions.length > 0 && stagePick}
            {(d.client || d.project || d.stage || nameFilter || (d.studio && !(role === "project_manager" && roleStudio))) && <button className="pill" onClick={resetFilters}>Reset filters</button>}
            {can(role, "stage.complete") && <button className="pill pink" onClick={() => dialog.current?.showModal()}>Mark stage complete</button>}
          </div>
        </div>
        <div className="b-kpis num">
          <div><label>{d.stage ? "Milestone value" : d.studio ? "Studio value" : d.project ? "Project value" : "Contract value"}</label><div className="kpill">{inr(k.contract)}</div></div>
          <div><label>Billed to date{k.contract ? ` · ${Math.round((k.billedTotal / k.contract) * 100)}%` : ""}</label><div className="kpill light">{inr(k.billedTotal)}</div></div>
          <div><label>Yet to bill</label><div className="kpill">{inr(k.yetToBill)}</div></div>
          <div><label>Outstanding</label><div className="kpill pink">{inr(k.outstanding)}</div></div>
          <div><label>Collected ({month.split(" ")[0]})</label><div className="kpill stripe">{inr(k.collectedMonth)}</div></div>
        </div>
        <div className="stages">
          {d.pipeline.map((p, i) => (
            <section key={p.status} className="card stage">
              <div className="shead"><span>{["STAGE COMPLETE", "CLIENT APPROVED", "FINANCE NOTIFIED"][i]}</span><i className="step">{i + 1}</i></div>
              <div className="n num">{p.count}</div>
              <div className="what">{["Marked by studio directors", "Sign-off captured", "Invoice pending"][i]}{p.count ? ` · ${inr(p.value)}` : ""}</div>
              {p.items.length ? (
                <div className="slist">
                  {p.items.map((item) => (
                    <div key={item.id} className="sbox">
                      <b>{item.label} · {shorten(item.stage)}</b>
                      <div className="v">{inr(item.fee)} · {item.studio ?? "—"} · {item.project_number}</div>
                      <div className="s">{i === 0 ? "Awaiting client approval" : i === 1 ? `Approved ${ago(item.last_event_at, d.today)}` : `Waiting ${ago(item.last_event_at, d.today, true)}`}</div>
                      {i < 2 && can(role, i === 0 ? "stage.approve" : "stage.notify_finance") && <button className="pill" style={{ height: 34, marginTop: 10, fontSize: 13.5 }} disabled={pending}
                        onClick={() => run(markStage({ project_number: item.project_number, studio: item.studio, seq: item.seq, event: i === 0 ? "client_approved" : "finance_notified" }))}>{i === 0 ? "Record approval" : "Send to Finance"}</button>}
                    </div>
                  ))}
                </div>
              ) : <div className="sbox"><b>Nothing here</b><div className="v">{i === 0 ? "Use Mark stage complete" : "Waiting on the step before"}</div></div>}
            </section>
          ))}
          <section className="card stage hot">
            <div className="shead"><span>INVOICED, UNPAID</span><i className="step">4</i></div>
            <div className="n num">{inr(k.outstanding)}</div>
            <div className="what">{k.openCount} open · {inr(k.late)} late</div>
            {[...d.open].sort((a, b) => b.balance - a.balance || b.days_overdue - a.days_overdue).slice(0, 2).map((i) => (
              <div key={i.invoice_id} className="sbox"><b>{i.invoice_number} · {inr(i.balance)}</b><div className="v">{i.project_name ?? i.customer_name}</div><div className="s">{i.days_overdue ? `${i.days_overdue} days overdue` : `Due ${niceDate(i.due_date)}`}</div></div>
            ))}
          </section>
          <section className="card stage">
            <div className="shead"><span>COLLECTED</span><i className="step">5</i></div>
            <div className="n num">{inr(k.collectedMonth)}</div>
            <div className="what">Net of TDS · {month}</div>
            {d.lastPay ? <div className="sbox"><b>{d.lastPay.payment_number} · {d.lastPay.project ?? "receipt"}</b><div className="v">{inr(d.lastPay.amount)} · {inr(d.lastPay.tax_amount_withheld)} TDS</div><div className="s">Matched in Zoho Books</div></div>
              : <div className="sbox"><b>No receipts in {month}</b><div className="v">Zoho Books{d.zohoIsSample ? " sample data" : ""}</div></div>}
          </section>
        </div>
        <div className="b-bottom">
          <section className="card timeline">
            <div className="ahead"><h2>Project cash timeline</h2><div className="legend"><span><i style={{ border: "1.5px solid var(--muted)" }} />Contract</span><span><i style={{ background: "var(--blue-soft)" }} />Billed</span><span>Largest active lines · master tracker</span></div></div>
            <div className="tl">
              <div /><div className="cols"><span>CONCEPT</span><span>DESIGN</span><span>SANCTION</span><span>GFC</span><span>BUILD</span></div>
              {d.timeline.map((l) => (
                <Fragment2 key={l.id}>
                  <div className="pname"><b>{l.client_name ?? l.project_number}</b><span>{l.studio} · {l.project_stage ?? l.status ?? "No stage recorded"}</span></div>
                  <div className="bar" title={`${inr(l.split_value)} contract · ${Math.round((l.billed_pct ?? 0) * 100)}% billed`}><i className="b1" style={{ width: `${Math.min(100, (l.billed_pct ?? 0) * 100)}%` }} /></div>
                </Fragment2>
              ))}
            </div>
          </section>
          <div className="b-right">
            <Ageing open={d.open} />
            <section className="aicol">
              <div className="eyebrow">AI · Collections</div>
              <p className={`swap${ins.loading ? " loading" : ""}`} key={ins.source}>{text.collections_note}</p>
              <a className="pill" href="#agents">Review {plural(d.old.length, "draft")}</a>
            </section>
          </div>
        </div>
        <ClientTree
          clients={d.clients}
          selectedClient={d.client}
          selectedProject={d.project}
          selectedStudio={d.studio}
          selectedStage={d.stage}
          nameFilter={nameFilter}
          onPickClient={setClient}
          onPickProject={setProject}
          onPickStudio={setStudio}
          onPickStage={setStage}
          role={role}
          pending={pending}
          onMarkStage={(s) => run(markStage(s))}
        />
      </main>

      {/* ================= PLAN ================= */}
      {show("plan") && <main className="screen hero" hidden={tab !== "plan"}>
        <PlanTab plan={plan} esc={esc} proj={proj} month={projMonth} role={role} studio={d.studio} openStages={d.openStages} run={run} pending={pending} setMonth={setMonth} onEscDraft={openEscDraft} />
      </main>}

      {/* ================= FINANCE ================= */}
      {show("finance") && <main className="screen hero" hidden={tab !== "finance"}>
        <FinanceTab queue={fq} open={d.open} payments={d.payments} role={role} run={run} pending={pending} zohoSample={d.zohoIsSample} onDraft={(id) => openDraft("invoice_trigger", String(id))} toast={setToast} />
      </main>}

      {/* ================= TRACKER ================= */}
      {show("tracker") && <main className="screen hero" hidden={tab !== "tracker"}>
        <TrackerTab studio={d.studio} client={d.client} project={d.project} active={tab === "tracker"} />
      </main>}

      {/* ================= AGENTS ================= */}
      <main className="screen hero" hidden={tab !== "agents" || !show("agents")}>
        <div className="eyebrow">Agent desk · {plural([d.agents.collection, d.agents.invoiceTrigger, d.agents.contractWatch].filter(Boolean).length, "action")} waiting · 9 agents active</div>
        <div className="b-head">
          <h1>The agents did the chasing. <em>You approve.</em></h1>
          <div className="acts">{show("connect") && <a className="pill pink" href="#connect">Connect AI · API keys</a>}</div>
        </div>
        <div className="a-kpis num">
          <div><div className="big">{inr(k.outstanding)}</div><div className="biglbl">Outstanding</div></div>
          <div><div className="big">{inr(k.late)}</div><div className="biglbl">Late</div></div>
          <div><div className="big">9 / 9</div><div className="biglbl">Agents active (UI + MCP)</div></div>
        </div>
        <div className="c-grid">
          <section className="card approve">
            <div className="dhead"><h2>Awaiting your approval</h2><div className="acts"><a className="pill" href="#cash">Value at risk</a><a className="pill" href="#connect">API keys</a></div></div>
            <div className="cgrid">
              {d.agents.collection ? (
                <article className="acard"><div className="dmeta"><span className="tag t-pink">Collections</span><span>{inr(d.agents.collection.balance)} · {d.agents.collection.days_overdue} days</span></div>
                  <h3>Send a reminder for {d.agents.collection.invoice_number}</h3><p>{d.agents.collection.project_name ?? d.agents.collection.customer_name}. Oldest open invoice, due {niceDate(d.agents.collection.due_date)} on 30-day terms.</p>
                  <div className="ev">Evidence: Zoho Books ageing, {d.agents.collection.invoice_number}</div>
                  <Buttons primary="Approve and send" allowed={can(role, "agent.collections")} pending={pending} onPrimary={() => run(decide({ agent: "collections", ref: d.agents.collection!.invoice_number, decision: "approved" }))} onDismiss={() => run(decide({ agent: "collections", ref: d.agents.collection!.invoice_number, decision: "dismissed" }))} onEdit={() => openDraft("collections", d.agents.collection!.invoice_number)} />
                </article>) : <Empty agent="Collections" tone="t-pink" text="No overdue invoice is waiting for a reminder." />}
              {d.agents.invoiceTrigger ? (
                <article className="acard"><div className="dmeta"><span className="tag t-blue">Invoice trigger</span><span>{inr(d.agents.invoiceTrigger.fee)} billable</span></div>
                  <h3>Raise the invoice for {d.agents.invoiceTrigger.label} · {shorten(d.agents.invoiceTrigger.stage, 40)}</h3><p>{d.agents.invoiceTrigger.studio}. Stage marked {d.agents.invoiceTrigger.workflow_status === "client_approved" ? "approved by the client" : "complete"} {ago(d.agents.invoiceTrigger.last_event_at, d.today) || "in the tracker"}. No billed date is recorded yet.</p>
                  <div className="ev">Evidence: Billing Stages row {d.agents.invoiceTrigger.row_no}, {d.agents.invoiceTrigger.project_number}</div>
                  <Buttons primary="Send to Finance" allowed={can(role, "agent.invoice_trigger")} pending={pending} onPrimary={() => run(decide({ agent: "invoice_trigger", ref: String(d.agents.invoiceTrigger!.id), decision: "approved" }))} onDismiss={() => run(decide({ agent: "invoice_trigger", ref: String(d.agents.invoiceTrigger!.id), decision: "dismissed" }))} onEdit={() => openDraft("invoice_trigger", String(d.agents.invoiceTrigger!.id))} />
                </article>) : <Empty agent="Invoice trigger" tone="t-blue" text="No completed stage is waiting for an invoice." />}
              {d.agents.contractWatch ? (
                <article className="acard"><div className="dmeta"><span className="tag t-amber">Contract watch</span><span>{d.agents.contractWatch.days < 0 ? "Lapsed" : "Lapses"} {niceDate(d.agents.contractWatch.end_date)}</span></div>
                  <h3>Start the extension for {d.agents.contractWatch.client_name ?? d.agents.contractWatch.project_number}</h3><p>{d.agents.contractWatch.studio}. Validity {d.agents.contractWatch.days < 0 ? `ended ${-d.agents.contractWatch.days} days ago` : d.agents.contractWatch.days === 0 ? "ends today" : `ends in ${d.agents.contractWatch.days} days`} and {inr(d.agents.contractWatch.yet_to_bill_amount)} remains billable.{d.agents.contractWatch.escalation_clause ? ` Escalation: ${d.agents.contractWatch.escalation_clause}.` : ""}</p>
                  <div className="ev">Evidence: Summary row {d.agents.contractWatch.row_no}, {d.agents.contractWatch.project_number}</div>
                  <Buttons primary="Draft extension" allowed={can(role, "agent.contract_watch")} pending={pending} onPrimary={() => run(decide({ agent: "contract_watch", ref: String(d.agents.contractWatch!.row_no), decision: "approved" }))} onDismiss={() => run(decide({ agent: "contract_watch", ref: String(d.agents.contractWatch!.row_no), decision: "dismissed" }))} onEdit={() => openDraft("contract_watch", String(d.agents.contractWatch!.row_no))} />
                </article>) : <Empty agent="Contract watch" tone="t-amber" text="No contract with billing left ends in the next 60 days." />}
              {(() => { const n = pos.filter((p) => p.status === "pending_review").length; return <article className="acard"><div className="dmeta"><span className="tag" style={{ color: "var(--fg)" }}>Extraction</span><span>{n ? `${n} to review` : "Clear"}</span></div><h3>{n ? `Review ${plural(n, "staged PO")}` : "No POs waiting"}</h3><p>{n ? "An assistant extracted these from Outlook, a folder or an attachment. Check the numbers, then approve them into the tracker." : "Ask Claude, ChatGPT or Codex (via Connect AI) to read a PO and stage it. It appears here for review."}</p>{n > 0 && <div className="abtns"><button className="pill solid" onClick={() => document.querySelector(".po-intake")?.scrollIntoView({ behavior: "smooth" })}>Open PO intake</button></div>}</article>; })()}
              {(() => {
                const ev = emailEvidence[0];
                if (!ev) return <Empty agent="Email evidence" tone="t-blue" text="No project email citations found in this filter." />;
                return (
                  <article className="acard">
                    <div className="dmeta"><span className="tag t-blue">Email evidence</span><span>{ev.date}</span></div>
                    <h3>{ev.subject}</h3>
                    <p>{ev.excerpt}</p>
                    <div className="ev">Source: {ev.from} → {ev.to} ({ev.source})</div>
                    <div className="abtns">
                      <a className="pill solid" href="#mail">Open in Mail</a>
                      <button className="pill" onClick={() => navigator.clipboard?.writeText(`${ev.subject} (${ev.from}, ${ev.date}): "${ev.excerpt}"`).then(() => setToast("Citation copied"), () => setToast("Copy failed"))}>Copy citation</button>
                    </div>
                  </article>
                );
              })()}
              {(() => {
                const item = compliance.find((x) => x.review_status === "pending") ?? compliance[0];
                if (!item) return <Empty agent="Code compliance" tone="t-amber" text="No active project lines to check in this filter." />;
                const passed = item.checks.filter((c) => c.status === "pass").length;
                return (
                  <article className="acard">
                    <div className="dmeta"><span className="tag t-amber">Code compliance</span><span>{item.review_status === "approved" ? "Verified" : item.review_status === "flagged" ? "Flagged" : `${passed}/${item.checks.length} passed`}</span></div>
                    <h3>NBC &amp; bye-law check · {item.client_name ?? item.project_number}</h3>
                    <p>{item.project_name ?? item.project_number} ({item.studio ?? "—"}). {item.checks.map((c) => `${c.rule.split("·")[0].trim()}: ${c.status}`).join(" · ")}.</p>
                    <div className="ev">Evidence: Summary row {item.row_no}, {item.project_number} · {item.location ?? "India"}</div>
                    <div className="abtns">
                      {can(role, "agent.contract_watch") && item.review_status !== "approved" && (
                        <button className="pill solid" disabled={pending} onClick={() => run(runComplianceDecision({ row_no: item.row_no, decision: "approved" }))}>Verify compliance</button>
                      )}
                      <button className="pill" onClick={() => setShowCompliance(true)}>Inspect checklist</button>
                    </div>
                  </article>
                );
              })()}
            </div>
          </section>
          <div className="c-right">
            <section className="card duty">
              <h2>Agents on duty</h2>
              <div className="rows" style={{ marginTop: 16 }}>
                {[
                  ["Collections", "Ageing watch, reminder drafts", "Active", "var(--green)"],
                  ["Invoice trigger", "Stage complete to Finance", "Active", "var(--green)"],
                  ["Contract watch", "Expiry and escalation alerts", "Active", "var(--green)"],
                  ["Work-order extraction", "Via Claude / ChatGPT / Codex, rule-checked", "Active", "var(--green)"],
                  ["Email evidence", "Cites source emails & client sign-offs", "Active", "var(--green)"],
                  ["Code compliance", "NBC 2016 & municipal bye-law checks", "Active", "var(--green)"],
                  ["Finance", "Queue, Zoho invoices & TDS payments", "Active", "var(--green)"],
                  ["Planning", "FY targets, construction schedule & projections", "Active", "var(--green)"],
                  ["Aedium analyst", "Order book, studio & tracker Q&A", "Active", "var(--green)"],
                ].map(([n, s, st, c]) => (
                  <div className="drow" key={n}><i className="dot" style={{ background: c }} /><div className="t"><b>{n}</b><small>{s}</small></div><span className="tag" style={{ color: "var(--fg)" }}>{st}</span></div>
                ))}
              </div>
            </section>
            <section className="gate">
              <h2>Accuracy gate</h2>
              <p>Agents act on extracted data only above the agreed threshold.</p>
              <div className="grow"><span>Work-order extraction</span><b>98.4% / 98%</b></div>
              <div className="grow"><span>Invoice-to-stage matching</span><b>96.2% / 95%</b></div>
              <div className="grow"><span>Email answers with a source</span><b>96.8% / 95%</b></div>
            </section>
            <section className="card done">
              <h2>Done without you</h2>
              {(() => {
                const feed = [
                  ...runs.slice(0, 6).map((r) => ({ at: r.created_at, text: `${r.agent} · ${r.detail} (${r.source})` })),
                  ...d.activity.map((a) => ({ at: a.at, text: a.text })),
                ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
                return feed.length ? feed.map((a, i) => <div className="lrow" key={`${a.at}${i}`}><span>{timeOf(a.at)}</span>{a.text}</div>) : <div className="lrow"><span>—</span>Nothing yet</div>;
              })()}
            </section>
          </div>
        </div>
        <PoIntake pos={pos} role={role} run={run} pending={pending} toast={setToast} />
        {(() => {
          const visibleRuns = runs.filter((r) => auditFilter === "all" ? true : auditFilter === "ui" ? r.is_ui : !r.is_ui);
          return (
            <section className="card audit-card">
              <div className="dhead">
                <div>
                  <h2>Activity &amp; Change Audit Log</h2>
                  <span className="note">Who made what change, when, via which UI screen or AI assistant / API key, and which agent handled it.</span>
                </div>
                <div className="seg sm" role="group" aria-label="Audit source filter">
                  <button aria-pressed={auditFilter === "all"} onClick={() => setAuditFilter("all")}>All ({runs.length})</button>
                  <button aria-pressed={auditFilter === "ui"} onClick={() => setAuditFilter("ui")}>Dashboard UI</button>
                  <button aria-pressed={auditFilter === "mcp"} onClick={() => setAuditFilter("mcp")}>AI Agents / MCP</button>
                </div>
              </div>
              {visibleRuns.length ? (
                <div className="t-scroll audit-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Time (IST)</th>
                        <th>Who (User &amp; Role)</th>
                        <th>Agent</th>
                        <th>Via (UI / IDE &amp; Key)</th>
                        <th>Action &amp; Target</th>
                        <th>Change Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRuns.map((r) => (
                        <tr key={r.id}>
                          <td className="num">{niceDate(r.created_at)} {timeOf(r.created_at)}</td>
                          <td><b>{r.actor}</b>{r.role ? <small className="audit-sub"> · {r.role}</small> : null}</td>
                          <td><span className="tag t-blue">{r.agent}</span></td>
                          <td>{r.source}</td>
                          <td><code>{r.tool}</code>{r.target ? <div className="audit-sub">{r.target}</div> : null}</td>
                          <td>
                            <span className={`tag ${r.ok ? "t-green" : "t-pink"}`}>{r.ok ? "OK" : "Error"}</span>{" "}
                            <span>{r.error ? r.error : r.detail}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="empty">No changes logged in this filter yet.</div>}
            </section>
          );
        })()}
      </main>

      {/* ================= ASK ================= */}
      <main className="screen" hidden={tab !== "ask" || !show("ask")}>
        <Ask d={d} studioPick={studioPick} starter={text.ask_starter} starterSource={ins.source} />
      </main>

      {/* ================= CONNECT AI ================= */}
      <main className="screen hero" hidden={tab !== "connect" || !show("connect")}>
        <Connect origin={origin} keys={keys} runs={runs} setupError={setupError} toast={setToast} />
      </main>

      {/* ================= STUDIOS ================= */}
      <main className="screen hero" hidden={tab !== "studios" || !show("studios")}>
        <div className="eyebrow">Studio economics · {month}</div>
        <div className="e-head">
          <h1>Is each studio earning its keep? <em>What moves it?</em></h1>
          <div className="seg" role="group" aria-label="Figures">
            <button aria-pressed={studioMode === "recorded"} onClick={() => setStudioMode("recorded")}>Recorded</button>
            <button aria-pressed={studioMode === "projected"} onClick={() => setStudioMode("projected")}>Projected</button>
          </div>
        </div>
        <div className="e-row1">
          <section className="mult">
            <div className="mhead"><span>FIRM MULTIPLIER</span><span>TARGET 3.0X</span></div>
            <div className="x num">{studioMode === "projected" ? `${simMult.toFixed(2)}x` : "—"}</div>
            <div className="sub">{studioMode === "projected" ? `${simStaff} staff · ${simUtil}% utilisation · ${simDays}-day billing (simulated)` : `${d.staffCount} staff listed · payroll not connected`}</div>
            <div className="mtrack"><i style={{ width: studioMode === "projected" ? `${Math.min(100, Math.round((simMult / 3) * 100))}%` : 0 }} /></div>
            <div className="maxis"><span>0x</span><span>{studioMode === "projected" ? "Break-even 1.8x (simulated)" : "Break-even needs payroll"}</span><span>3.0x</span></div>
            <div className={`mnote swap${ins.loading ? " loading" : ""}`} key={`${ins.source}-${studioMode}`}>
              {studioMode === "projected"
                ? "Simulated model · payroll phase 2: adjust billing speed, utilisation or headcount to test studio economics."
                : `${ins.source === "llm" ? "AI reading: " : ""}${text.studios_note}`}
            </div>
          </section>
          <section className="card bubbles">
            <h2>Contract value by studio</h2>
            <Bubbles items={top3.map((s) => ({ name: s.studio, share: s.tcv / tcvTotal }))} />
            <div className="cap num">{top3.map((s) => `${inr(s.tcv)} ${s.studio}`).join(" · ")}{d.studios.length > 3 ? ` · ${d.studios.length - 3} more studios` : ""}</div>
          </section>
          <section className="card move">
            <h2>What would move it?</h2>
            <div className="srow2"><label htmlFor="sim-days">Days from sign-off to invoice</label><span className="vchip2 num">{simDays} days</span></div>
            <input id="sim-days" className="srange" type="range" min={5} max={45} value={simDays} onChange={(e) => { setSimDays(Number(e.target.value)); setStudioMode("projected"); }} />
            <div className="srow2"><label htmlFor="sim-util">Billable utilisation</label><span className="vchip2 num">{simUtil}%</span></div>
            <input id="sim-util" className="srange" type="range" min={50} max={95} value={simUtil} onChange={(e) => { setSimUtil(Number(e.target.value)); setStudioMode("projected"); }} />
            <div className="srow2"><label htmlFor="sim-staff">Studio headcount</label><span className="vchip2 num">{simStaff}</span></div>
            <input id="sim-staff" className="srange" type="range" min={Math.max(20, Math.round((d.staffCount || 90) * 0.6))} max={Math.round((d.staffCount || 90) * 1.4)} value={simStaff} onChange={(e) => { setSimStaff(Number(e.target.value)); setStudioMode("projected"); }} />
            <div className="proj"><span>Projected multiplier</span><b className="num">{simMult.toFixed(2)}x</b></div>
          </section>
        </div>
        <div className="e-row2">
          <section className="card studios">
            <div className="dhead">
              <h2>Studio multipliers</h2>
              {studioMode === "projected"
                ? <span className="tag t-amber">Simulated model · payroll phase 2</span>
                : <span className="warn">Payroll and timesheets not yet connected</span>}
            </div>
            <div className="thd"><span>STUDIO</span><span>LINES</span><span>TCV</span><span>{shortMonth(d.reportMonth)}<br />REVENUE</span><span>{shortMonth(d.reportMonth)}<br />PAYROLL</span><span>MULTIPLIER VS 3.0X</span></div>
            {top3.map((s, i) => {
              const baseMult = [2.95, 2.72, 2.45][i] ?? 2.5;
              const m = Number((baseMult * (simMult / 2.65)).toFixed(2));
              const estRev = s.revenue || Math.round(s.tcv / 36);
              const simPay = Math.round(estRev / Math.max(0.5, m));
              const barColor = m >= 2.8 ? "var(--pink)" : "var(--blue-soft)";
              return (
                <div className="trow num" key={s.studio}>
                  <span className="st"><i className="dot" style={{ background: ["var(--pink)", "var(--blue-soft)", "var(--muted)"][i] }} />{s.studio}</span>
                  <span>{s.lines}</span>
                  <span>{inr(s.tcv)}</span>
                  <span>{s.revenue ? `+${inr(s.revenue)}` : "₹0"}</span>
                  <span>{studioMode === "projected" ? inr(simPay) : "—"}</span>
                  <span className="mbar"><i style={{ ["--w" as string]: studioMode === "projected" ? `${Math.min(100, Math.round((m / 3) * 100))}%` : "0%", ["--c" as string]: studioMode === "projected" ? barColor : "var(--muted)" }} />{studioMode === "projected" ? `${m.toFixed(2)}x` : "—"}</span>
                </div>
              );
            })}
            <div className="effort"><h2>Effort vs fee burned</h2><small>{studioMode === "projected" ? "Estimated hours from simulated burn · fee from tracker" : "Hours need project timesheets · fee from tracker"}</small></div>
            {d.timeline.slice(0, 3).map((l, i) => {
              const estHrs = Math.max(120, Math.round(((l.billed_amount ?? 0) || (l.split_value ?? 0) * 0.25) / 3800));
              return (
                <div className="erow" key={l.id}>
                  <span style={{ textAlign: "left", color: "var(--fg)", fontSize: 15 }}>{l.client_name ?? l.project_number}</span>
                  <i style={{ ["--w" as string]: `${Math.min(100, (l.billed_pct ?? 0) * 100)}%`, ["--c" as string]: i ? "var(--blue-soft)" : "var(--pink)" }} />
                  <span>{studioMode === "projected" ? `~${estHrs.toLocaleString("en-IN")} hrs est.` : "Hours n/a"} · {Math.round((l.billed_pct ?? 0) * 100)}% fee</span>
                </div>
              );
            })}
          </section>
          <Forecast months={d.months.slice(0, span)} committed={d.committed.slice(0, span)} span={span} setSpan={setSpan} />
        </div>
      </main>

      {/* ================= MAIL ================= */}
      {show("mail") && <main className="screen hero" hidden={tab !== "mail"}>
        <MailTab projects={d.timeline} clients={d.clients} open={d.open} notifications={notifications} onDraft={openDraft} toast={setToast} />
      </main>}

      <dialog ref={draftDialog} className="sheet" aria-labelledby="draft-title" onClose={() => setDraft(null)}>
        {draft && (
          <form method="dialog">
            <h2 id="draft-title">Draft</h2>
            <p className="note">Nothing is sent from here. Copy it into your mailbox to send.</p>
            <label htmlFor="d-to">To</label><input id="d-to" className="field" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            <label htmlFor="d-sub">Subject</label><input id="d-sub" className="field" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
            <label htmlFor="d-body">Message</label><textarea id="d-body" className="field" rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            <div className="row">
              <button type="submit" className="pill">Close</button>
              <button type="button" className="pill pink" onClick={() => navigator.clipboard?.writeText(`Subject: ${draft.subject}\n\n${draft.body}`).then(() => setToast("Draft copied"), () => setToast("Select the text and copy it"))}>Copy draft</button>
            </div>
          </form>
        )}
      </dialog>
      <dialog ref={dialog} className="sheet" aria-labelledby="mark-title">
        <MarkStage stages={d.openStages} pending={pending} onClose={() => dialog.current?.close()} onSave={(s) => { run(markStage({ ...s, event: "complete" })); dialog.current?.close(); }} />
      </dialog>
      {showCompliance && (
        <div className="f-modal" role="dialog" aria-modal="true" aria-labelledby="comp-title" onClick={(e) => { if (e.target === e.currentTarget) setShowCompliance(false); }}>
          <div className="sheet card po-sheet">
            <h2 id="comp-title">Code compliance · NBC 2016 &amp; municipal bye-law checklist</h2>
            <p className="note">Evaluated across top active project lines. Verify or flag lines; every action is logged in the audit trail.</p>
            {compliance.map((c) => (
              <div className="comp-item" key={c.row_no}>
                <div className="dhead">
                  <div>
                    <b>{c.client_name ?? c.project_number} · {c.studio ?? "—"}</b>
                    <div className="note">{c.project_name} · {c.project_number} · {c.location ?? "India"} · {c.project_type ?? "Commercial"}</div>
                  </div>
                  <div className="f-acts">
                    <span className={`tag ${c.review_status === "approved" ? "t-green" : c.review_status === "flagged" ? "t-pink" : "t-amber"}`}>{c.review_status}</span>
                    {can(role, "agent.contract_watch") && (
                      <>
                        <button className="pill" disabled={pending} onClick={() => run(runComplianceDecision({ row_no: c.row_no, decision: "approved" }))}>Verify</button>
                        <button className="pill" disabled={pending} onClick={() => run(runComplianceDecision({ row_no: c.row_no, decision: "dismissed", note: "Needs sanction drawing check" }))}>Flag</button>
                      </>
                    )}
                  </div>
                </div>
                <div className="comp-checks">
                  {c.checks.map((ck, i) => (
                    <div className="krow" key={i}>
                      <div className="t"><b>{ck.rule}</b><small>{ck.detail}</small></div>
                      <span className={`tag ${ck.status === "pass" ? "t-green" : ck.status === "flag" ? "t-pink" : "t-amber"}`}>{ck.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="row"><button className="pill" onClick={() => setShowCompliance(false)}>Close</button></div>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Fragment2({ children }: { children: React.ReactNode }) { return <>{children}</>; }
function shorten(s: string | null | undefined, n = 32) { if (!s) return "stage"; const t = s.replace(/^upon\s+/i, ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
function ago(at: string | null | undefined, today: string, waiting = false) {
  if (!at) return "";
  void today;
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 86400000));
  return waiting ? `${days} day${days === 1 ? "" : "s"}` : days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

function Buttons({ primary, allowed, pending, onPrimary, onDismiss, onEdit }: { primary: string; allowed: boolean; pending: boolean; onPrimary: () => void; onDismiss: () => void; onEdit: () => void }) {
  if (!allowed) return <div className="abtns"><button className="pill" onClick={onEdit}>View draft</button><span className="note">Your role can view, not approve.</span></div>;
  return <div className="abtns"><button className="pill solid" disabled={pending} onClick={onPrimary}>{primary}</button><button className="pill" onClick={onEdit}>Edit</button><button className="pill" disabled={pending} onClick={onDismiss}>Dismiss</button></div>;
}
function Empty({ agent, tone, text }: { agent: string; tone: string; text: string }) {
  return <article className="acard"><div className="dmeta"><span className={`tag ${tone}`} style={tone ? undefined : { color: "var(--fg)" }}>{agent}</span><span>Clear</span></div><h3>Nothing to approve</h3><p>{text}</p></article>;
}

const STAGE_CAT_LABEL: Record<ClientStageNode["category"], { label: string; tone: string }> = {
  advance: { label: "Advance", tone: "t-amber" },
  design: { label: "Design", tone: "t-blue" },
  construction: { label: "Construction", tone: "t-pink" },
};

function ClientTree({
  clients, selectedClient, selectedProject, selectedStudio, selectedStage, nameFilter,
  onPickClient, onPickProject, onPickStudio, onPickStage, role, pending, onMarkStage,
}: {
  clients: ClientNode[];
  selectedClient: string | null;
  selectedProject: string | null;
  selectedStudio: string | null;
  selectedStage: number | null;
  nameFilter: string;
  onPickClient: (c: string) => void;
  onPickProject: (pn: string, clientName?: string) => void;
  onPickStudio: (s: string) => void;
  onPickStage: (id: number | null, meta?: { client?: string; project?: string; studio?: string | null }) => void;
  role: Role;
  pending: boolean;
  onMarkStage: (s: { project_number: string; studio: string | null; seq: number; event: "complete" | "client_approved" | "finance_notified" }) => void;
}) {
  const q = nameFilter.trim().toLowerCase();
  const matches = (s: string | null | undefined) => !!s && s.toLowerCase().includes(q);
  const visibleClients = useMemo(() => {
    const base = selectedClient
      ? clients.filter((c) => c.client === selectedClient)
      : selectedProject
        ? clients.filter((c) => c.projects.some((p) => p.project_number === selectedProject))
        : clients;
    return base.map((c) => {
      const clientHit = !q || matches(c.client);
      const projects = c.projects
        .filter((p) => !selectedProject || p.project_number === selectedProject)
        .map((p) => {
          const projHit = clientHit || [p.name, p.project_number, p.location, p.type].some(matches);
          const studios = p.studios
            .filter((s) => !selectedStudio || s.studio === selectedStudio)
            .map((s) => {
              const studHit = projHit || [s.studio, s.spoc, s.stage].some(matches);
              const stages = s.stages
                .filter((st) => !selectedStage || st.id === selectedStage)
                .filter((st) => studHit || matches(st.stage));
              if (!studHit && stages.length === 0) return null;
              if (selectedStage != null && stages.length === 0) return null;
              return { ...s, stages };
            })
            .filter((s): s is NonNullable<typeof s> => s !== null);
          if (studios.length === 0) return null;
          return { ...p, studios };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);
      if (projects.length === 0) return null;
      return { ...c, projects };
    }).filter((c): c is NonNullable<typeof c> => c !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, selectedClient, selectedProject, selectedStudio, selectedStage, q]);

  return (
    <section className="card ctree">
      <div className="ahead">
        <h2>Clients, projects, studios &amp; billing stages</h2>
        <small>{plural(visibleClients.length, "client")} (A–Z) · expand Client → Project → Studio to inspect every milestone and trigger billing</small>
      </div>
      {visibleClients.length === 0 && <p className="note">No active projects or milestones match this filter.</p>}
      {visibleClients.map((c) => {
        const isClientOpen = Boolean(q) || c.client === selectedClient || c.projects.some((p) => p.project_number === selectedProject);
        return (
        <details key={c.client} open={isClientOpen} className="cnode">
          <summary>
            <b>{c.client}</b>
            <span className="cmeta">{plural(c.projects.length, "project")} · {plural(c.projects.reduce((a, p) => a + p.studios.length, 0), "studio scope")}</span>
            <span className="num">{inr(c.contract)}</span>
            <span className="cmeta num">{c.contract ? Math.round((c.billed / c.contract) * 100) : 0}% billed · {inr(c.yetToBill)} to bill</span>
          </summary>
          <div className="cproj">
            <div className="tree-acts">
              {c.client !== selectedClient && <button className="pill" onClick={() => onPickClient(c.client)}>Filter dashboard to {c.client}</button>}
              {c.client === selectedClient && <button className="pill" onClick={() => onPickClient("")}>Show all clients</button>}
              {selectedProject && <button className="pill" onClick={() => onPickProject("")}>Show all {c.client} projects</button>}
            </div>
            {c.projects.map((p) => {
              const isProjOpen = Boolean(q) || p.project_number === selectedProject || c.projects.length === 1;
              return (
                <details key={p.project_number} open={isProjOpen} className="pnode">
                  <summary>
                    <div className="pname">
                      <b>{p.name ?? p.project_number}</b>
                      <span>{[p.project_number.trim(), p.location, p.type, p.validity].filter(Boolean).join(" · ")}</span>
                    </div>
                    <span className="cmeta">{plural(p.studios.length, "studio")}</span>
                    <div className="num pval">
                      <b>{inr(p.contract)}</b>
                      <small>{p.contract ? Math.round((p.billed / p.contract) * 100) : 0}% billed · {inr(p.yetToBill)} to bill</small>
                    </div>
                  </summary>
                  <div className="sbox-tree">
                    <div className="tree-acts">
                      {p.project_number !== selectedProject
                        ? <button className="pill" onClick={() => onPickProject(p.project_number, c.client)}>Filter dashboard to {p.project_number}</button>
                        : <button className="pill" onClick={() => onPickProject("")}>Clear project filter</button>}
                      {p.start_date && p.end_date && <span className="cmeta">Contract {niceDate(p.start_date)} → {niceDate(p.end_date)}</span>}
                    </div>
                    {p.studios.map((s, si) => {
                      const billedStages = s.stages.filter((st) => st.billed_on || st.workflow_status === "billed" || st.workflow_status === "invoiced").length;
                      const isStudioOpen = Boolean(q) || selectedStage != null || p.project_number === selectedProject || s.studio === selectedStudio || p.studios.length === 1;
                      return (
                        <details key={`${p.project_number}-${s.studio ?? "none"}-${si}`} open={isStudioOpen} className="snode">
                          <summary>
                            <div>
                              <b>{s.studio ?? "Unassigned studio"}</b>
                              <span className="cmeta">
                                {s.splitPct != null ? `${Math.round(s.splitPct * 100)}% share` : "100%"} · {plural(s.stages.length, "milestone")} ({billedStages} billed)
                                {s.spoc ? ` · SPOC: ${s.spoc}` : ""}
                              </span>
                            </div>
                            <div className="smeta">
                              <span className="tag t-blue">Design {inr(s.designValue)}</span>
                              <span className="tag t-pink">Construction {inr(s.constructionValue)}</span>
                            </div>
                            <div className="num pval">
                              <b>{inr(s.value)}</b>
                              <small>{s.billedPct != null ? `${Math.round(s.billedPct * 100)}%` : "0%"} billed · {inr(s.yetToBill)} to bill</small>
                            </div>
                          </summary>
                          <div className="sbody">
                            <div className="tree-acts">
                              {s.studio && s.studio !== selectedStudio && (
                                <button className="pill" onClick={() => onPickStudio(s.studio!)}>Filter studio: {s.studio}</button>
                              )}
                              {s.studio && s.studio === selectedStudio && role !== "project_manager" && (
                                <button className="pill" onClick={() => onPickStudio("")}>Clear studio filter</button>
                              )}
                              {selectedStage != null && (
                                <button className="pill" onClick={() => onPickStage(null)}>Show all milestones</button>
                              )}
                              {s.stage && <span className="cmeta">Current stage: {s.stage}</span>}
                            </div>
                            {s.stages.length === 0 ? (
                              <p className="note">No contractual billing milestones recorded for this studio line.</p>
                            ) : (
                              <div className="st-wrap">
                                <table className="st-table">
                                  <thead>
                                    <tr>
                                      <th>#</th>
                                      <th>Milestone / billing stage</th>
                                      <th>Bucket</th>
                                      <th className="r">%</th>
                                      <th className="r">Fee</th>
                                      <th>Status</th>
                                      <th className="r">Action</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {s.stages.map((st) => {
                                      const cat = STAGE_CAT_LABEL[st.category];
                                      const isBilled = Boolean(st.billed_on) || st.workflow_status === "billed" || st.workflow_status === "invoiced";
                                      const isFocused = selectedStage === st.id;
                                      return (
                                        <tr key={st.id}>
                                          <td className="num">{st.seq}</td>
                                          <td>{st.stage ?? `Stage ${st.seq}`}</td>
                                          <td><span className={`tag ${cat.tone}`}>{cat.label}</span></td>
                                          <td className="r num">{st.pct != null ? `${(st.pct * 100).toFixed(st.pct * 100 % 1 ? 1 : 0)}%` : "—"}</td>
                                          <td className="r num">{st.fee != null ? inr(st.fee) : "—"}</td>
                                          <td>
                                            {isBilled ? (
                                              <span className="tag t-green">{st.billed_on ? `Billed ${niceDate(st.billed_on)}` : "Invoiced"}</span>
                                            ) : st.workflow_status === "finance_notified" ? (
                                              <span className="tag t-blue">In Finance queue</span>
                                            ) : st.workflow_status === "client_approved" ? (
                                              <span className="tag t-amber">Client approved</span>
                                            ) : st.workflow_status === "complete" ? (
                                              <span className="tag t-amber">Stage complete</span>
                                            ) : (
                                              <span className="tag t-grey">{st.workflow_status === "in_progress" ? "In progress" : "Pending"}</span>
                                            )}
                                          </td>
                                          <td className="r">
                                            <div className="st-actions">
                                              <button
                                                className={`pill${isFocused ? " solid" : ""}`}
                                                onClick={() => isFocused ? onPickStage(null) : onPickStage(st.id, { client: c.client, project: p.project_number, studio: s.studio })}
                                              >
                                                {isFocused ? "All milestones" : "Focus"}
                                              </button>
                                              {isBilled || st.workflow_status === "finance_notified" ? (
                                                <span className="cmeta">{st.workflow_status === "finance_notified" ? "Awaiting invoice" : "Done"}</span>
                                              ) : st.workflow_status === "client_approved" && can(role, "stage.notify_finance") ? (
                                                <button className="pill solid" disabled={pending} onClick={() => onMarkStage({ project_number: p.project_number, studio: s.studio, seq: st.seq, event: "finance_notified" })}>Send to Finance</button>
                                              ) : st.workflow_status === "complete" && can(role, "stage.approve") ? (
                                                <button className="pill" disabled={pending} onClick={() => onMarkStage({ project_number: p.project_number, studio: s.studio, seq: st.seq, event: "client_approved" })}>Record approval</button>
                                              ) : (st.workflow_status === "pending" || st.workflow_status === "in_progress") && can(role, "stage.complete") ? (
                                                <button className="pill" disabled={pending} onClick={() => onMarkStage({ project_number: p.project_number, studio: s.studio, seq: st.seq, event: "complete" })}>Mark complete</button>
                                              ) : (
                                                <span className="cmeta">View only</span>
                                              )}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        </details>
        );
      })}
    </section>
  );
}

function Ageing({ open }: { open: Dash["open"] }) {
  const names = ["0-15", "16-30", "31-45", "46-90", "90+"];
  const vals = names.map((n) => open.filter((i) => i.bucket === n).reduce((s, i) => s + i.balance, 0));
  const max = Math.max(...vals, 1);
  const old = open.filter((i) => i.bucket === "90+");
  const projects = [...new Set(old.map((i) => i.project_name ?? i.customer_name))];
  return (
    <section className="card ageing">
      <div className="ahead"><h2>Receivables ageing</h2><small>30-day terms</small></div>
      <div className="abars">{vals.map((v, i) => <div key={i} className={i === 4 ? "hot" : undefined}>{v ? inr(v) : "₹0"}<i style={{ height: Math.max(9, Math.round((v / max) * 96)) }} /></div>)}</div>
      <div className="alab">{["0–15", "16–30", "31–45", "46–90", "90+"].map((n) => <span key={n}>{n}</span>)}</div>
      <p>{old.length ? `90+ holds ${old.length} invoice${old.length > 1 ? "s" : ""} on ${projects.join(", ")}.` : "Nothing is over 90 days."} Buckets come from Zoho Books.</p>
    </section>
  );
}

function Bubbles({ items }: { items: { name: string; share: number }[] }) {
  // Areas follow the shares; layout follows the design: big circle left, second top-right, third below it.
  const R = 100, size = (s: number) => Math.max(56, Math.round(2 * R * Math.sqrt(s / Math.max(items[0]?.share ?? 1, 0.0001))));
  const pos = [{ left: 0, top: 27 }, { left: 173, top: -7 }, { left: 208, top: 131 }];
  const look = [{ background: "var(--pink)" }, { background: "var(--blue)", border: "3px solid var(--surface)" }, { border: "1.5px solid #4A4A52", background: "repeating-linear-gradient(135deg,var(--raised) 0 5px,var(--surface) 5px 10px)" }];
  return (
    <div className="bwrap">
      {items.map((it, i) => {
        const s = i === 0 ? 200 : Math.min(i === 1 ? 104 : 65, size(it.share));
        return <div key={it.name} className="bub" style={{ width: s, height: s, ...pos[i], ...look[i] }}>
          <div><b style={{ fontSize: i === 0 ? 38 : i === 1 ? 21 : 13.5, fontWeight: i === 2 ? 400 : 300 }}>{(it.share * 100).toFixed(1)}%</b>{i < 2 && <small style={i === 0 ? { fontSize: 15 } : undefined}>{it.name}</small>}</div>
        </div>;
      })}
    </div>
  );
}

function Forecast({ months, committed, span, setSpan }: { months: string[]; committed: number[]; span: 6 | 12; setSpan: (s: 6 | 12) => void }) {
  const max = Math.max(...committed, 1);
  const step = 428 / Math.max(committed.length - 1, 1);
  const pts = committed.map((v, i) => [20 + i * step, 104 - (v / max) * 90] as const);
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <section className="card forecast">
      <div className="fhead"><h2>Billing forecast</h2><div className="seg sm" role="group" aria-label="Range"><button aria-pressed={span === 12} onClick={() => setSpan(12)}>12 months</button><button aria-pressed={span === 6} onClick={() => setSpan(6)}>6 months</button></div></div>
      <svg viewBox="0 0 468 120" role="img" aria-label={`Committed billing for the next ${span} months`}>
        <line x1="0" y1="10" x2="468" y2="10" stroke="#2A2A30" /><line x1="0" y1="52" x2="468" y2="52" stroke="#2A2A30" /><line x1="0" y1="94" x2="468" y2="94" stroke="#2A2A30" />
        <path key={span} className="draw" d={path} fill="none" stroke="#8FA8FF" strokeWidth="2.4" strokeLinejoin="round" pathLength={1} />
        {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="4" fill="#8FA8FF"><title>{inr(committed[i])}</title></circle>)}
      </svg>
      <div className="months">{months.map((m) => <span key={m}>{["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m.slice(5)) - 1]}</span>)}</div>
      <div className="legend"><span><i style={{ background: "var(--blue-soft)" }} />Committed, stage dated · {inr(committed.reduce((a, b) => a + b, 0))}</span><span><i style={{ background: "var(--pink-text)" }} />Probable, AI estimate · not built</span></div>
      <p>Committed is the next unbilled construction instalment on each active line, one per month. Design stages carry no dates in the tracker yet.</p>
    </section>
  );
}

function MarkStage({ stages, pending, onClose, onSave }: { stages: Dash["openStages"]; pending: boolean; onClose: () => void; onSave: (s: { project_number: string; studio: string | null; seq: number }) => void }) {
  const lines = useMemo(() => {
    const m = new Map<string, { key: string; label: string; items: typeof stages }>();
    for (const s of stages) { const key = `${s.project_number}|${s.studio ?? ""}`; const g = m.get(key) ?? { key, label: `${s.label} · ${s.studio ?? ""} (${s.project_number})`, items: [] }; g.items.push(s); m.set(key, g); }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [stages]);
  const [line, setLine] = useState("");
  const [stage, setStage] = useState("");
  const items = lines.find((l) => l.key === line)?.items ?? [];
  const chosen = items.find((s) => String(s.id) === stage);
  return (
    <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (chosen) onSave({ project_number: chosen.project_number, studio: chosen.studio, seq: chosen.seq }); }}>
      <h2 id="mark-title">Mark stage complete</h2>
      <label htmlFor="ms-line">Project line</label>
      <select id="ms-line" value={line} onChange={(e) => { setLine(e.target.value); setStage(""); }} required>
        <option value="">Choose a project line…</option>
        {lines.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
      </select>
      <label htmlFor="ms-stage">Stage</label>
      <select id="ms-stage" value={stage} onChange={(e) => setStage(e.target.value)} required disabled={!line}>
        <option value="">Choose a stage…</option>
        {items.map((s) => <option key={s.id} value={s.id} disabled={s.status === "complete" || s.status === "client_approved"}>{shorten(s.stage, 70)} · {inr(s.fee)}{s.status === "complete" ? " (already complete)" : s.status === "client_approved" ? " (approved)" : ""}</option>)}
      </select>
      <div className="row"><button type="button" className="pill" onClick={onClose}>Cancel</button><button className="pill pink" disabled={!chosen || pending}>Mark complete</button></div>
    </form>
  );
}

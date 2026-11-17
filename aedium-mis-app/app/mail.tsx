"use client";
import type { Dash } from "@/lib/data";

// Coming soon: organisation-wide client email per project, through an Outlook MCP server or Microsoft Graph.
export default function MailTab({ projects }: { projects: Dash["timeline"] }) {
  return (
    <>
      <div className="eyebrow">Mail · coming soon</div>
      <h1>Every client conversation, <em>filed by project.</em></h1>
      <p className="lede">Email between Aedium and its clients, grouped by project across the organisation, with the agreements and approvals each thread contains. It will connect through an Outlook MCP server or Microsoft Graph, respecting mailbox permissions; HR, legal and partner mail stays out.</p>
      <div className="m-grid">
        <section className="card m-list" aria-label="Projects">
          <h2>Projects</h2>
          {projects.map((p) => <div className="m-proj" key={p.id}><b>{p.client_name ?? p.project_number}</b><small>{p.project_number} · {p.studio}</small><span className="tag t-grey">— threads</span></div>)}
        </section>
        <section className="card m-thread">
          <div className="m-soon"><span className="tag t-amber">Coming soon</span><h2>Connect Outlook</h2>
            <p>Once connected, this panel shows the selected project&apos;s threads, the latest client reply, open asks, and approvals the agents can cite as evidence (for example a client&apos;s stage sign-off before an invoice).</p>
            <div className="m-steps">
              <div><b>1</b><span>Admin consents to Microsoft Graph (Mail.Read, organisation-wide) or connects an Outlook MCP server.</span></div>
              <div><b>2</b><span>Mail is matched to projects by client domain, PO number and project number.</span></div>
              <div><b>3</b><span>The Email evidence agent answers &quot;what was agreed&quot; with the source email.</span></div>
            </div>
            <button className="pill" disabled>Connect Outlook</button>
          </div>
        </section>
      </div>
    </>
  );
}

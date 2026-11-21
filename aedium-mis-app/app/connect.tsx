"use client";
import { useState, useTransition } from "react";
import { newApiKey, revokeApiKey, testMcpCall } from "./actions";
import { niceDate, timeOf } from "@/lib/format";
import type { AuditRun, KeyInfo } from "@/lib/agents/keys";
import { AGENTS } from "@/lib/agents/agents";

export type Run = AuditRun;
type Client = "connector" | "codex" | "claude-code" | "claude-desktop" | "gemini" | "editors";
const CLIENTS: { id: Client; label: string }[] = [
  { id: "connector", label: "claude.ai · ChatGPT" },
  { id: "codex", label: "Codex CLI" },
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude desktop" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "editors", label: "Cursor · VS Code · Windsurf" },
];

const AGENT_TOOLS: Record<string, string[]> = {
  analyst: ["get_summary", "get_insights", "order_book", "find_projects", "billing_by_month", "tracker_sheet", "search", "fetch", "audit_log"],
  po_intake: ["get_po_schema", "stage_po", "list_pos", "get_po", "review_po", "tracker_rows_for_excel"],
  finance: ["finance_queue", "raise_invoice", "record_payment", "open_invoices", "payments"],
  planner: ["fy_plan", "set_fy_target", "set_construction_schedule", "monthly_projection", "add_projection", "autofill_projection"],
  collections: ["agent_queue", "draft_email", "decide_agent_item", "open_invoices"],
  invoice_trigger: ["agent_queue", "project_stages", "mark_stage", "draft_email", "decide_agent_item"],
  contract_watch: ["agent_queue", "contracts_ending", "escalations", "decide_escalation", "draft_email", "decide_agent_item"],
  email_evidence: ["email_evidence_search", "log_project_email"],
  code_compliance: ["code_compliance_check", "decide_code_compliance"],
};

const TEST_PRESETS: { id: string; label: string; tool: string; args: Record<string, unknown> }[] = [
  { id: "summary", label: "Aedium analyst · get_summary", tool: "get_summary", args: {} },
  { id: "email", label: "Email evidence agent · email_evidence_search", tool: "email_evidence_search", args: { limit: 5 } },
  { id: "compliance", label: "Code compliance agent · code_compliance_check", tool: "code_compliance_check", args: { limit: 5 } },
  { id: "collections", label: "Collections agent · agent_queue (collections)", tool: "agent_queue", args: { agent: "collections", limit: 5 } },
  { id: "fy_plan", label: "Planning agent · fy_plan", tool: "fy_plan", args: {} },
  { id: "escalations", label: "Contract watch agent · escalations", tool: "escalations", args: {} },
  { id: "tracker", label: "Aedium analyst · tracker_sheet (summary)", tool: "tracker_sheet", args: { sheet: "summary", limit: 5 } },
  { id: "finance", label: "Finance agent · finance_queue", tool: "finance_queue", args: {} },
];

export default function Connect({ origin, keys, runs, setupError, toast }: { origin: string; keys: KeyInfo[]; runs: Run[]; setupError: string | null; toast: (m: string) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "act">("act");
  const [fresh, setFresh] = useState<string | null>(null);
  const [client, setClient] = useState<Client>("connector");
  const [testClient, setTestClient] = useState("Codex CLI");
  const [testKeyId, setTestKeyId] = useState<string>("");
  const [presetId, setPresetId] = useState(TEST_PRESETS[0].id);
  const [testResult, setTestResult] = useState<{ ok: boolean; agent?: string; client?: string; ms?: number; text: string } | null>(null);
  const [pending, start] = useTransition();
  const url = `${origin}/api/mcp`;
  const key = fresh ?? "<your key>";
  const snippet = snippets(client, url, key);
  const activeKeys = keys.filter((k) => !k.revoked_at);

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Select the text and copy it"));

  return (
    <>
      <div className="eyebrow">Connect AI · MCP server</div>
      <h1>Your data, <em>in any AI assistant.</em></h1>
      <p className="lede">Create an API key, add the Aedium server to ChatGPT, Claude, Codex, Gemini CLI, Cursor, VS Code or Windsurf, and run all 9 agents directly from your assistant. Every UI and MCP action is audited below.</p>

      {setupError && <div className="banner">{setupError}</div>}

      <div className="k-grid">
        <section className="card k-new">
          <h2>1. Create a key</h2>
          <form onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await newApiKey({ name, scope }); if (r.ok) { setFresh(r.key); setName(""); toast("Key created. Copy it now; it is shown once."); } else toast(r.message); }); }}>
            <label htmlFor="k-name">Name</label>
            <input id="k-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Melixa · Codex / Claude" maxLength={80} />
            <label htmlFor="k-scope">Access</label>
            <div className="seg" role="group" id="k-scope" aria-label="Access">
              <button type="button" aria-pressed={scope === "act"} onClick={() => setScope("act")}>Read and act</button>
              <button type="button" aria-pressed={scope === "read"} onClick={() => setScope("read")}>Read only</button>
            </div>
            <p className="note">{scope === "act" ? "Can read everything, record stages, approve POs, verify compliance, log emails, and update plans. Never sends email." : "Can read the tracker, receivables, compliance checks, email evidence and agent queues."}</p>
            <button className="pill pink" disabled={pending}>{pending ? "Creating…" : "Create key"}</button>
          </form>
          {fresh && (
            <div className="k-fresh">
              <div className="note">Your new key. It is shown once; store it like a password.</div>
              <code>{fresh}</code>
              <button className="pill" onClick={() => copy(fresh)}>Copy key</button>
            </div>
          )}
        </section>

        <section className="card k-setup">
          <h2>2. Add the server</h2>
          <div className="k-clients" role="tablist" aria-label="AI client">
            {CLIENTS.map((c) => <button key={c.id} role="tab" aria-selected={client === c.id} onClick={() => setClient(c.id)}>{c.label}</button>)}
          </div>
          <p className="note">{snippet.how}</p>
          <pre className="qtrace k-code">{snippet.code}</pre>
          <div className="row"><button className="pill" onClick={() => copy(snippet.code)}>Copy</button>{!fresh && <span className="note">Create a key first to fill it in.</span>}</div>
          <p className="note">Server URL <code>{url}</code> · Streamable HTTP · key in <code>Authorization: Bearer</code>, <code>X-API-Key</code>, or the URL.</p>
        </section>
      </div>

      <div className="k-grid">
        <section className="card">
          <h2>Keys</h2>
          {keys.length ? keys.map((k) => (
            <div className="krow" key={k.id}>
              <div className="t"><b>{k.name}</b><small>{k.prefix}… · {k.role} · {k.scope === "act" ? "Read and act" : "Read only"} · created {niceDate(k.created_at)}{k.last_used_at ? ` · used ${niceDate(k.last_used_at)}` : " · not used yet"}</small></div>
              {k.revoked_at ? <span className="tag t-grey">Revoked</span>
                : <button className="pill" disabled={pending} onClick={() => start(async () => { const r = await revokeApiKey(k.id); toast(r.message); })}>Revoke</button>}
            </div>
          )) : <div className="empty">No keys yet.</div>}
        </section>

        <section className="card k-test">
          <h2>3. Test an Agent or Tool live</h2>
          <p className="note">Execute a live MCP tool call with your role &amp; API key permissions and see it logged immediately in the audit trail.</p>
          <div className="k-test-form">
            <select aria-label="Test client" className="field" value={testClient} onChange={(e) => setTestClient(e.target.value)}>
              {["Codex CLI", "Claude Code", "ChatGPT", "Cursor", "Gemini CLI", "Windsurf"].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select aria-label="Test API key" className="field" value={testKeyId} onChange={(e) => setTestKeyId(e.target.value)}>
              <option value="">{activeKeys.length ? `Session default (${activeKeys[0].name})` : "Demo session key (read)"}</option>
              {activeKeys.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.scope} · {k.role})</option>)}
            </select>
            <select aria-label="Agent tool preset" className="field" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
              {TEST_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button
              className="pill pink"
              disabled={pending}
              onClick={() => {
                const preset = TEST_PRESETS.find((p) => p.id === presetId) ?? TEST_PRESETS[0];
                const chosenKey = testKeyId ? Number(testKeyId) : activeKeys[0]?.id;
                start(async () => {
                  const r = await testMcpCall({ key_id: chosenKey, client: testClient, tool: preset.tool, args: preset.args });
                  if (r.ok) {
                    setTestResult({ ok: true, agent: r.agent, client: r.client, ms: r.ms, text: JSON.stringify(r.output, null, 2).slice(0, 2400) });
                    toast(`${r.agent} responded in ${r.ms} ms`);
                  } else {
                    setTestResult({ ok: false, text: r.message });
                    toast(r.message);
                  }
                });
              }}
            >
              {pending ? "Running…" : "Run MCP call"}
            </button>
          </div>
          {testResult && (
            <div className="k-test-out">
              <div className="dmeta">
                <span className={`tag ${testResult.ok ? "t-green" : "t-pink"}`}>{testResult.ok ? "OK" : "Error"}</span>
                <span>{testResult.agent ? `${testResult.agent} · via ${testResult.client} · ${testResult.ms} ms` : "Failed"}</span>
              </div>
              <pre className="qtrace">{testResult.text}</pre>
            </div>
          )}
        </section>
      </div>

      <section className="card k-catalog">
        <div className="dhead">
          <div>
            <h2>4. Available Agents &amp; Tools Catalog</h2>
            <span className="note">All 9 agents are active via MCP prompts (<code>get_agent</code>) and tools on <code>{url}</code>.</span>
          </div>
          <span className="tag t-green">9 active agents · 39 tools</span>
        </div>
        <div className="k-cat-grid">
          {AGENTS.map((a) => (
            <article className="acard" key={a.name}>
              <div className="dmeta"><span className="tag t-green">Active</span><code>{a.name}</code></div>
              <h3>{a.title}</h3>
              <p>{a.description}</p>
              <div className="k-tools">{(AGENT_TOOLS[a.name] ?? []).map((t) => <code key={t}>{t}</code>)}</div>
            </article>
          ))}
        </div>
      </section>

      <section className="card audit-card">
        <div className="dhead">
          <div>
            <h2>Activity &amp; Change Audit Log</h2>
            <span className="note">Every UI mutation and external MCP/Agent call, with timestamp, user, owning agent and exact target.</span>
          </div>
          <span className="note">{runs.length} entries</span>
        </div>
        {runs.length ? (
          <div className="t-scroll audit-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time (IST)</th>
                  <th>Who / Role</th>
                  <th>Agent</th>
                  <th>Client &amp; Key</th>
                  <th>Tool &amp; Target</th>
                  <th>Details / Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{niceDate(r.created_at)} {timeOf(r.created_at)}</td>
                    <td><b>{r.actor}</b>{r.role ? <small className="audit-sub"> · {r.role}</small> : null}</td>
                    <td><span className="tag t-blue">{r.agent}</span></td>
                    <td>{r.source}</td>
                    <td><code>{r.tool}</code>{r.target ? <div className="audit-sub">{r.target}</div> : null}</td>
                    <td>
                      <span className={`tag ${r.ok ? "t-green" : "t-pink"}`}>{r.ok ? "OK" : "Error"}</span>{" "}
                      <span>{r.error ? r.error : r.detail}</span>
                      {r.ms ? <small className="audit-sub"> · {r.ms} ms</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No calls yet. Create a key or trigger any action to record it here.</div>}
      </section>
    </>
  );
}

function snippets(c: Client, url: string, key: string) {
  const auth = `Bearer ${key}`;
  switch (c) {
    case "connector": return {
      how: "claude.ai: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode, then Create. Paste this URL and choose no authentication: the key is inside the URL, so treat the URL as a secret.",
      code: `${url}/k/${key}`,
    };
    case "codex": return {
      how: "Run in your terminal (or add the block below to ~/.codex/config.toml):",
      code: `export AEDIUM_API_KEY="${key}"\ncodex mcp add aedium --url ${url} --bearer-token-env-var AEDIUM_API_KEY\n\n# ~/.codex/config.toml\n[mcp_servers.aedium]\nurl = "${url}"\nbearer_token_env_var = "AEDIUM_API_KEY"`,
    };
    case "claude-desktop": return {
      how: "Claude desktop → Settings → Developer → Edit config, add this to claude_desktop_config.json, then restart Claude. Needs Node.js.",
      code: JSON.stringify({ mcpServers: { aedium: { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${AEDIUM_AUTH}"], env: { AEDIUM_AUTH: auth } } } }, null, 2),
    };
    case "claude-code": return {
      how: "Run in a terminal:",
      code: `claude mcp add --transport http aedium ${url} --header "Authorization: ${auth}"`,
    };
    case "gemini": return {
      how: "Add to ~/.gemini/settings.json (or the project's .gemini/settings.json), then run /mcp in Gemini CLI to check it is connected.",
      code: JSON.stringify({ mcpServers: { aedium: { httpUrl: url, headers: { Authorization: auth } } } }, null, 2),
    };
    case "editors": return {
      how: "Cursor: ~/.cursor/mcp.json. VS Code: .vscode/mcp.json (use \"servers\" and \"type\": \"http\"). Windsurf: ~/.codeium/windsurf/mcp_config.json (use \"serverUrl\" instead of \"url\").",
      code: JSON.stringify({ mcpServers: { aedium: { url, headers: { Authorization: auth } } } }, null, 2),
    };
  }
}

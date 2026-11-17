"use client";
import { useState, useTransition } from "react";
import { newApiKey, revokeApiKey } from "./actions";
import { niceDate, timeOf } from "@/lib/format";
import type { KeyInfo } from "@/lib/agents/keys";

export type Run = { key_name: string | null; client: string | null; tool: string; ok: boolean; error: string | null; ms: number | null; created_at: string };
type Client = "claude-desktop" | "claude-code" | "connector" | "gemini" | "editors";
const CLIENTS: { id: Client; label: string }[] = [
  { id: "connector", label: "claude.ai · ChatGPT" },
  { id: "claude-desktop", label: "Claude desktop" },
  { id: "claude-code", label: "Claude Code" },
  { id: "gemini", label: "Gemini CLI" },
  { id: "editors", label: "Cursor · VS Code" },
];

export default function Connect({ origin, keys, runs, setupError, toast }: { origin: string; keys: KeyInfo[]; runs: Run[]; setupError: string | null; toast: (m: string) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "act">("act");
  const [fresh, setFresh] = useState<string | null>(null);
  const [client, setClient] = useState<Client>("connector");
  const [pending, start] = useTransition();
  const url = `${origin}/api/mcp`;
  const key = fresh ?? "<your key>";
  const snippet = snippets(client, url, key);

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Select the text and copy it"));

  return (
    <>
      <div className="eyebrow">Connect AI · MCP server</div>
      <h1>Your data, <em>in any AI assistant.</em></h1>
      <p className="lede">Create a key, add the Aedium server to Claude, ChatGPT, Gemini or your editor, and ask about projects, billing and receivables there. The same agents and tools as this dashboard; every call is logged below.</p>

      {setupError && <div className="banner">{setupError}</div>}

      <div className="k-grid">
        <section className="card k-new">
          <h2>1. Create a key</h2>
          <form onSubmit={(e) => { e.preventDefault(); start(async () => { const r = await newApiKey({ name, scope }); if (r.ok) { setFresh(r.key); setName(""); toast("Key created. Copy it now; it is shown once."); } else toast(r.message); }); }}>
            <label htmlFor="k-name">Name</label>
            <input id="k-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Melixa · Claude desktop" maxLength={80} />
            <label htmlFor="k-scope">Access</label>
            <div className="seg" role="group" id="k-scope" aria-label="Access">
              <button type="button" aria-pressed={scope === "act"} onClick={() => setScope("act")}>Read and act</button>
              <button type="button" aria-pressed={scope === "read"} onClick={() => setScope("read")}>Read only</button>
            </div>
            <p className="note">{scope === "act" ? "Can read everything and record stage steps and agent approvals. Never sends email." : "Can read the tracker, receivables and agent queues. Cannot change anything."}</p>
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
              <div className="t"><b>{k.name}</b><small>{k.prefix}… · {k.scope === "act" ? "Read and act" : "Read only"} · created {niceDate(k.created_at)}{k.last_used_at ? ` · used ${niceDate(k.last_used_at)}` : " · not used yet"}</small></div>
              {k.revoked_at ? <span className="tag t-grey">Revoked</span>
                : <button className="pill" disabled={pending} onClick={() => start(async () => { const r = await revokeApiKey(k.id); toast(r.message); })}>Revoke</button>}
            </div>
          )) : <div className="empty">No keys yet.</div>}
        </section>
        <section className="card">
          <h2>Recent calls</h2>
          {runs.length ? runs.map((r, i) => (
            <div className="lrow" key={i}><span>{timeOf(r.created_at)}</span><div><b className={r.ok ? "" : "t-pink"}>{r.tool}</b> · {r.key_name ?? "key"}{r.client ? ` · ${r.client}` : ""}{r.ms != null ? ` · ${r.ms} ms` : ""}{r.error ? <div className="note t-pink">{r.error}</div> : null}</div></div>
          )) : <div className="empty">No calls yet. They appear here as soon as an assistant uses a key.</div>}
        </section>
      </div>
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
      how: "Cursor: ~/.cursor/mcp.json as below. VS Code: .vscode/mcp.json with \"servers\" instead of \"mcpServers\" and \"type\": \"http\".",
      code: JSON.stringify({ mcpServers: { aedium: { url, headers: { Authorization: auth } } } }, null, 2),
    };
  }
}

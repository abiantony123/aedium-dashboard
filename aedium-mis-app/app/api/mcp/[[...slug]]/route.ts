// Aedium MCP server: Streamable HTTP, stateless, standard JSON-RPC. Works with any MCP client
// (Claude desktop / claude.ai connectors, ChatGPT connectors, Gemini CLI, Cursor, VS Code...).
//
// Endpoint:  https://<host>/api/mcp
// Key, any of:  Authorization: Bearer ak_live_...   |   X-API-Key: ak_live_...
//               https://<host>/api/mcp/k/ak_live_...  (for clients that only take a URL)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { toolsFor } from "@/lib/agents/tools";
import { AGENTS, RULES, SERVER_INSTRUCTIONS } from "@/lib/agents/agents";
import { verifyKey, serviceDb, logRun, agentForTool, type KeyInfo } from "@/lib/agents/keys";
import { isRole } from "@/lib/rbac";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};
const withCors = (res: Response) => { for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v); return res; };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  withCors(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } }));

function keyFrom(req: Request, slug: string[] | undefined) {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const x = req.headers.get("x-api-key"); if (x) return x.trim();
  if (slug?.[0] === "k" && slug[1]) return slug[1];
  return new URL(req.url).searchParams.get("key") ?? "";
}

// Stateless: clientInfo only arrives with `initialize`, so later calls fall back to x-mcp-client or User-Agent.
function clientName(ua: string | null, xClient: string | null) {
  if (xClient?.trim()) return xClient.trim().slice(0, 40);
  if (!ua) return null;
  const known = [["codex", "Codex CLI"], ["claude", "Claude"], ["openai", "ChatGPT"], ["chatgpt", "ChatGPT"], ["gemini", "Gemini"], ["cursor", "Cursor"], ["windsurf", "Windsurf"], ["vscode", "VS Code"], ["mcp-remote", "mcp-remote"]] as const;
  const hit = known.find(([k]) => ua.toLowerCase().includes(k));
  return hit ? hit[1] : ua.split(/[\s/]/)[0].slice(0, 40);
}

function buildServer(key: KeyInfo, ua: string | null, xClient: string | null) {
  const server = new McpServer({ name: "aedium-mis", title: "Aedium MIS", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const sb = serviceDb();
  // A key acts with its creator's role (and studio, for project directors).
  const role = isRole(key.role) ? key.role : "employee";
  const actor = { id: null, email: key.created_by ?? "api key", via: `mcp:${key.name}`, role, studio: key.studio ?? null };

  for (const t of toolsFor(key.scope, role)) {
    server.registerTool(t.name, {
      title: t.title, description: t.description, inputSchema: t.input as z.ZodRawShape,
      annotations: { readOnlyHint: t.scope === "read", destructiveHint: false, openWorldHint: false, idempotentHint: t.scope === "read" },
    }, async (input: unknown) => {
      const started = Date.now();
      const client = server.server.getClientVersion()?.name ?? clientName(ua, xClient);
      const base = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : { value: input };
      const auditedInput = { ...base, _actor: actor.email, _role: actor.role, _studio: actor.studio, _agent: agentForTool(t.name, input) };
      try {
        const out = await (t.run as (c: unknown, i: unknown) => Promise<unknown>)({ sb, actor }, input);
        await logRun({ key_id: key.id, key_name: key.name, client, tool: t.name, input: auditedInput, ok: true, ms: Date.now() - started });
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 1) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await logRun({ key_id: key.id, key_name: key.name, client, tool: t.name, input: auditedInput, ok: false, error: msg, ms: Date.now() - started });
        return { isError: true, content: [{ type: "text" as const, text: msg }] };
      }
    });
  }

  // Each agent is also an MCP prompt, for clients that list prompts (Claude desktop, VS Code...).
  for (const a of AGENTS) {
    server.registerPrompt(a.name, { title: a.title, description: a.description }, () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `${a.instructions}\n\n${RULES}\n\nStart now.` } }],
    }));
  }
  return server;
}

async function handle(req: Request, ctx: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await ctx.params;
  const key = await verifyKey(keyFrom(req, slug)).catch(() => null);
  if (!key) {
    return json(401, { jsonrpc: "2.0", error: { code: -32001, message: "Missing or revoked Aedium API key. Create one on the Connect AI page and send it as 'Authorization: Bearer <key>'." }, id: null },
      { "WWW-Authenticate": 'Bearer realm="aedium-mis"' });
  }
  if (req.method === "GET" || req.method === "DELETE") {
    // Stateless server: no standalone SSE stream and no sessions to end.
    return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Send JSON-RPC with POST." }, id: null }, { Allow: "POST, OPTIONS" });
  }
  const server = buildServer(key, req.headers.get("user-agent"), req.headers.get("x-mcp-client"));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(req));
  } finally {
    // Close after the response has been produced (JSON response mode: fully buffered).
    void transport.close(); void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export function OPTIONS() { return withCors(new Response(null, { status: 204 })); }

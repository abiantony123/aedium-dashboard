// In-app Ask tab: Claude with the same read tools the MCP server exposes (lib/agents/tools).
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { dataClient } from "@/lib/supabase/server";
import { toolsFor, jsonSchema, runTool } from "@/lib/agents/tools";
import { AGENTS, RULES } from "@/lib/agents/agents";

export const maxDuration = 120;
const MODEL = process.env.ASK_MODEL || "claude-opus-5-5";
const SYSTEM = `${AGENTS.find((a) => a.name === "analyst")!.instructions}\n\n${RULES}\nNo headings, no markdown tables, no bullet lists.`;

export async function POST(req: Request) {
  const { sb, user } = await dataClient();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: "The Ask tab needs ANTHROPIC_API_KEY set on the server. You can also ask from Claude, ChatGPT or Gemini through Connect AI." }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const question = String(body.question ?? "").trim().slice(0, 600);
  const studio = typeof body.studio === "string" && body.studio ? body.studio.slice(0, 60) : null;
  if (!question) return NextResponse.json({ error: "Type a question." }, { status: 400 });

  const client = new Anthropic();
  // Read tools only, filtered by the person's role; a project director stays in their studio.
  const READ_TOOLS = toolsFor("read", user.role);
  const TOOLS: Anthropic.Beta.BetaTool[] = READ_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));
  const ctx = { sb, actor: { id: user.id, email: user.email, via: "ask", role: user.role, studio: user.studio } };
  // Earlier turns of this chat (text only, last 4) so follow-ups like "and last month?" make sense.
  const history: Anthropic.Beta.BetaMessageParam[] = (Array.isArray(body.history) ? body.history : []).slice(-4)
    .filter((h: unknown): h is { q: string; a: string } => !!h && typeof (h as { q?: unknown }).q === "string" && typeof (h as { a?: unknown }).a === "string")
    .flatMap((h: { q: string; a: string }) => [{ role: "user" as const, content: h.q.slice(0, 600) }, { role: "assistant" as const, content: h.a.slice(0, 4000) }]);
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}.${studio ? ` The person is looking at studio "${studio}"; pass it as the studio filter where a tool takes one.` : ""}\n\nQuestion: ${question}` }];
  const trace: string[] = [];
  try {
    for (let round = 0; round < 8; round++) {
      const res = await client.beta.messages.create({
        model: MODEL, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      });
      if (res.stop_reason === "refusal") return NextResponse.json({ answer: "Claude declined to answer this question.", trace });
      messages.push({ role: "assistant", content: res.content });
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !calls.length) {
        const answer = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        return NextResponse.json({ answer: answer || "No answer came back. Try rephrasing.", trace });
      }
      const results = await Promise.all(calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        trace.push(`${c.name} ${JSON.stringify(c.input ?? {})}`);
        if (!READ_TOOLS.some((t) => t.name === c.name)) return { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Not available in the Ask tab." };
        try { return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(await runTool(c.name, ctx, c.input)).slice(0, 60000) }; }
        catch (e) { return { type: "tool_result", tool_use_id: c.id, is_error: true, content: e instanceof Error ? e.message : String(e) }; }
      }));
      messages.push({ role: "user", content: results });
    }
    return NextResponse.json({ answer: "That question needed too many lookups. Try a narrower one.", trace });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return NextResponse.json({ error: "Too many questions just now. Try again in a minute.", trace }, { status: 429 });
    if (e instanceof Anthropic.AuthenticationError) return NextResponse.json({ error: "The Anthropic API key on the server is not valid.", trace }, { status: 500 });
    if (e instanceof Anthropic.APIError) return NextResponse.json({ error: `Claude API error ${e.status}. Try again.`, trace }, { status: 502 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "The answer failed.", trace }, { status: 500 });
  }
}

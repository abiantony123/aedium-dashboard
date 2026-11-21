// Rule findings + LLM narrative for the dashboard. The page shows rule text first, then swaps this in.
import { NextResponse } from "next/server";
import { dataClient } from "@/lib/supabase/server";
import { loadDashboard } from "@/lib/data";
import { findings, narrate } from "@/lib/agents/insights";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { sb, user } = await dataClient();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const studio = sp.get("studio") || null;
  const d = await loadDashboard(sb, studio, sp.get("client") || null);
  const fs = findings(d);
  const out = await narrate(fs, studio).catch((e) => ({ narrative: null, source: "rules" as const, generated_at: null, note: String(e) }));
  return NextResponse.json({ findings: fs, ...out });
}

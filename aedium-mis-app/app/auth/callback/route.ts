import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer, isAllowedEmail } from "@/lib/supabase/server";

// Magic-link landing: swap the one-time code for a session cookie.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const sb = await supabaseServer();
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    if (!error && isAllowedEmail(data.user?.email)) return NextResponse.redirect(new URL("/", url.origin));
    if (!error) { await sb.auth.signOut(); return NextResponse.redirect(new URL("/login?e=denied", url.origin)); }
  }
  return NextResponse.redirect(new URL("/login?e=link", url.origin));
}

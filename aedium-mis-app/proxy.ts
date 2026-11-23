import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

async function passHash(code: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`aedium-demo:${code}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // The MCP server authenticates with its own API keys, not the dashboard login.
  if (path === "/api/mcp" || path.startsWith("/api/mcp/")) return NextResponse.next();
  const toLogin = () => {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Enter the passcode first." }, { status: 401 });
    const url = request.nextUrl.clone(); url.pathname = "/login"; url.search = "";
    return NextResponse.redirect(url);
  };

  // Demo mode: no accounts. The /login page has one "Enter demo" button that sets a cookie
  // (plus an optional shared passcode when DEMO_PASSCODE is set).
  // Same rule as demoMode() in lib/supabase/server.ts (kept inline: the proxy can't import next/headers code).
  const demo = /^(1|true|yes|on)$/i.test((process.env.DEMO_MODE ?? "").trim().replace(/^["']|["']$/g, "")) || !!process.env.DEMO_PASSCODE?.trim();
  if (demo) {
    if (path.startsWith("/login")) return NextResponse.next();
    const ok = request.cookies.get("aedium_demo")?.value === (await passHash(process.env.DEMO_PASSCODE || "open"));
    return ok ? NextResponse.next() : toLogin();
  }

  // Normal mode: refresh the Supabase session cookie and send signed-out visitors to /login.
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  const isPublic = path.startsWith("/login") || path.startsWith("/auth");
  if (!data.user && !isPublic) return toLogin();
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)"],
};

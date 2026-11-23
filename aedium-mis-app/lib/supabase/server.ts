import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isRole, type Role } from "../rbac";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const SUPABASE_KEY = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!;

// DEMO_MODE=1: no sign-in. Data is read on the server with the service-role key, which never reaches the browser.
// A set DEMO_PASSCODE also turns demo mode on, so a hosted copy is never left on email sign-in by a mistyped DEMO_MODE.
export const demoMode = () => /^(1|true|yes|on)$/i.test((process.env.DEMO_MODE ?? "").trim().replace(/^["']|["']$/g, "")) || !!process.env.DEMO_PASSCODE?.trim();

// Server client acting as the signed-in user, so row-level security applies to every query.
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    db: { schema: "mis" },          // the dashboard's own schema; other apps' tables stay in public
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); }
        catch { /* called from a Server Component: the proxy refreshes cookies instead */ }
      },
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = SupabaseClient<any, any, any>;
export type AppUser = { id: string | null; email: string; role: Role; studio: string | null };

function service(): Db {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("The server needs SUPABASE_SERVICE_ROLE_KEY (never exposed to the browser).");
  return createClient(SUPABASE_URL, key, { db: { schema: "mis" }, auth: { persistSession: false } });
}

// Who is acting, and the client the server reads and writes with.
// Identity comes from the demo persona cookie or the Supabase session; access is enforced in the app by role
// (lib/rbac.ts) before any query, so the server uses the service role for data.
export async function dataClient(): Promise<{ sb: Db; user: AppUser | null }> {
  const sb = service();
  if (demoMode()) {
    const [r, studio] = decodeURIComponent((await cookies()).get(ROLE_COOKIE)?.value ?? "admin").split("|");
    return { sb, user: { id: null, email: `demo-${isRole(r) ? r : "admin"}`, role: isRole(r) ? r : "admin", studio: studio || null } };
  }
  const { data } = await (await supabaseServer()).auth.getUser();
  if (!data.user?.email) return { sb, user: null };
  const email = data.user.email.toLowerCase();
  const admins = (process.env.ADMIN_EMAILS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const { data: row } = await sb.from("user_roles").select("role,studio").eq("email", email).maybeSingle();
  const role: Role = admins.includes(email) ? "admin" : isRole(row?.role) ? row!.role : "employee";
  return { sb, user: { id: data.user.id, email, role, studio: row?.studio ?? null } };
}
export const ROLE_COOKIE = "aedium_role";

// Optional shared passcode for demo mode (no accounts). Cookie holds a hash, never the passcode.
export async function passHash(code: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`aedium-demo:${code}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const PASS_COOKIE = "aedium_demo";

export function isAllowedEmail(email: string | undefined | null) {
  const rule = process.env.ALLOWED_EMAILS?.trim();
  if (!rule) return true;
  const e = (email ?? "").toLowerCase();
  return rule.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((r) => (r.startsWith("@") ? e.endsWith(r) : e === r));
}

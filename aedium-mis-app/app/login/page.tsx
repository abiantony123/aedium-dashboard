import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer, isAllowedEmail, demoMode, passHash, PASS_COOKIE, ROLE_COOKIE, dataClient } from "@/lib/supabase/server";
import { ROLES, ROLE_LABEL, ROLE_NOTE, isRole } from "@/lib/rbac";

export const dynamic = "force-dynamic";

async function sendLink(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect("/login?e=email");
  if (!isAllowedEmail(email)) redirect("/login?e=denied");
  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host")}`;
  const sb = await supabaseServer();
  // shouldCreateUser: false keeps the dashboard invite-only (invite people in Supabase > Authentication > Users).
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback` } });
  redirect(error ? `/login?e=send` : `/login?sent=1`);
}

async function enterDemo(formData: FormData) {
  "use server";
  const need = process.env.DEMO_PASSCODE;
  const given = String(formData.get("passcode") ?? "");
  if (need && given !== need) redirect("/login?e=pass");
  const role = String(formData.get("role") ?? "admin");
  const studio = role === "project_manager" ? String(formData.get("studio") ?? "") : "";
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 14 };
  const c = await cookies();
  c.set(PASS_COOKIE, await passHash(need || "open"), opts);
  c.set(ROLE_COOKIE, encodeURIComponent(`${isRole(role) ? role : "admin"}|${studio}`), opts);
  redirect(role === "finance" ? "/#finance" : role === "employee" || role === "hr" ? "/#studios" : "/");
}

const MSG: Record<string, string> = {
  email: "Enter a valid email address.",
  denied: "This email is not on the list for this dashboard. Ask your admin for access.",
  send: "We could not send a link to that address. Check that you have been invited, then try again.",
  link: "That sign-in link has expired or was already used. Request a new one.",
  pass: "That passcode is not right.",
};

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const demo = demoMode();
  let studios: string[] = [];
  if (demo) try {
    const { sb } = await dataClient();
    const { data } = await sb.from("project_lines").select("studio").not("studio", "is", null).limit(3000);
    studios = [...new Set((data ?? []).map((r) => r.studio as string))].sort();
  } catch { /* studio list is optional */ }
  return (
    <main className="wrap login">
      <section className="card">
        <div className="logo">Aedium <span>· MIS</span></div>
        {demo ? (
          <>
            <h1>Aedium MIS. <em>Demo.</em></h1>
            <p>Order book, billing and collections from the master tracker. Pick who you are; each role sees its own screens and actions.</p>
            <form action={enterDemo} className="personas">
              {process.env.DEMO_PASSCODE && <input id="passcode" name="passcode" type="password" required placeholder="Passcode" aria-label="Passcode" />}
              <label htmlFor="studio" className="note">Studio for the project director</label>
              <select id="studio" name="studio" className="field" defaultValue={studios[0] ?? ""}>{studios.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <div className="persona-grid">
                {ROLES.map((r) => (
                  <button key={r} className={`persona${r === "admin" ? " primary" : ""}`} type="submit" name="role" value={r}>
                    <b>{ROLE_LABEL[r]}</b><small>{ROLE_NOTE[r]}</small>
                  </button>
                ))}
              </div>
            </form>
          </>
        ) : (
          <>
            <h1>Sign in. <em>We&apos;ll email you a link.</em></h1>
            <p>Use the work email you were invited with. The link signs you in on this device.</p>
            <form action={sendLink}>
              <input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" aria-label="Work email" />
              <button className="pill pink" type="submit">Email me a sign-in link</button>
            </form>
            {q.sent && <div className="msg">Check your inbox for the sign-in link.</div>}
          </>
        )}
        {q.e && <div className="msg err">{MSG[q.e] ?? "Sign-in failed. Try again."}</div>}
      </section>
    </main>
  );
}

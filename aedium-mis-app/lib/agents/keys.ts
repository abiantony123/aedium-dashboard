// API keys for the MCP server. Keys look like ak_live_<32 random chars>; only a SHA-256 hash is stored.
import { createClient } from "@supabase/supabase-js";
import type { Db } from "../supabase/server";
import type { Scope } from "./tools";

export function serviceDb(): Db {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("The MCP server needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.");
  return createClient(url, key, { db: { schema: "mis" }, auth: { persistSession: false } });
}

export async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createKey(name: string, scope: Scope, createdBy: string, role: string, studio: string | null) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = "ak_live_" + Buffer.from(bytes).toString("base64url");
  const { data, error } = await serviceDb().from("api_keys")
    .insert({ name: name.slice(0, 80), scope, prefix: key.slice(0, 12), key_hash: await sha256(key), created_by: createdBy, role, studio })
    .select("id,name,prefix,scope,created_at").single();
  if (error) throw new Error(error.message);
  return { key, record: data };
}

export type KeyInfo = { id: number; name: string; prefix: string; scope: Scope; role: string; studio: string | null; created_by: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null };

export async function listKeys(): Promise<KeyInfo[]> {
  const { data, error } = await serviceDb().from("api_keys").select("id,name,prefix,scope,role,studio,created_by,created_at,last_used_at,revoked_at").order("id", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as KeyInfo[];
}

export async function revokeKey(id: number) {
  const { error } = await serviceDb().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function verifyKey(key: string): Promise<KeyInfo | null> {
  if (!/^ak_live_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  const db = serviceDb();
  const { data } = await db.from("api_keys").select("id,name,prefix,scope,role,studio,created_by,created_at,last_used_at,revoked_at").eq("key_hash", await sha256(key)).is("revoked_at", null).maybeSingle();
  if (!data) return null;
  // last_used_at is informational; at most one write a minute per key.
  if (!data.last_used_at || Date.now() - Date.parse(data.last_used_at) > 60000)
    await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return data as KeyInfo;
}

export async function logRun(entry: { key_id: number; key_name: string; client: string | null; tool: string; input: unknown; ok: boolean; error?: string; ms: number }) {
  await serviceDb().from("agent_runs").insert({ ...entry, input: entry.input ?? null, error: entry.error ?? null });
}

export async function recentRuns(limit = 20) {
  const { data } = await serviceDb().from("agent_runs").select("key_name,client,tool,ok,error,ms,created_at").order("id", { ascending: false }).limit(limit);
  return data ?? [];
}

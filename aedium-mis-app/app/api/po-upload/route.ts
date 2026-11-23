// Manual PO intake: upload a PO PDF → store it → OCR/extract with Claude → stage it with the usual checks.
// The reviewer then approves, edits or marks it "not a PO" on Agents › PO intake. Nothing reaches the tracker here.
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { dataClient } from "@/lib/supabase/server";
import { can } from "@/lib/rbac";
import { stagePo } from "@/lib/po";
import { registerDocument, linkStaged, scanLog } from "@/lib/inbox";
import { extractPo, toPoInput } from "@/lib/ocr";
import type { Actor } from "@/lib/agents/actions";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const MAX = 20 * 1024 * 1024;

export async function POST(req: Request) {
  const { sb, user } = await dataClient();
  if (!user) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  if (!can(user.role, "po.stage")) return NextResponse.json({ ok: false, message: "Your role cannot add POs." }, { status: 403 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, message: "OCR is not set up: add ANTHROPIC_API_KEY to the server environment (.env.local) and restart. Nothing was uploaded." }, { status: 503 });
  const actor: Actor = { id: user.id, email: user.email, via: "manual PO intake", role: user.role, studio: user.studio };

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, message: "Choose a PDF file." }, { status: 400 });
  if (file.size > MAX) return NextResponse.json({ ok: false, message: "The PDF is larger than 20 MB." }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return NextResponse.json({ ok: false, message: "That file is not a PDF." }, { status: 400 });

  const name = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "po.pdf";
  const sha = createHash("sha256").update(bytes).digest("hex");
  try {
    // Same file uploaded again: point at the existing item instead of staging a second copy.
    // A file that failed extraction earlier (no PO staged, not skipped) is read again instead.
    const { data: seen } = await sb.from("po_inbox").select("id,po_id,status").eq("message_id", sha).maybeSingle();
    if (seen && (seen.po_id || seen.status !== "detected")) return NextResponse.json({ ok: true, inbox_id: seen.id, existed: true, message: "This PDF was already uploaded. Showing the existing item." });

    const path = `upload/${sha.slice(0, 16)}-${name.replace(/\s+/g, "_")}`;
    const up = await sb.storage.from("po-files").upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (up.error) throw new Error(`Storage: ${up.error.message}`);
    const reg = seen ? { id: seen.id as number, existed: true } : await registerDocument(sb, actor, { source: "upload", message_id: sha, subject: `Manual intake · ${name}`, sender: user.email, received_at: new Date().toISOString(), attachment_name: name, attachment_bytes: bytes.length, file_path: path });

    let x: Awaited<ReturnType<typeof extractPo>>;
    try { x = await extractPo(sb, bytes, name); } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = /authentication_error|invalid (bearer|x-api-key)|401/i.test(raw) ? "The Anthropic API key was rejected (invalid key). Fix ANTHROPIC_API_KEY in .env.local, restart, then upload the same PDF again."
        : /credit|billing|quota|429|rate/i.test(raw) ? "The Anthropic account is out of credit or rate-limited. Try again later." : `OCR failed: ${raw.slice(0, 200)}`;
      // The file stays stored and listed; uploading the same PDF again retries the reading.
      await sb.from("po_inbox").update({ skip_reason: `${msg} The file is stored.` }).eq("id", reg.id);
      throw new Error(msg);
    }
    await sb.from("po_inbox").update({ attachment_pages: x.pages }).eq("id", reg.id);
    if (!x.is_po || !x.po) {
      await sb.from("po_inbox").update({ status: "detected", classification: "unknown", skip_reason: `Read by OCR: ${x.not_po_reason ?? "does not look like a purchase order"}. Mark it "Not a PO" or ask an assistant to stage it.` }).eq("id", reg.id);
      await scanLog(sb, actor, { source: "upload", scanned: 1, detected: 1, skipped: 0, ok: true });
      return NextResponse.json({ ok: true, inbox_id: reg.id, is_po: false, message: `This does not look like a PO (${x.not_po_reason ?? "unknown document"}).` });
    }
    const staged = await stagePo(sb, actor, toPoInput(x.po, { confidence: x.confidence, notes: x.notes, fileName: name }));
    const l = await linkStaged(sb, reg.id, staged.po_id, x.fields.map((f) => ({ field: f.field, value: f.value, confidence: Math.max(0, Math.min(1, f.confidence)), source_page: f.source_page ?? undefined, note: f.note ?? undefined })));
    await scanLog(sb, actor, { source: "upload", scanned: 1, detected: 1, skipped: 0, ok: true });
    const failed = staged.checks.filter((c) => !c.ok && c.severity === "error").length;
    return NextResponse.json({
      ok: true, inbox_id: reg.id, po_id: staged.po_id, is_po: true, classification: l.classification, confidence: x.confidence,
      fields: x.fields.length, low: x.fields.filter((f) => f.value && f.confidence < 0.9).length, failed,
      message: `Staged ${staged.po_number}${staged.version > 1 ? ` v${staged.version}` : ""} · ${failed ? `${failed} check(s) failed` : "checks passed"}. Review it before approving.`,
    });
  } catch (e) {
    await scanLog(sb, actor, { source: "upload", scanned: 1, detected: 0, skipped: 0, ok: false, error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Upload failed." }, { status: 500 });
  }
}

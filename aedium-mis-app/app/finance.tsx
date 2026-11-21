"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { inr, niceDate } from "@/lib/format";
import { can, type Role } from "@/lib/rbac";
import type { financeQueue } from "@/lib/finance";
import type { Dash } from "@/lib/data";
import { raiseInvoice, recordPayment } from "./actions";

type Q = Awaited<ReturnType<typeof financeQueue>>;
type Run = (p: Promise<{ ok: boolean; message: string }>) => void;
const daysSince = (at: string | null) => (at ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 86400000)) : 0);

export default function FinanceTab({ queue, open, payments, role, run, pending, zohoSample, onDraft, toast }: { queue: Q; open: Dash["open"]; payments: Dash["payments"]; role: Role; run: Run; pending: boolean; zohoSample: boolean; onDraft: (stageId: number) => void; toast: (m: string) => void }) {
  const router = useRouter();
  const [inv, setInv] = useState<{ id: number; number: string; amount: string } | null>(null);
  const [pay, setPay] = useState<{ number: string; amount: string; tds: string; balance: number } | null>(null);
  const waiting = queue.filter((q) => q.workflow_status === "finance_notified");
  const invoiced = queue.filter((q) => q.workflow_status === "invoiced");
  const waitingValue = waiting.reduce((a, q) => a + (q.fee ?? 0), 0);

  return (
    <>
      <div className="eyebrow">Finance · {waiting.length} to invoice{zohoSample ? " · Zoho Books (mirror)" : ""}</div>
      <h1>Stages ready to bill. <em>Invoice, then collect.</em></h1>
      <div className="a-kpis num">
        <div><div className="big">{waiting.length}</div><div className="biglbl">Waiting for an invoice</div></div>
        <div><div className="big">{inr(waitingValue)}</div><div className="biglbl">Value to invoice</div></div>
        <div><div className="big">{open.length}</div><div className="biglbl">Open invoices</div></div>
        <div><div className="big">{inr(open.reduce((a, i) => a + i.balance, 0))}</div><div className="biglbl">Outstanding</div></div>
      </div>

      <div className="f-grid">
        <section className="card">
          <div className="dhead"><h2>Ready for billing</h2><span className="note">Sent by project directors or the Invoice trigger agent</span></div>
          {waiting.length ? waiting.map((q) => (
            <div className="frow" key={q.id}>
              <div className="t"><b>{q.client_name ?? q.project_number} · {q.studio}</b><small>{q.project_number} · {(q.stage ?? "").slice(0, 80)} · sent {niceDate(q.last_event_at)} by {q.last_event_by ?? "—"}</small></div>
              <div className="f-amt num"><b>{inr(q.fee)}</b><small className={daysSince(q.last_event_at) > 7 ? "t-pink" : ""}>{daysSince(q.last_event_at)} days waiting</small></div>
              <div className="f-acts">
                <button className="pill" onClick={() => onDraft(q.id)}>Request</button>
                {can(role, "finance.invoice") && <button className="pill solid" disabled={pending} onClick={() => setInv({ id: q.id, number: "", amount: String(Math.round(q.fee ?? 0)) })}>Raise invoice</button>}
              </div>
            </div>
          )) : <div className="empty">Nothing is waiting for an invoice.</div>}
          {invoiced.length > 0 && <>
            <h2 className="f-sub">Invoiced from the app</h2>
            {invoiced.slice(0, 8).map((q) => <div className="krow" key={q.id}><div className="t"><b>{q.invoice_number} · {q.client_name ?? q.project_number}</b><small>{(q.stage ?? "").slice(0, 70)} · {niceDate(q.last_event_at)}</small></div><span className="tag t-green">{inr(q.fee)}</span></div>)}
          </>}
        </section>
        <section className="card">
          <div className="dhead"><h2>Open invoices</h2><span className="note">Record payments as they arrive</span></div>
          {open.length ? [...open].sort((a, b) => b.days_overdue - a.days_overdue).map((i) => (
            <div className="frow" key={i.invoice_id}>
              <div className="t"><b>{i.invoice_number} · {i.project_name ?? i.customer_name}</b><small>Due {niceDate(i.due_date)} · {i.days_overdue ? `${i.days_overdue} days overdue` : "not due yet"}</small></div>
              <div className="f-amt num"><b>{inr(i.balance)}</b><small>of {inr(i.total)}</small></div>
              {can(role, "finance.payment") && <div className="f-acts"><button className="pill" disabled={pending} onClick={() => setPay({ number: i.invoice_number, amount: String(Math.round(i.balance * 0.9)), tds: String(Math.round(i.balance * 0.1)), balance: i.balance })}>Record payment</button></div>}
            </div>
          )) : <div className="empty">No open invoices.</div>}
        </section>
      </div>

      <section className="card f-mirror">
        <div className="dhead">
          <div>
            <h2>Zoho Books mirror · Collections &amp; sync</h2>
            <span className="note">Aedium Design · Zoho Books India Mirror · 30-day terms · {open.length} open invoice{open.length === 1 ? "" : "s"} · {payments.length} recorded payment{payments.length === 1 ? "" : "s"}</span>
          </div>
          <div className="f-acts">
            <span className={`tag ${zohoSample ? "t-amber" : "t-green"}`}>{zohoSample ? "Mock mirror active" : "Live sync"}</span>
            <button className="pill" onClick={() => { router.refresh(); toast("Zoho Books mirror synced"); }}>Sync Zoho mirror</button>
          </div>
        </div>
        {payments.length ? payments.slice(0, 12).map((p) => (
          <div className="frow" key={p.payment_id}>
            <div className="t"><b>{p.payment_number ?? p.payment_id} · {p.project ?? p.invoice_number ?? "Receipt"}</b><small>{niceDate(p.date)}{p.invoice_number ? ` · matched to ${p.invoice_number}` : ""}</small></div>
            <div className="f-amt num"><b>{inr(p.amount)}</b><small>{p.tax_amount_withheld ? `${inr(p.tax_amount_withheld)} TDS withheld` : "No TDS"}</small></div>
            <span className="tag t-green">Matched</span>
          </div>
        )) : <div className="empty">No collections recorded yet in this view.</div>}
      </section>

      {inv && (
        <div className="f-modal" role="dialog" aria-modal="true" aria-labelledby="inv-t" onClick={(e) => { if (e.target === e.currentTarget) setInv(null); }}>
          <form className="sheet card" onSubmit={(e) => { e.preventDefault(); run(raiseInvoice({ stage_id: inv.id, invoice_number: inv.number || undefined, amount: Number(inv.amount) || undefined })); setInv(null); }}>
            <h2 id="inv-t">Raise invoice</h2>
            <p className="note">Recorded in Zoho Books{zohoSample ? " (mirror)" : ""}; the stage moves to invoiced.</p>
            <label htmlFor="inv-n">Invoice number</label><input id="inv-n" className="field" placeholder="Leave blank for the next number" value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} />
            <label htmlFor="inv-a">Amount, excl. GST (₹)</label><input id="inv-a" className="field" inputMode="decimal" value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value.replace(/[^\d.]/g, "") })} />
            <div className="row"><button type="button" className="pill" onClick={() => setInv(null)}>Cancel</button><button className="pill pink" disabled={pending}>Raise invoice</button></div>
          </form>
        </div>
      )}
      {pay && (
        <div className="f-modal" role="dialog" aria-modal="true" aria-labelledby="pay-t" onClick={(e) => { if (e.target === e.currentTarget) setPay(null); }}>
          <form className="sheet card" onSubmit={(e) => { e.preventDefault(); run(recordPayment({ invoice_number: pay.number, amount: Number(pay.amount), tds: Number(pay.tds) || 0 })); setPay(null); }}>
            <h2 id="pay-t">Record payment · {pay.number}</h2>
            <p className="note">Balance {inr(pay.balance)}. Amount received plus TDS is applied to the invoice.</p>
            <label htmlFor="pay-a">Amount received (₹)</label><input id="pay-a" className="field" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value.replace(/[^\d.]/g, "") })} />
            <label htmlFor="pay-t2">TDS withheld (₹)</label><input id="pay-t2" className="field" inputMode="decimal" value={pay.tds} onChange={(e) => setPay({ ...pay, tds: e.target.value.replace(/[^\d.]/g, "") })} />
            <div className="row"><button type="button" className="pill" onClick={() => setPay(null)}>Cancel</button><button className="pill pink" disabled={pending}>Record payment</button></div>
          </form>
        </div>
      )}
    </>
  );
}

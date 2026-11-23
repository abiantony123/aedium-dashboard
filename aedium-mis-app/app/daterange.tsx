"use client";
// Page-level date range: one control, top right of Brief, Cash and Leakage. Presets on the left, a two-month
// calendar on the right (click a start day, then an end day), Apply to commit. The range lives in the URL (?from&to).
import { useEffect, useRef, useState } from "react";
import { MONTHS } from "@/lib/format";
import { addDays, addMonths, monthEnd, monthStart, presetLabel, presets, rangeLabel, type Range } from "@/lib/period";

const WD = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const dowMon = (s: string) => (new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7;

function Month({ ym, sel, hover, today, onPick, onHover }: { ym: string; sel: { a: string | null; b: string | null }; hover: string | null; today: string; onPick: (d: string) => void; onHover: (d: string | null) => void }) {
  const first = monthStart(ym), last = monthEnd(ym);
  const cells: (string | null)[] = Array(dowMon(first)).fill(null);
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(d);
  // Preview the range while choosing the end day.
  const a = sel.a, b = sel.b ?? (sel.a && hover ? hover : null);
  const lo = a && b ? (a < b ? a : b) : a, hi = a && b ? (a < b ? b : a) : a;
  return (
    <div className="drp-month">
      <div className="drp-mname">{MONTHS[Number(ym.slice(5, 7)) - 1]} {ym.slice(0, 4)}</div>
      <div className="drp-grid" role="grid" onMouseLeave={() => onHover(null)}>
        {WD.map((w) => <span key={w} className="drp-wd">{w}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const inR = lo && hi && d >= lo && d <= hi;
          const cls = ["drp-day", inR ? "in" : "", d === lo ? "lo" : "", d === hi ? "hi" : "", d === today ? "today" : "", d > today ? "future" : ""].filter(Boolean).join(" ");
          return <button key={d} type="button" className={cls} aria-pressed={!!inR} aria-label={d} onClick={() => onPick(d)} onMouseEnter={() => onHover(d)}>{Number(d.slice(8))}</button>;
        })}
      </div>
    </div>
  );
}

export default function DateRange({ value, onChange, today, defaultLabel, defaultName, defaultHint, hideAll, busy }: {
  value: Range | null; onChange: (r: Range | null) => void; today: string;
  defaultLabel: string; defaultName?: string; defaultHint?: string; hideAll?: boolean; busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<{ a: string | null; b: string | null }>({ a: value?.from ?? null, b: value?.to ?? null });
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState(() => addMonths(value?.to ?? today, -1));   // left month of the pair
  const wrap = useRef<HTMLDivElement>(null);
  const ps = presets(today).filter((p) => !(hideAll && p.id === "all"));

  const openPop = () => {
    setSel({ a: value?.from ?? null, b: value?.to ?? null });
    setView(addMonths(value?.to ?? today, -1));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  const pick = (d: string) => {
    if (!sel.a || sel.b) setSel({ a: d, b: null });
    else setSel(d < sel.a ? { a: d, b: sel.a } : { a: sel.a, b: d });
  };
  const commit = (r: Range | null) => { setOpen(false); onChange(r); };
  const draft: Range | null = sel.a && sel.b ? { from: sel.a, to: sel.b } : null;
  const isPreset = (r: Range) => !!draft && draft.from === r.from && draft.to === r.to;
  const label = value ? presetLabel(value, today) : defaultLabel;

  return (
    <div className={`drp${open ? " open" : ""}`} ref={wrap}>
      <button type="button" className="drp-btn" data-on={value ? "" : undefined} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? setOpen(false) : openPop())} title="Date range">
        <svg className="drp-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
        <span className="drp-lbl"><small>{value ? "Period" : "Showing"}</small><b>{label}</b></span>
        {busy ? <i className="drp-spin" aria-hidden="true" /> : <svg className="drp-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" /></svg>}
      </button>
      {value && <button type="button" className="drp-x" aria-label="Clear date range" title="Clear date range" onClick={() => commit(null)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" /></svg></button>}
      {open && (
        <div className="drp-pop" role="dialog" aria-label="Choose a date range">
          <div className="drp-presets">
            <button type="button" className={!value && !draft ? "on" : ""} onClick={() => commit(null)}>
              <span>{defaultName ?? defaultLabel}</span>{defaultHint && <small>{defaultHint}</small>}
            </button>
            {ps.map((p) => (
              <button key={p.id} type="button" className={isPreset(p.range) ? "on" : ""} onClick={() => { setSel({ a: p.range.from, b: p.range.to }); setView(addMonths(p.range.to, -1)); }} onDoubleClick={() => commit(p.range)}>
                <span>{p.label}</span><small>{p.id === "all" ? "Everything recorded" : rangeLabel(p.range)}</small>
              </button>
            ))}
          </div>
          <div className="drp-cal">
            <div className="drp-nav">
              <button type="button" aria-label="Previous month" onClick={() => setView(addMonths(view, -1))}><svg viewBox="0 0 12 12"><path d="M7.5 3 4.5 6l3 3" /></svg></button>
              <button type="button" aria-label="Next month" onClick={() => setView(addMonths(view, 1))}><svg viewBox="0 0 12 12"><path d="M4.5 3l3 3-3 3" /></svg></button>
            </div>
            <div className="drp-months">
              <Month ym={view} sel={sel} hover={hover} today={today} onPick={pick} onHover={setHover} />
              <Month ym={addMonths(view, 1)} sel={sel} hover={hover} today={today} onPick={pick} onHover={setHover} />
            </div>
            <div className="drp-foot">
              <div className="drp-inputs">
                <label><small>From</small><input type="date" value={sel.a ?? ""} max={sel.b ?? undefined} onChange={(e) => { const v = e.target.value; if (v) { setSel({ a: v, b: sel.b && sel.b >= v ? sel.b : null }); setView(addMonths(v, 0)); } }} /></label>
                <span className="drp-dash">–</span>
                <label><small>To</small><input type="date" value={sel.b ?? ""} min={sel.a ?? undefined} onChange={(e) => { const v = e.target.value; if (v && sel.a) setSel({ a: sel.a, b: v < sel.a ? sel.a : v }); }} /></label>
              </div>
              <div className="drp-acts">
                <span className="drp-hint">{draft ? rangeLabel(draft) : sel.a ? "Now pick an end day" : "Pick a start day"}</span>
                <button type="button" className="drp-cancel" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="drp-apply" disabled={!draft} onClick={() => draft && commit(draft)}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

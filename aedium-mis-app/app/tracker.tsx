"use client";
import { useEffect, useMemo, useState } from "react";
import { inr, niceDate } from "@/lib/format";

type Col = { key: string; label: string; kind: "text" | "money" | "pct" | "date" | "num" };
type Row = Record<string, unknown>;
type Sheet = "summary" | "stages";
const SHOWN = 250;

const cell = (v: unknown, k: Col["kind"]) => {
  if (v == null || v === "") return "";
  if (k === "money") return inr(Number(v));
  if (k === "pct") return `${(Number(v) * 100).toFixed(Number(v) * 100 % 1 ? 1 : 0)}%`;
  if (k === "date") return niceDate(String(v));
  return String(v).trim();
};

// The master tracker as a familiar sheet: search, sort by any column, switch between its two sheets, export to Excel.
export default function TrackerTab({ studio, client, project, active }: { studio: string | null; client: string | null; project?: string | null; active: boolean }) {
  const [sheet, setSheet] = useState<Sheet>("summary");
  const [data, setData] = useState<{ columns: Col[]; rows: Row[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!active) return;   // loaded the first time the tab is opened, and again when the sheet or filters change
    let live = true;
    const qs = new URLSearchParams({ sheet }); if (studio) qs.set("studio", studio); if (client) qs.set("client", client); if (project) qs.set("project", project);
    setData(null); setError(null); setSort(null); setAll(false);
    fetch(`/api/tracker?${qs}`).then((r) => r.json()).then((j) => { if (!live) return; if (j.error) setError(j.error); else setData(j); }).catch(() => live && setError("Could not load the tracker."));
    return () => { live = false; };
  }, [active, sheet, studio, client, project]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    let r = needle ? data.rows.filter((x) => data.columns.some((c) => cell(x[c.key], c.kind).toLowerCase().includes(needle))) : data.rows;
    if (sort) {
      const col = data.columns.find((c) => c.key === sort.key)!;
      const num = col.kind === "money" || col.kind === "pct" || col.kind === "num";
      r = [...r].sort((a, b) => {
        const x = a[sort.key], y = b[sort.key];
        if (x == null) return 1; if (y == null) return -1;   // blanks last, whichever direction
        return (num ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * sort.dir;
      });
    }
    return r;
  }, [data, q, sort]);

  const exQs = new URLSearchParams(); if (studio) exQs.set("studio", studio); if (client) exQs.set("client", client); if (project) exQs.set("project", project);
  const exportUrl = `/api/export${exQs.size ? `?${exQs}` : ""}`;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <>
      <div className="eyebrow">Tracker · master workbook{studio ? ` · ${studio}` : ""}{client ? ` · ${client}` : ""}{project ? ` · ${project}` : ""}</div>
      <div className="b-head">
        <h1>The tracker you know, <em>live.</em></h1>
        <div className="acts"><a className="pill" href={exportUrl}>Export .xlsx</a></div>
      </div>
      <section className="card t-sheet">
        <div className="t-bar">
          <div className="seg sm" role="group" aria-label="Sheet">
            <button aria-pressed={sheet === "summary"} onClick={() => setSheet("summary")}>Summary</button>
            <button aria-pressed={sheet === "stages"} onClick={() => setSheet("stages")}>Billing Stages</button>
          </div>
          <input className="field" type="search" aria-label="Search the sheet" placeholder="Search any column…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="note">{data ? `${rows.length.toLocaleString("en-IN")} of ${data.rows.length.toLocaleString("en-IN")} rows` : "Loading…"}</span>
        </div>
        {error && <div className="banner">{error}</div>}
        {data && (
          <div className="t-scroll" tabIndex={0} aria-label={`${sheet === "summary" ? "Summary" : "Billing Stages"} sheet`}>
            <table>
              <thead><tr>
                <th className="rn">#</th>
                {data.columns.map((c) => (
                  <th key={c.key} className={c.kind === "money" || c.kind === "pct" || c.kind === "num" ? "r" : undefined} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button onClick={() => setSort(sort?.key === c.key ? (sort.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button>
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    <td className="rn">{i + 1}</td>
                    {data.columns.map((c) => <td key={c.key} className={c.kind === "money" || c.kind === "pct" || c.kind === "num" ? "r num" : undefined} title={String(r[c.key] ?? "")}>{cell(r[c.key], c.kind)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && rows.length > shown.length && <button className="pill" onClick={() => setAll(true)}>Show all {rows.length.toLocaleString("en-IN")} rows</button>}
        {data && rows.length === 0 && <p className="note">No rows match.</p>}
      </section>
    </>
  );
}

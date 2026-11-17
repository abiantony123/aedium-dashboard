"use client";
import { useState } from "react";
import { timeOf, niceDate } from "@/lib/format";
import { readNotifications } from "./actions";

type Note = { id: number; title: string; body: string | null; tab: string | null; created_at: string; read_at: string | null };

// In-app notifications per role (email notifications come with the Outlook connection).
export default function Bell({ notes }: { notes: Note[] }) {
  const [open, setOpen] = useState(false);
  const unread = notes.filter((n) => !n.read_at);
  return (
    <div className="bell">
      <button className="icon" aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`} aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open && unread.length) void readNotifications(unread.map((n) => n.id)); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {unread.length > 0 && <i className="badge" />}
      </button>
      {open && (
        <div className="bell-pop card" role="menu">
          <h2>Notifications</h2>
          {notes.length ? notes.map((n) => (
            <a key={n.id} role="menuitem" className={`bell-item${n.read_at ? "" : " new"}`} href={`#${n.tab ?? "brief"}`} onClick={() => setOpen(false)}>
              <b>{n.title}</b>{n.body && <small>{n.body}</small>}<span>{niceDate(n.created_at)} {timeOf(n.created_at)}</span>
            </a>
          )) : <div className="empty">Nothing new.</div>}
        </div>
      )}
    </div>
  );
}

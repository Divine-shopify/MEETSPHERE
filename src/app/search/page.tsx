"use client";

import Link from "next/link";
import { useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, Spinner, useAction } from "@/components/ui";
import { api } from "@/lib/client";

/** Highlights come back as <b>…</b> from Postgres; render them without trusting other HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<b>.*?<\/b>)/g);
  return <>{parts.map((p, i) => (p.startsWith("<b>") ? <mark key={i}>{p.slice(3, -4)}</mark> : <span key={i}>{p}</span>))}</>;
}

export default function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const { busy, error, run } = useAction();
  return (
    <main className="container stack">
      <AppHeader />
      <h1>Search meetings</h1>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api(`/api/search?q=${encodeURIComponent(q)}`));
          if (r) setResults(r.results);
        }}
      >
        <input aria-label="Search" placeholder="Search transcripts, notes, decisions…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" disabled={busy || q.trim().length < 2}>{busy ? <Spinner /> : "Search"}</button>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {results && (results.length === 0 ? <p className="muted">No matches.</p> : (
        <ul className="list card">
          {results.map((r, i) => (
            <li key={i} className="stack" style={{ gap: 4 }}>
              <div><Link href={`/m/${r.code}/manage`}><strong>{r.title}</strong></Link> <span className="badge">{r.kind}</span> <span className="small muted">{new Date(r.at).toLocaleString()}</span></div>
              <div className="small"><Snippet text={r.snippet} /></div>
            </li>
          ))}
        </ul>
      ))}
      <p className="small muted">Searches meetings you host and, for organization admins, your organization's meetings.</p>
    </main>
  );
}

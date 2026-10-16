"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert, formatBytes, formatDuration, Spinner, useApi } from "@/components/ui";

/** Recordings, stream replays, transcript and notes for people allowed to see them. */
export default function Replay() {
  const { code } = useParams<{ code: string }>();
  const artifacts = useApi<any>(`/api/meetings/${code}/artifacts`);
  const transcript = useApi<any>(`/api/meetings/${code}/transcript`);
  const notes = useApi<any>(`/api/meetings/${code}/notes`);
  const [playing, setPlaying] = useState<any>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!playing || !video.current) return;
    const el = video.current;
    if (playing.type === "recording") {
      el.src = `/api/meetings/${code}/artifacts/${playing.id}`;
      return;
    }
    let hls: any;
    (async () => {
      const src = `/api/meetings/${code}/stream/${playing.id}/index.m3u8`;
      const Hls = (await import("hls.js")).default;
      if (Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(el);
      } else el.src = src;
    })();
    return () => hls?.destroy();
  }, [playing, code]);

  if (artifacts.error?.status === 403) {
    return (
      <main className="container">
        <div className="card stack">
          <h1>No access</h1>
          <p>The host hasn't shared recordings of this meeting with you.</p>
          <Link href={`/m/${code}`}>Back to the meeting</Link>
        </div>
      </main>
    );
  }
  const n = notes.data?.notes;
  return (
    <main className="container wide stack">
      <header className="row spread">
        <Link href={`/m/${code}`}>← Meeting</Link>
      </header>
      <h1>Recordings and notes</h1>
      <section className="card stack">
        <h2>Recordings</h2>
        {artifacts.loading && !artifacts.data ? (
          <Spinner />
        ) : !artifacts.data?.artifacts.length ? (
          <p className="muted">No recordings.</p>
        ) : (
          <ul className="list">
            {artifacts.data.artifacts.map((a: any) => (
              <li key={a.id} className="row spread">
                <span>
                  {a.type === "recording" ? "Recording" : "Live stream replay"} · {new Date(a.createdAt).toLocaleString()} · {formatDuration(a.durationMs)} · {formatBytes(a.sizeBytes)}
                  {a.status !== "ready" && <span className="badge">{a.status === "failed" ? `Failed: ${a.error ?? ""}` : "Processing…"}</span>}
                </span>
                {a.status === "ready" && (
                  <span className="row">
                    <button className="small" onClick={() => setPlaying(a)}>Play</button>
                    {a.type === "recording" && <a className="btn small" href={`/api/meetings/${code}/artifacts/${a.id}?download=1`}>Download</a>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {playing && <video ref={video} controls playsInline style={{ width: "100%", background: "#000", borderRadius: 12 }} />}
      </section>
      {n && (n.summary || n.host_notes) && (
        <section className="card stack">
          <h2>Notes</h2>
          {n.summary && (
            <>
              <h3>Summary</h3>
              <p>{n.summary}</p>
              {n.decisions.length > 0 && (<><h3>Decisions</h3><ul>{n.decisions.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></>)}
              {n.action_items.length > 0 && (
                <><h3>Action items</h3><ul>{n.action_items.map((a: any, i: number) => <li key={i}>{a.task}{a.owner ? ` — ${a.owner}` : ""}{a.due ? ` (due ${a.due})` : ""}</li>)}</ul></>
              )}
              <p className="small muted">AI-generated from the consented transcript and notes. Check before relying on it.</p>
            </>
          )}
          {n.host_notes && (<><h3>Host notes</h3><p style={{ whiteSpace: "pre-wrap" }}>{n.host_notes}</p></>)}
        </section>
      )}
      {transcript.data?.segments?.length > 0 && (
        <section className="card stack">
          <div className="row spread">
            <h2>Transcript</h2>
            <span className="row">
              <a className="btn small" href={`/api/meetings/${code}/transcript?format=txt`}>Text</a>
              <a className="btn small" href={`/api/meetings/${code}/transcript?format=vtt`}>Subtitles (.vtt)</a>
            </span>
          </div>
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            {transcript.data.segments.map((s: any, i: number) => (
              <p key={i} className="small"><span className="muted">{new Date(s.spoken_at).toLocaleTimeString()}</span> <strong>{s.speaker_name}:</strong> {s.text}</p>
            ))}
          </div>
        </section>
      )}
      {artifacts.error && artifacts.error.status !== 403 && <Alert kind="error">{artifacts.error.message}</Alert>}
    </main>
  );
}

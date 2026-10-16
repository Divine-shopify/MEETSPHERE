"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CopyLink } from "@/components/CopyLink";
import { api, ApiError } from "@/lib/client";

const POLICIES = [
  ["host_approval", "Everyone waits for my approval"],
  ["invited_only", "Invited attendees only"],
  ["verified_only", "Anyone with a verified phone/email"],
  ["anyone_with_link", "Anyone with the link"],
] as const;

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<any>(null);
  const [meetings, setMeetings] = useState<any[] | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState("interactive");
  const [policy, setPolicy] = useState("host_approval");
  const [nameOnly, setNameOnly] = useState(true);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/api/meetings");
      setMeetings(r.meetings);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace("/signin?next=/dashboard");
    }
  }, [router]);

  useEffect(() => {
    api("/api/me").then((m) => {
      if (!m.user) router.replace("/signin?next=/dashboard");
      else {
        setMe(m);
        load();
      }
    });
  }, [router, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api("/api/meetings", {
        body: {
          title,
          mode,
          accessPolicy: policy,
          allowNameOnlyRequests: nameOnly,
          scheduledAt: when ? new Date(when).toISOString() : null,
        },
      });
      setCreated(r.meeting);
      setTitle("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api("/api/auth/signout", { body: {} });
    router.replace("/");
  }

  if (!me) return <main className="container"><span className="spinner" aria-label="Loading" /></main>;

  return (
    <main className="container stack">
      <header className="row spread">
        <Link href="/"><strong>MeetSphere</strong></Link>
        <div className="row">
          <span className="small muted">{me.user.displayName}</span>
          <button className="small" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {!me.services.media && (
        <div className="alert error" role="alert">
          Audio/video is not configured on this server (LIVEKIT_* variables missing). You can create meetings and manage admission, but the
          room will not connect until media is configured.
        </div>
      )}

      {created && (
        <section className="card stack" aria-live="polite">
          <h2>Meeting created: {created.title}</h2>
          <CopyLink code={created.code} title={created.title} />
          <div className="row">
            <Link className="btn primary" href={`/m/${created.code}`}>Start meeting</Link>
            <Link className="btn" href={`/m/${created.code}/manage`}>Invite list & settings</Link>
          </div>
        </section>
      )}

      <section className="card">
        <form onSubmit={create} className="stack">
          <h2>New meeting</h2>
          <div>
            <label htmlFor="title">Title</label>
            <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Sunday service, Grade 7 maths, Team sync…" />
          </div>
          <div>
            <label htmlFor="policy">Who can get in</label>
            <select id="policy" value={policy} onChange={(e) => setPolicy(e.target.value)}>
              {POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {policy !== "anyone_with_link" && (
            <label className="check">
              <input type="checkbox" checked={nameOnly} onChange={(e) => setNameOnly(e.target.checked)} />
              <span>Let people without a verified phone/email ask to join by name (you review each one)</span>
            </label>
          )}
          <div>
            <label htmlFor="mode">Type</label>
            <select id="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="interactive">Interactive meeting (everyone can talk and share video)</option>
              <option value="broadcast">Presentation (preview): only you and promoted speakers publish</option>
            </select>
            {mode === "broadcast" && (
              <p className="small muted">
                Preview: audience members watch and listen and can raise a hand. It runs on the same media server as interactive meetings and is
                capped by your plan's participant limit. It is not yet a large-audience broadcast.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="when">Scheduled time (optional)</label>
            <input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          {error && <div className="alert error" role="alert">{error}</div>}
          <button className="primary" type="submit" disabled={busy || !title.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : null} Create meeting
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Your meetings</h2>
        {meetings === null ? (
          <span className="spinner" aria-label="Loading" />
        ) : meetings.length === 0 ? (
          <p className="muted">No meetings yet.</p>
        ) : (
          <ul className="list">
            {meetings.map((m) => (
              <li key={m.code} className="row spread">
                <div>
                  <div><strong>{m.title}</strong> {m.locked && <span className="badge">Locked</span>} {m.ended && <span className="badge">Ended</span>}</div>
                  <div className="small muted">
                    <span className="code">{m.code}</span> · {m.accessPolicyLabel}
                    {m.scheduledAt ? ` · ${new Date(m.scheduledAt).toLocaleString()}` : ""}
                  </div>
                </div>
                <div className="row">
                  {!m.ended && <Link className="btn small primary" href={`/m/${m.code}`}>Open</Link>}
                  <Link className="btn small" href={`/m/${m.code}/manage`}>Manage</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

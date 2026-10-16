"use client";

import type { Participant } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { Badges } from "./Badges";
import { api } from "@/lib/client";

interface Req {
  id: string;
  name: string;
  status: string;
  method: string;
  maskedContact: string | null;
  matchState: string;
  invitedAs: string | null;
  badges: string[];
  role: string | null;
  identity: string;
  connected: boolean;
}

/** Waiting room + participant moderation. All actions are enforced server-side. */
export function HostPanel({ code, participants }: { code: string; participants: Participant[] }) {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [meeting, setMeeting] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/meetings/${code}/requests`);
      setReqs(r.requests);
      setMeeting(r.meeting);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [code]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function act(path: string, body: unknown = {}, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(path);
    setError(null);
    try {
      await api(`/api/meetings/${code}${path}`, { body });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const hands = new Map(participants.map((p) => [p.identity, p.attributes?.hand]));
  const pending = reqs.filter((r) => r.status === "pending");
  const admitted = reqs.filter((r) => r.status === "admitted");
  const removed = reqs.filter((r) => r.status === "removed" || r.status === "blocked" || r.status === "rejected");
  const invitedPending = pending.filter((r) => r.matchState === "verified_contact_match").length;

  return (
    <div className="stack">
      {error && <div className="alert error" role="alert">{error}</div>}
      {meeting && (
        <div className="row">
          <button
            className="small"
            aria-pressed={meeting.locked}
            onClick={() => act("/lock", { locked: !meeting.locked })}
            disabled={busy !== null}
          >
            🔒 {meeting.locked ? "Unlock" : "Lock meeting"}
          </button>
          <button className="small" onClick={() => act("/mute-all")} disabled={busy !== null}>Mute everyone</button>
          <a className="btn small" href={`/m/${code}/manage`} target="_blank" rel="noopener">Settings & invites ↗</a>
        </div>
      )}
      {meeting?.locked && <p className="small muted">Locked: no new join requests. People already admitted can reconnect.</p>}

      <section>
        <h3>Waiting ({pending.length})</h3>
        {pending.length === 0 ? (
          <p className="small muted">No one is waiting.</p>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="small" onClick={() => act("/requests/approve-all", { filter: "all" })} disabled={busy !== null}>Admit all</button>
              {invitedPending > 0 && (
                <button className="small" onClick={() => act("/requests/approve-all", { filter: "invited" })} disabled={busy !== null}>
                  Admit verified invitees ({invitedPending})
                </button>
              )}
            </div>
            <ul className="list">
              {pending.map((r) => (
                <li key={r.id} className="stack" style={{ gap: 6 }}>
                  <div><strong>{r.name}</strong> {r.maskedContact && <span className="small muted">{r.maskedContact}</span>}</div>
                  <Badges badges={r.badges} />
                  {r.matchState === "weak_name_match" && (
                    <div className="small" style={{ color: "#f2b84b" }}>Name looks like invitee “{r.invitedAs}”, but it isn't verified.</div>
                  )}
                  {r.matchState === "verified_contact_match" && r.invitedAs && <div className="small muted">On your list as “{r.invitedAs}”.</div>}
                  <div className="row">
                    <button className="small primary" onClick={() => act(`/requests/${r.id}/approve`)} disabled={busy !== null}>Admit</button>
                    <button className="small" onClick={() => act(`/requests/${r.id}/reject`)} disabled={busy !== null}>Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h3>In the meeting ({admitted.length})</h3>
        <ul className="list">
          {admitted.map((r) => (
            <li key={r.id} className="stack" style={{ gap: 6 }}>
              <div className="row spread">
                <span>
                  {hands.get(r.identity) ? "✋ " : ""}
                  <strong>{r.name}</strong> {r.role && r.role !== "participant" && <span className="badge">{r.role}</span>}
                </span>
                <span className="small muted">{r.connected ? "online" : "not connected"}</span>
              </div>
              <Badges badges={r.badges} />
              <div className="row">
                {r.connected && (
                  <button className="small" onClick={() => act(`/requests/${r.id}/mute`)} disabled={busy !== null}>Mute</button>
                )}
                {meeting?.mode === "broadcast" && (
                  <button
                    className="small"
                    onClick={() => act(`/requests/${r.id}/role`, { role: r.role === "speaker" ? "audience" : "speaker" })}
                    disabled={busy !== null}
                  >
                    {r.role === "speaker" ? "Move to audience" : "Invite to speak"}
                  </button>
                )}
                <button className="small danger" onClick={() => act(`/requests/${r.id}/remove`, {}, `Remove ${r.name}? They'll need your approval to come back.`)} disabled={busy !== null}>
                  Remove
                </button>
                <button
                  className="small danger"
                  onClick={() => act(`/requests/${r.id}/block`, {}, `Remove and block ${r.name}? They won't be able to rejoin from this device or verified contact.`)}
                  disabled={busy !== null}
                >
                  Block
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {removed.length > 0 && (
        <section>
          <h3>Declined or removed ({removed.length})</h3>
          <ul className="list">
            {removed.map((r) => (
              <li key={r.id} className="row spread">
                <span>{r.name} <span className="badge">{r.status}</span></span>
                {r.status === "blocked" ? (
                  <button className="small" onClick={() => act(`/requests/${r.id}/unblock`)} disabled={busy !== null}>Unblock</button>
                ) : (
                  <button className="small" onClick={() => act(`/requests/${r.id}/approve`)} disabled={busy !== null}>Let back in</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

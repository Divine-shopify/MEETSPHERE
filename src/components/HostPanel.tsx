"use client";

import type { Participant } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { Badges } from "./Badges";
import { api } from "@/lib/client";
import { Alert } from "./ui";

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
  room: string | null;
}

/** Waiting room + participant moderation + meeting-wide controls. All actions are enforced server-side. */
export function HostPanel({
  code,
  participants,
  version,
  isHost,
  safetyAlert,
  onPeople,
}: {
  code: string;
  participants: Participant[];
  version: number;
  isHost: boolean;
  safetyAlert: string | null;
  onPeople?: (people: Array<{ id: string; name: string }>) => void;
}) {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [meeting, setMeeting] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dial, setDial] = useState({ number: "", name: "" });

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/meetings/${code}/requests`);
      setReqs(r.requests);
      setMeeting(r.meeting);
      onPeople?.(r.requests.filter((x: Req) => x.status === "admitted" && !x.identity.startsWith("sip")).map((x: Req) => ({ id: x.id, name: x.name })));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [code, onPeople]);

  useEffect(() => {
    load();
  }, [load, version]);

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
  const admitted = reqs.filter((r) => r.status === "admitted").sort((a, b) => Number(hands.get(b.identity) || 0) - Number(hands.get(a.identity) || 0));
  const removed = reqs.filter((r) => r.status === "removed" || r.status === "blocked" || r.status === "rejected");
  const invitedPending = pending.filter((r) => r.matchState === "verified_contact_match").length;
  const verifiedPending = pending.filter((r) => r.badges.includes("contact_verified")).length;
  const recording = meeting?.recordingState && meeting.recordingState !== "off";
  const streaming = meeting?.streamState && meeting.streamState !== "off";
  const disabled = busy !== null;

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {safetyAlert && (
        <div className="alert error" role="alert">
          <strong>Safety:</strong> {safetyAlert}{" "}
          {!meeting?.locked && <button className="small danger" onClick={() => act("/lock", { locked: true })}>Lock now</button>}
        </div>
      )}
      {meeting && (
        <div className="row">
          <button className="small" aria-pressed={meeting.locked} onClick={() => act("/lock", { locked: !meeting.locked })} disabled={disabled}>
            🔒 {meeting.locked ? "Unlock" : "Lock"}
          </button>
          <button className="small" onClick={() => act("/mute-all")} disabled={disabled}>Mute all</button>
          <button className="small" aria-pressed={!!recording} onClick={() => act("/recording", { action: recording ? "stop" : "start" })} disabled={disabled}>
            {recording ? "⏹ Stop recording" : "⏺ Record"}
          </button>
          <button className="small" aria-pressed={meeting.transcriptionActive} onClick={() => act("/transcription", { on: !meeting.transcriptionActive })} disabled={disabled || !meeting.captionsEnabled}>
            CC {meeting.transcriptionActive ? "off" : "on"}
          </button>
          {meeting.mode === "broadcast" && (
            <button className="small" aria-pressed={!!streaming} onClick={() => act("/stream-control", { action: streaming ? "stop" : "start" })} disabled={disabled}>
              {streaming ? "Stop live stream" : "Go live (large audience)"}
            </button>
          )}
          <a className="btn small" href={`/m/${code}/manage`} target="_blank" rel="noopener">Settings ↗</a>
        </div>
      )}
      {meeting?.locked && <p className="small muted">Locked: no new join requests. Admitted people can reconnect.</p>}

      <section>
        <h3>Waiting ({pending.length})</h3>
        {pending.length === 0 ? (
          <p className="small muted">No one is waiting.</p>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="small" onClick={() => act("/requests/approve-all", { filter: "all" })} disabled={disabled}>Admit all</button>
              {verifiedPending > 0 && <button className="small" onClick={() => act("/requests/approve-all", { filter: "verified" })} disabled={disabled}>Admit verified ({verifiedPending})</button>}
              {invitedPending > 0 && <button className="small" onClick={() => act("/requests/approve-all", { filter: "invited" })} disabled={disabled}>Admit invitees ({invitedPending})</button>}
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
                    <button className="small primary" onClick={() => act(`/requests/${r.id}/approve`)} disabled={disabled}>Admit</button>
                    <button className="small" onClick={() => act(`/requests/${r.id}/reject`)} disabled={disabled}>Reject</button>
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
                <span className="small muted">{r.connected ? (r.room?.includes("~") ? "in breakout" : "online") : "not connected"}</span>
              </div>
              <Badges badges={r.badges} />
              <div className="row">
                {r.connected && <button className="small" onClick={() => act(`/requests/${r.id}/mute`)} disabled={disabled}>Mute</button>}
                {meeting?.mode === "broadcast" && r.role !== "cohost" && (
                  <button className="small" onClick={() => act(`/requests/${r.id}/role`, { role: r.role === "speaker" ? "audience" : "speaker" })} disabled={disabled}>
                    {r.role === "speaker" ? "Move to audience" : "Invite to speak"}
                  </button>
                )}
                {isHost && r.method !== "dialin" && (
                  <button
                    className="small"
                    onClick={() => act(`/requests/${r.id}/role`, { role: r.role === "cohost" ? (meeting?.mode === "broadcast" ? "audience" : "participant") : "cohost" })}
                    disabled={disabled}
                  >
                    {r.role === "cohost" ? "Remove co-host" : "Make co-host"}
                  </button>
                )}
                <button className="small danger" onClick={() => act(`/requests/${r.id}/remove`, {}, `Remove ${r.name}? They'll need approval to come back.`)} disabled={disabled}>Remove</button>
                <button className="small danger" onClick={() => act(`/requests/${r.id}/block`, {}, `Remove and block ${r.name}? They can't rejoin from this device, verified contact or phone line.`)} disabled={disabled}>Block</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack">
        <h3>Call someone's phone</h3>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            act("/dialout", dial).then(() => setDial({ number: "", name: "" }));
          }}
        >
          <input aria-label="Name" placeholder="Name" value={dial.name} onChange={(e) => setDial({ ...dial, name: e.target.value })} />
          <input aria-label="Phone number" type="tel" placeholder="+44 7911 123456" value={dial.number} onChange={(e) => setDial({ ...dial, number: e.target.value })} />
          <button className="small" disabled={disabled || !dial.number.trim()}>Call and bring into meeting</button>
          <p className="small muted">Requires phone service on this server and the Business plan.</p>
        </form>
      </section>

      {removed.length > 0 && (
        <section>
          <h3>Declined or removed ({removed.length})</h3>
          <ul className="list">
            {removed.map((r) => (
              <li key={r.id} className="row spread">
                <span>{r.name} <span className="badge">{r.status}</span></span>
                {r.status === "blocked" ? (
                  <button className="small" onClick={() => act(`/requests/${r.id}/unblock`)} disabled={disabled}>Unblock</button>
                ) : (
                  <button className="small" onClick={() => act(`/requests/${r.id}/approve`)} disabled={disabled}>Let back in</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

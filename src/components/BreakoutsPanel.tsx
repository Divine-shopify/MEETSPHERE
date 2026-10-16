"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { Alert, useAction } from "./ui";

interface Room {
  id: string;
  name: string;
  members?: Array<{ id: string; name: string }>;
}

export function BreakoutsPanel({
  code,
  moderator,
  version,
  people,
  onVisit,
  currentBreakoutId,
}: {
  code: string;
  moderator: boolean;
  version: number;
  people: Array<{ id: string; name: string }>;
  onVisit: (breakoutId: string | null) => void;
  currentBreakoutId: string | null;
}) {
  const [data, setData] = useState<{ open: boolean; myBreakoutId: string | null; rooms: Room[] } | null>(null);
  const [count, setCount] = useState(2);
  const [message, setMessage] = useState("");
  const { busy, error, run } = useAction();
  // Responses can arrive out of order (event-driven refreshes vs. our own actions); keep only the newest.
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    api(`/api/meetings/${code}/breakouts`).then((d) => mine === seq.current && setData(d), () => {});
  }, [code, version]);

  const send = async (body: object) => {
    const mine = ++seq.current;
    const r = await run(() => api(`/api/meetings/${code}/breakouts`, { body }));
    if (r && mine === seq.current) setData(r);
    else if (r) api(`/api/meetings/${code}/breakouts`).then(setData, () => {});
  };

  if (!data) return null;
  if (!moderator) {
    const mine = data.rooms.find((r) => r.id === data.myBreakoutId);
    return (
      <div className="stack">
        {data.open && mine ? (
          <>
            <p>You're in <strong>{mine.name}</strong>.</p>
            <ul className="list">{mine.members?.map((m) => <li key={m.id}>{m.name}</li>)}</ul>
            <p className="small muted">The host will bring everyone back to the main room.</p>
          </>
        ) : (
          <p className="small muted">Breakout rooms aren't open{data.open ? " for you" : ""}.</p>
        )}
      </div>
    );
  }

  const assigned = new Map<string, string>();
  data.rooms.forEach((r) => r.members?.forEach((m) => assigned.set(m.id, r.id)));
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {data.rooms.length === 0 ? (
        <div className="row">
          <label htmlFor="bo-count" className="sr-only">Number of rooms</label>
          <input id="bo-count" type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 80 }} />
          <button className="small primary" disabled={busy} onClick={() => send({ action: "create", count })}>Create rooms</button>
        </div>
      ) : (
        <>
          <div className="row">
            {!data.open ? (
              <>
                <button className="small" disabled={busy} onClick={() => send({ action: "auto_assign" })}>Assign everyone randomly</button>
                <button className="small primary" disabled={busy} onClick={() => send({ action: "open" })}>Open rooms</button>
                <button className="small" disabled={busy} onClick={() => send({ action: "create", count: 1 })}>+ Room</button>
                <button className="small danger" disabled={busy} onClick={() => send({ action: "delete_all" })}>Delete rooms</button>
              </>
            ) : (
              <button className="small primary" disabled={busy} onClick={() => send({ action: "close" })}>Close rooms, bring everyone back</button>
            )}
          </div>
          {data.open && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                send({ action: "broadcast", message }).then(() => setMessage(""));
              }}
            >
              <input aria-label="Message to all rooms" placeholder="Message to all rooms" value={message} onChange={(e) => setMessage(e.target.value)} style={{ flex: 1 }} />
              <button className="small" disabled={!message.trim()}>Send</button>
            </form>
          )}
          {data.open && currentBreakoutId && <button className="small" onClick={() => onVisit(null)}>Return to main room</button>}
          {data.rooms.map((r) => (
            <div key={r.id} className="stack" style={{ borderTop: "1px solid #2c3444", paddingTop: 8 }}>
              <div className="row spread">
                <strong>{r.name}</strong>
                {data.open && (
                  <button className="small" disabled={currentBreakoutId === r.id} onClick={() => onVisit(r.id)}>
                    {currentBreakoutId === r.id ? "You're here" : "Join room"}
                  </button>
                )}
              </div>
              <span className="small muted">{r.members?.map((m) => m.name).join(", ") || "Empty"}</span>
            </div>
          ))}
          <h3>Assign people</h3>
          <ul className="list">
            {people.map((p) => (
              <li key={p.id} className="row spread">
                <span>{p.name}</span>
                <select
                  aria-label={`Room for ${p.name}`}
                  value={assigned.get(p.id) ?? ""}
                  onChange={(e) => send({ action: "assign", requestId: p.id, breakoutId: e.target.value || null })}
                  style={{ width: "auto", minHeight: 34, background: "#232a38", color: "#e8ebf1", borderColor: "#36405a" }}
                >
                  <option value="">Main room</option>
                  {data.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

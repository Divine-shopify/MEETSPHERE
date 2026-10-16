"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CopyLink } from "@/components/CopyLink";
import { Alert, Check, formatBytes, formatDuration, Spinner, Tabs, useAction, useApi } from "@/components/ui";
import { api, ApiError } from "@/lib/client";

type Tab = "settings" | "invites" | "recordings" | "notes" | "safety" | "phone" | "audit";

const POLICIES = [
  ["host_approval", "Everyone waits for my approval"],
  ["invited_only", "Invited attendees only"],
  ["verified_only", "Anyone with a verified phone/email"],
  ["anyone_with_link", "Anyone with the link"],
] as const;

const ACTION_LABELS: Record<string, string> = {
  meeting_created: "Meeting created", settings_changed: "Settings changed", meeting_locked: "Meeting locked", meeting_unlocked: "Meeting unlocked",
  meeting_ended: "Meeting ended", invitations_added: "Invitations added", invitation_revoked: "Invitation removed", invitations_sent: "Invitations sent",
  join_requested: "Asked to join", join_denied: "Join denied", auto_admitted: "Admitted automatically", approved: "Approved", rejected: "Rejected",
  removed: "Removed", blocked: "Removed and blocked", unblocked: "Unblocked", muted: "Muted", role_changed: "Role changed",
  media_token_issued: "Connected to media", participant_joined: "Joined room", participant_left: "Left room",
  unauthorized_media_join_kicked: "Unauthorized media join removed", recording_started: "Recording started", recording_stopped: "Recording stopped",
  stream_started: "Live stream started", stream_stopped: "Live stream stopped", transcription_started: "Captions on", transcription_stopped: "Captions off",
  breakouts_opened: "Breakout rooms opened", breakouts_closed: "Breakout rooms closed", dialout: "Called a phone", safety_alert: "Safety alert",
  abuse_reported: "Abuse reported", summary_generated: "AI summary generated", artifact_deleted: "Recording deleted",
};

export default function Manage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("settings");
  const [meeting, setMeeting] = useState<any>(null);
  const { busy, error, notice, run } = useAction();

  const load = useCallback(async () => {
    try {
      const r = await api(`/api/meetings/${code}`);
      if (!r.host) return router.replace(`/m/${code}`);
      setMeeting({ ...r.host, branding: r.meeting.branding, services: r.services, dialIn: r.meeting.dialIn, googleCalendarUrl: r.googleCalendarUrl });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace(`/signin?next=/m/${code}/manage`);
    }
  }, [code, router]);
  useEffect(() => {
    load();
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    const r = await run(() => api(`/api/meetings/${code}/settings`, { method: "PATCH", body }), "Saved");
    if (r) load();
  };

  if (!meeting) return <main className="container"><Spinner /></main>;
  return (
    <main className="container wide stack">
      <header className="row spread">
        <Link href="/dashboard">← My meetings</Link>
        <div className="row">
          <Link className="btn small" href={`/m/${code}/replay`}>Replay & notes</Link>
          {!meeting.ended && <Link className="btn primary small" href={`/m/${code}`}>Open meeting</Link>}
        </div>
      </header>
      <h1>{meeting.title}</h1>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}

      <section className="card stack">
        <CopyLink code={code} title={meeting.title} />
        <div className="row small">
          <a href={`/api/meetings/${code}/ics`}>Download calendar invite (.ics)</a>
          {meeting.googleCalendarUrl && <a href={meeting.googleCalendarUrl} target="_blank" rel="noopener">Add to Google Calendar</a>}
          {meeting.dialIn?.number && <span>· Dial in {meeting.dialIn.number}, PIN {meeting.dialIn.pin}#</span>}
        </div>
        <div className="row">
          <button className="small" aria-pressed={meeting.locked} disabled={busy || meeting.ended} onClick={() => run(() => api(`/api/meetings/${code}/lock`, { body: { locked: !meeting.locked } })).then(load)}>
            {meeting.locked ? "Unlock meeting" : "Lock meeting"}
          </button>
          <button
            className="small"
            disabled={busy}
            onClick={() => {
              const name = prompt("Name this preset (e.g. 'Grade 7 maths', 'Sunday service')", meeting.title);
              if (name) run(() => api(`/api/meetings/${code}/save-preset`, { body: { name } }), `Saved preset "${name}". Use it when creating meetings.`);
            }}
          >
            Save as preset
          </button>
          {meeting.ended ? (
            <button className="small primary" disabled={busy} onClick={() => run(() => api(`/api/meetings/${code}/reopen`, { body: {} }), "Reopened on the same link.").then(load)}>
              {meeting.recurrence !== "none" ? "Start next session" : "Reopen meeting"}
            </button>
          ) : (
            <button
              className="small danger"
              disabled={busy}
              onClick={() => confirm("End this meeting for everyone? People will be disconnected.") && run(() => api(`/api/meetings/${code}/end`, { body: {} })).then(load)}
            >
              End meeting for everyone
            </button>
          )}
        </div>
      </section>

      <Tabs<Tab>
        tabs={[["settings", "Settings"], ["invites", "Invite list"], ["recordings", "Recordings"], ["notes", "Notes & transcript"], ["safety", "Safety"], ["phone", "Phone"], ["audit", "Audit trail"]]}
        value={tab}
        onChange={setTab}
      />
      {tab === "settings" && <SettingsTab meeting={meeting} patch={patch} busy={busy} />}
      {tab === "invites" && <InvitesTab code={code} />}
      {tab === "recordings" && <RecordingsTab code={code} meeting={meeting} />}
      {tab === "notes" && <NotesTab code={code} />}
      {tab === "safety" && <SafetyTab code={code} />}
      {tab === "phone" && <PhoneTab code={code} />}
      {tab === "audit" && <AuditTab code={code} />}
    </main>
  );
}

function SettingsTab({ meeting: m, patch, busy }: { meeting: any; patch: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [title, setTitle] = useState(m.title);
  const [waiting, setWaiting] = useState(m.waitingMessage ?? "");
  const [when, setWhen] = useState(m.scheduledAt ? new Date(m.scheduledAt).toISOString().slice(0, 16) : "");
  const d = busy || m.ended;
  return (
    <div className="grid2">
      <section className="card stack">
        <h2>Basics</h2>
        <div>
          <label htmlFor="title">Title</label>
          <div className="row"><input id="title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} /><button className="small" disabled={d || title === m.title} onClick={() => patch({ title })}>Save</button></div>
        </div>
        <div>
          <label htmlFor="when">Scheduled (your local time)</label>
          <div className="row">
            <input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={{ flex: 1 }} />
            <button className="small" disabled={d} onClick={() => patch({ scheduledAt: when ? new Date(when).toISOString() : null })}>Save</button>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="dur">Length (for calendars)</label>
            <select id="dur" value={m.durationMinutes} onChange={(e) => patch({ durationMinutes: Number(e.target.value) })} disabled={d}>
              {[15, 30, 45, 60, 90, 120, 180, 240].map((n) => <option key={n} value={n}>{n} minutes</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="rec">Repeats</label>
            <select id="rec" value={m.recurrence} onChange={(e) => patch({ recurrence: e.target.value })} disabled={d}>
              <option value="none">Doesn't repeat</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Every weekday</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
        </div>
        <p className="small muted">No time limit applies to the meeting itself; length is only used for calendar invites.</p>
        <div>
          <label htmlFor="mode">Type</label>
          <select id="mode" value={m.mode} onChange={(e) => patch({ mode: e.target.value })} disabled={d}>
            <option value="interactive">Interactive (everyone can talk and share video)</option>
            <option value="broadcast">Presentation (speakers + audience; live stream for large audiences)</option>
          </select>
        </div>
      </section>
      <section className="card stack">
        <h2>Admission</h2>
        <div>
          <label htmlFor="policy">Who can get in</label>
          <select id="policy" value={m.accessPolicy} onChange={(e) => patch({ accessPolicy: e.target.value })} disabled={d}>
            {POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <Check checked={m.allowNameOnlyRequests} onChange={(v) => patch({ allowNameOnlyRequests: v })} disabled={d} label="Allow name-only requests (always reviewed; a typed name is never treated as verified)" />
        <Check checked={m.autoAdmitVerifiedInvitees} onChange={(v) => patch({ autoAdmitVerifiedInvitees: v })} disabled={d} label="Let invitees in automatically once they verify the phone/email on the list" />
        <div>
          <label htmlFor="wm">Waiting room message</label>
          <textarea id="wm" rows={2} maxLength={500} value={waiting} onChange={(e) => setWaiting(e.target.value)} placeholder="e.g. We'll start at 10:05. Please have your ID ready." />
          <button className="small" disabled={d} onClick={() => patch({ waitingMessage: waiting.trim() || null })}>Save message</button>
        </div>
      </section>
      <section className="card stack">
        <h2>In the meeting</h2>
        <Check checked={m.allowScreenShare} onChange={(v) => patch({ allowScreenShare: v })} disabled={d} label="Participants can share their screen" />
        <Check checked={m.chatEnabled} onChange={(v) => patch({ chatEnabled: v })} disabled={d} label="Participants can chat and send reactions" />
        <Check checked={m.qaEnabled} onChange={(v) => patch({ qaEnabled: v })} disabled={d} label="Q&A" />
        <Check checked={m.qaModerated} onChange={(v) => patch({ qaModerated: v })} disabled={d || !m.qaEnabled} label="Review questions before everyone sees them" />
        <Check checked={m.qaAnonymousAllowed} onChange={(v) => patch({ qaAnonymousAllowed: v })} disabled={d || !m.qaEnabled} label="Allow anonymous questions" />
        <Check checked={m.pollsEnabled} onChange={(v) => patch({ pollsEnabled: v })} disabled={d} label="Polls" />
        <Check checked={m.whiteboardEnabled} onChange={(v) => patch({ whiteboardEnabled: v })} disabled={d} label="Whiteboard" />
        <Check checked={m.captionsEnabled} onChange={(v) => patch({ captionsEnabled: v })} disabled={d} label="Live captions (each person opts in)" />
      </section>
      <section className="card stack">
        <h2>Privacy</h2>
        <div>
          <label htmlFor="rv">Who can see recordings, transcript and notes afterwards</label>
          <select id="rv" value={m.replayVisibility} onChange={(e) => patch({ replayVisibility: e.target.value })} disabled={busy}>
            <option value="host">Only me and co-hosts</option>
            <option value="attendees">People who were admitted</option>
            <option value="link">Anyone with the link</option>
          </select>
        </div>
        <div>
          <label htmlFor="ret">Delete recordings and meeting content after</label>
          <select id="ret" value={m.retentionDays ?? ""} onChange={(e) => patch({ retentionDays: e.target.value ? Number(e.target.value) : null })} disabled={busy}>
            <option value="">Organization default / keep</option>
            {[1, 7, 30, 90, 365].map((n) => <option key={n} value={n}>{n} day{n === 1 ? "" : "s"}</option>)}
          </select>
        </div>
      </section>
    </div>
  );
}

function InvitesTab({ code }: { code: string }) {
  const { data, reload } = useApi<any>(`/api/meetings/${code}/invitations`);
  const [inv, setInv] = useState({ name: "", phone: "", email: "" });
  const [country, setCountry] = useState("");
  const { busy, error, notice, run } = useAction();
  const contactsSupported = typeof navigator !== "undefined" && "contacts" in navigator;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api(`/api/meetings/${code}/invitations`, { body: { name: inv.name, phone: inv.phone || null, email: inv.email || null, defaultCountry: country || undefined } }), "Added");
    if (r) {
      setInv({ name: "", phone: "", email: "" });
      reload();
    }
  };
  const importFile = async (file: File) => {
    const r = await run(() => file.text().then((csv) => api(`/api/meetings/${code}/invitations/import`, { body: { csv, defaultCountry: country || undefined } })));
    if (r) {
      await run(async () => r, `Imported ${r.added}, ${r.duplicates} duplicate(s)${r.errorCount ? `, ${r.errorCount} skipped: ${r.errors.slice(0, 3).map((x: any) => `line ${x.line}: ${x.message}`).join("; ")}` : ""}.`);
      reload();
    }
  };
  // Android Chrome: pick people straight from the phone's contacts.
  const pickContacts = async () => {
    try {
      const picked: Array<{ name?: string[]; tel?: string[]; email?: string[] }> = await (navigator as any).contacts.select(["name", "tel", "email"], { multiple: true });
      const csv = ["name,phone,email", ...picked.map((c) => [c.name?.[0] ?? "Guest", c.tel?.[0] ?? "", c.email?.[0] ?? ""].map((v) => `"${v.replace(/"/g, '""')}"`).join(","))].join("\n");
      await importFile(new File([csv], "contacts.csv"));
    } catch {
      /* cancelled */
    }
  };
  const send = async (ids?: string[]) => {
    const r = await run(() => api(`/api/meetings/${code}/invitations/send`, { body: { ids } }));
    if (r) {
      await run(
        async () => r,
        `Sent ${r.email} email(s) and ${r.sms} text(s).${r.skipped ? ` ${r.skipped} not sent.` : ""}${r.unavailable.length ? ` ${r.unavailable.join(" and ")} sending isn't configured on this server.` : ""}`,
      );
      reload();
    }
  };

  return (
    <section className="card stack">
      <p className="small muted">
        Only you can see this list. People are let in by a phone number or email they verify with a code; a matching name alone is shown as a weak match and never lets anyone in.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      <form onSubmit={add} className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: "2 1 160px" }}><label htmlFor="iname">Name</label><input id="iname" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} required /></div>
        <div style={{ flex: "2 1 160px" }}><label htmlFor="iphone">Phone</label><input id="iphone" type="tel" value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} placeholder="+44…" /></div>
        <div style={{ flex: "2 1 160px" }}><label htmlFor="iemail">Email</label><input id="iemail" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></div>
        <div style={{ flex: "1 1 90px" }}><label htmlFor="country">Default country</label><input id="country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="e.g. DE" maxLength={2} /></div>
        <button type="submit" disabled={busy || !inv.name.trim()}>Add</button>
      </form>
      <div className="row">
        <label className="btn small" htmlFor="csv" style={{ cursor: "pointer" }}>Import CSV (name, phone, email)</label>
        <input id="csv" type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        {contactsSupported && <button className="small" onClick={pickContacts}>Pick from contacts</button>}
        {data?.invitations?.length > 0 && <button className="small primary" disabled={busy} onClick={() => send()}>Send invitations to everyone</button>}
      </div>
      {data?.invitations?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>Sent</th><th /></tr></thead>
            <tbody>
              {data.invitations.map((i: any) => (
                <tr key={i.id}>
                  <td>{i.expected_name}</td>
                  <td className="code">{i.normalized_phone ?? "—"}</td>
                  <td>{i.normalized_email ?? "—"}</td>
                  <td>{i.invite_status === "matched" ? "Joined (verified)" : "Not yet"}</td>
                  <td className="small">{i.last_sent_at ? new Date(i.last_sent_at).toLocaleString() : "—"}</td>
                  <td className="row" style={{ flexWrap: "nowrap" }}>
                    <button className="small" disabled={busy} onClick={() => send([i.id])}>Send</button>
                    <button className="small" disabled={busy} onClick={() => run(() => api(`/api/meetings/${code}/invitations/${i.id}`, { method: "DELETE" })).then(reload)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecordingsTab({ code, meeting }: { code: string; meeting: any }) {
  const { data, reload } = useApi<any>(`/api/meetings/${code}/artifacts`);
  const { busy, error, run } = useAction();
  return (
    <section className="card stack">
      {!meeting.services.recording && <Alert>Recording storage isn't configured on this server (S3_* or RECORDINGS_DIR).</Alert>}
      <p className="small muted">Start and stop recording from the host controls inside the meeting. Everyone sees a recording notice and can leave.</p>
      {error && <Alert kind="error">{error}</Alert>}
      {!data ? <Spinner /> : data.artifacts.length === 0 ? <p className="muted">No recordings yet.</p> : (
        <ul className="list">
          {data.artifacts.map((a: any) => (
            <li key={a.id} className="row spread">
              <span>
                {a.type === "recording" ? "Recording" : "Live stream"} · {new Date(a.createdAt).toLocaleString()} · {formatDuration(a.durationMs)} · {formatBytes(a.sizeBytes)}
                {a.retentionUntil && <span className="small muted"> · deleted {new Date(a.retentionUntil).toLocaleDateString()}</span>}
                {a.status !== "ready" && <span className="badge">{a.status === "failed" ? `Failed${a.error ? `: ${a.error}` : ""}` : "Processing…"}</span>}
              </span>
              {a.status === "ready" && (
                <span className="row">
                  <Link className="btn small" href={`/m/${code}/replay`}>Play</Link>
                  {a.type === "recording" && <a className="btn small" href={`/api/meetings/${code}/artifacts/${a.id}?download=1`}>Download</a>}
                  <button className="small danger" disabled={busy} onClick={() => confirm("Delete this recording permanently?") && run(() => api(`/api/meetings/${code}/artifacts/${a.id}`, { method: "DELETE" })).then(reload)}>Delete</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NotesTab({ code }: { code: string }) {
  const notes = useApi<any>(`/api/meetings/${code}/notes`);
  const transcript = useApi<any>(`/api/meetings/${code}/transcript`);
  const [text, setText] = useState<string | null>(null);
  const { busy, error, notice, run } = useAction();
  const n = notes.data?.notes;
  return (
    <div className="grid2">
      <section className="card stack">
        <h2>Your notes</h2>
        <textarea rows={10} value={text ?? n?.host_notes ?? ""} onChange={(e) => setText(e.target.value)} placeholder="Agenda, decisions, follow-ups…" />
        <button className="small" disabled={busy || text === null} onClick={() => run(() => api(`/api/meetings/${code}/notes`, { method: "PUT", body: { hostNotes: text ?? "" } }), "Notes saved").then(notes.reload)}>Save notes</button>
      </section>
      <section className="card stack">
        <div className="row spread">
          <h2>AI summary</h2>
          <button className="small primary" disabled={busy} onClick={() => run(() => api(`/api/meetings/${code}/notes/summarize`, { body: {} }), "Summary ready").then(notes.reload)}>
            {busy ? <Spinner label="Summarizing" /> : null} {n?.summary ? "Regenerate" : "Generate"}
          </button>
        </div>
        {notes.data && !notes.data.aiConfigured && <Alert>AI summaries aren't configured on this server (ANTHROPIC_API_KEY).</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
        <p className="small muted">Built from the transcript of people who allowed captions, your notes, Q&A and poll results. Nothing else is sent.</p>
        {n?.summary ? (
          <>
            <p>{n.summary}</p>
            {n.decisions.length > 0 && (<><h3>Decisions</h3><ul>{n.decisions.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></>)}
            {n.action_items.length > 0 && (<><h3>Action items</h3><ul>{n.action_items.map((a: any, i: number) => <li key={i}>{a.task}{a.owner ? ` — ${a.owner}` : ""}{a.due ? ` (due ${a.due})` : ""}</li>)}</ul></>)}
            <p className="small muted">Generated {new Date(n.generated_at).toLocaleString()} by {n.ai_model}. Check before sharing.</p>
          </>
        ) : <p className="muted">No summary yet.</p>}
      </section>
      <section className="card stack" style={{ gridColumn: "1 / -1" }}>
        <div className="row spread">
          <h2>Transcript ({transcript.data?.segments?.length ?? 0} lines)</h2>
          <span className="row">
            <a className="btn small" href={`/api/meetings/${code}/transcript?format=txt`}>Text</a>
            <a className="btn small" href={`/api/meetings/${code}/transcript?format=vtt`}>.vtt</a>
          </span>
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {transcript.data?.segments?.map((s: any, i: number) => (
            <p key={i} className="small"><span className="muted">{new Date(s.spoken_at).toLocaleTimeString()}</span> <strong>{s.speaker_name}:</strong> {s.text}</p>
          ))}
          {!transcript.data?.segments?.length && <p className="muted small">Turn on captions (CC) in the meeting to build a transcript. Each person chooses whether they're included.</p>}
        </div>
      </section>
    </div>
  );
}

function SafetyTab({ code }: { code: string }) {
  const { data, reload, loading } = useApi<any>(`/api/meetings/${code}/safety`);
  if (!data) return <Spinner />;
  const m = data.metrics;
  return (
    <section className="card stack">
      <div className="row spread"><h2>Safety</h2><button className="small" onClick={reload} disabled={loading}>Refresh</button></div>
      {data.alerts.length === 0 ? <Alert>Nothing unusual right now.</Alert> : data.alerts.map((a: any) => (
        <div key={a.code} className="alert error" role="alert"><strong>{a.message}</strong> {a.suggestion}</div>
      ))}
      <div className="grid2">
        {[["Join requests (5 min)", m.joinRequests5m], ["Join requests (1 h)", m.joinRequests60m], ["Waiting now", m.waiting], ["Denied (15 min)", m.denied15m],
          ["Codes sent (1 h)", m.otpSends60m], ["Blocked room connections (1 h)", m.unauthorizedMediaBlocked60m], ["Connected now", m.connected], ["Open reports", m.openReports]].map(([l, v]) => (
          <div key={l as string} className="stat"><span className="small muted">{l}</span><b>{v}</b></div>
        ))}
      </div>
      {data.denialsByReason.length > 0 && (
        <p className="small">Denied in the last hour: {data.denialsByReason.map((d: any) => `${d.reason.replace(/_/g, " ")} (${d.count})`).join(", ")}</p>
      )}
      <h3>Reports from participants</h3>
      {data.reports.length === 0 ? <p className="muted small">None.</p> : (
        <ul className="list">
          {data.reports.map((r: any) => (
            <li key={r.id}><strong>{r.reason.replace(/_/g, " ")}</strong>{r.target_name ? ` about ${r.target_name}` : ""} · {new Date(r.created_at).toLocaleString()}{r.details ? <p className="small">{r.details}</p> : null}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PhoneTab({ code }: { code: string }) {
  const { data, reload } = useApi<any>(`/api/meetings/${code}/dialin`);
  const { busy, error, run } = useAction();
  if (!data) return <Spinner />;
  return (
    <section className="card stack">
      <h2>Phone dial-in</h2>
      {!data.configured.dialIn && <Alert>Phone dial-in isn't configured on this server (LiveKit SIP trunk + DIALIN_NUMBER).</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {data.enabled ? (
        <>
          <p>People can call <strong>{data.number}</strong> and enter PIN <strong className="code">{data.pin}</strong> followed by #.</p>
          <p className="small muted">Callers show as "Phone caller (unverified)": caller ID can be faked. Lock and block apply to them too.</p>
          <button className="small danger" disabled={busy} onClick={() => run(() => api(`/api/meetings/${code}/dialin`, { body: { enabled: false } })).then(reload)}>Turn off dial-in</button>
        </>
      ) : (
        <button className="small primary" disabled={busy || !data.configured.dialIn} onClick={() => run(() => api(`/api/meetings/${code}/dialin`, { body: { enabled: true } })).then(reload)}>Turn on dial-in</button>
      )}
      <p className="small muted">You can also call someone's phone from the host controls inside the meeting{data.configured.dialOut ? "" : " (not configured on this server)"}.</p>
    </section>
  );
}

function AuditTab({ code }: { code: string }) {
  const { data, reload } = useApi<any>(`/api/meetings/${code}/audit`);
  return (
    <section className="card stack">
      <div className="row spread"><h2>Audit trail</h2><button className="small" onClick={reload}>Refresh</button></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Event</th><th>By</th><th>About</th><th>Details</th></tr></thead>
          <tbody>
            {data?.events?.map((e: any) => (
              <tr key={e.id}>
                <td className="small">{new Date(e.created_at).toLocaleString()}</td>
                <td>{ACTION_LABELS[e.action] ?? e.action}</td>
                <td>{e.actor_name ?? "—"}</td>
                <td>{e.target_name ?? "—"}</td>
                <td className="small muted">{[e.reason, Object.keys(e.metadata ?? {}).length ? JSON.stringify(e.metadata) : null].filter(Boolean).join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

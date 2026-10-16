"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CopyLink } from "@/components/CopyLink";
import { api, ApiError } from "@/lib/client";

const POLICIES = [
  ["host_approval", "Everyone waits for my approval"],
  ["invited_only", "Invited attendees only"],
  ["verified_only", "Anyone with a verified phone/email"],
  ["anyone_with_link", "Anyone with the link"],
] as const;

const ACTION_LABELS: Record<string, string> = {
  meeting_created: "Meeting created",
  settings_changed: "Settings changed",
  meeting_locked: "Meeting locked",
  meeting_unlocked: "Meeting unlocked",
  meeting_ended: "Meeting ended",
  invitations_added: "Invitations added",
  invitation_revoked: "Invitation removed",
  join_requested: "Asked to join",
  join_denied: "Join denied",
  auto_admitted: "Admitted automatically",
  approved: "Approved",
  rejected: "Rejected",
  removed: "Removed",
  blocked: "Removed and blocked",
  unblocked: "Unblocked",
  muted: "Muted",
  role_changed: "Role changed",
  media_token_issued: "Connected to media",
  participant_joined: "Joined room",
  participant_left: "Left room",
  unauthorized_media_join_kicked: "Unauthorized media join removed",
};

export default function Manage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [meeting, setMeeting] = useState<any>(null);
  const [invites, setInvites] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inv, setInv] = useState({ name: "", phone: "", email: "" });
  const [country, setCountry] = useState("");

  const load = useCallback(async () => {
    try {
      const [r, i, a] = await Promise.all([
        api(`/api/meetings/${code}/requests`),
        api(`/api/meetings/${code}/invitations`),
        api(`/api/meetings/${code}/audit`),
      ]);
      setMeeting(r.meeting);
      setInvites(i.invitations);
      setEvents(a.events);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace(`/signin?next=/m/${code}/manage`);
      else setError((err as Error).message);
    }
  }, [code, router]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setError(null);
    try {
      const r = await api(`/api/meetings/${code}/settings`, { method: "PATCH", body });
      setMeeting(r.meeting);
      setNotice("Settings saved");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/meetings/${code}/invitations`, {
        body: { name: inv.name, phone: inv.phone || null, email: inv.email || null, defaultCountry: country || undefined },
      });
      setInv({ name: "", phone: "", email: "" });
      setNotice("Invitation added");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function importFile(file: File) {
    setError(null);
    try {
      const csv = await file.text();
      const r = await api(`/api/meetings/${code}/invitations/import`, { body: { csv, defaultCountry: country || undefined } });
      const errs = r.errorCount ? ` ${r.errorCount} row(s) skipped: ${r.errors.slice(0, 5).map((e: any) => `line ${e.line}: ${e.message}`).join("; ")}` : "";
      setNotice(`Imported ${r.added} invitation(s), ${r.duplicates} duplicate(s).${errs}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(id: string) {
    await api(`/api/meetings/${code}/invitations/${id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    load();
  }

  async function setLock(locked: boolean) {
    await api(`/api/meetings/${code}/lock`, { body: { locked } }).catch((e) => setError(e.message));
    load();
  }

  async function end() {
    if (!confirm("End this meeting for everyone? People will be disconnected and can't rejoin.")) return;
    await api(`/api/meetings/${code}/end`, { body: {} }).catch((e) => setError(e.message));
    load();
  }

  if (!meeting) {
    return <main className="container">{error ? <div className="alert error">{error}</div> : <span className="spinner" aria-label="Loading" />}</main>;
  }

  return (
    <main className="container wide stack">
      <header className="row spread">
        <Link href="/dashboard">← My meetings</Link>
        {!meeting.ended && <Link className="btn primary small" href={`/m/${code}`}>Open meeting</Link>}
      </header>
      <h1>{meeting.title}</h1>
      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert info" role="status">{notice}</div>}

      <section className="card stack">
        <h2>Link</h2>
        <CopyLink code={code} title={meeting.title} />
      </section>

      <section className="card stack">
        <h2>Admission</h2>
        <div>
          <label htmlFor="policy">Who can get in</label>
          <select id="policy" value={meeting.accessPolicy} onChange={(e) => patch({ accessPolicy: e.target.value })} disabled={meeting.ended}>
            {POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={meeting.allowNameOnlyRequests} onChange={(e) => patch({ allowNameOnlyRequests: e.target.checked })} disabled={meeting.ended} />
          <span>Allow name-only requests (always reviewed by you; a typed name is never treated as verified)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={meeting.autoAdmitVerifiedInvitees} onChange={(e) => patch({ autoAdmitVerifiedInvitees: e.target.checked })} disabled={meeting.ended} />
          <span>Let invited people in automatically once they verify the phone/email on the list (invited-only meetings)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={meeting.allowScreenShare} onChange={(e) => patch({ allowScreenShare: e.target.checked })} disabled={meeting.ended} />
          <span>Participants can share their screen</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={meeting.chatEnabled} onChange={(e) => patch({ chatEnabled: e.target.checked })} disabled={meeting.ended} />
          <span>Participants can chat and send reactions</span>
        </label>
        <div className="row">
          <button onClick={() => setLock(!meeting.locked)} disabled={meeting.ended} aria-pressed={meeting.locked}>
            {meeting.locked ? "Unlock meeting" : "Lock meeting"}
          </button>
          {!meeting.ended && <button className="danger" onClick={end}>End meeting for everyone</button>}
        </div>
      </section>

      <section className="card stack">
        <div className="row spread">
          <h2>Expected attendees ({invites.length})</h2>
        </div>
        <p className="small muted">
          Only you can see this list. People are matched by a phone number or email they verify with a code; matching a name alone is shown as
          a weak match and never lets anyone in.
        </p>
        <form onSubmit={addInvite} className="stack">
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: "2 1 160px" }}>
              <label htmlFor="iname">Name</label>
              <input id="iname" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} required />
            </div>
            <div style={{ flex: "2 1 160px" }}>
              <label htmlFor="iphone">Phone</label>
              <input id="iphone" type="tel" value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} placeholder="+44…" />
            </div>
            <div style={{ flex: "2 1 160px" }}>
              <label htmlFor="iemail">Email</label>
              <input id="iemail" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </div>
            <div style={{ flex: "1 1 90px" }}>
              <label htmlFor="country">Default country</label>
              <input id="country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="e.g. DE" maxLength={2} />
            </div>
            <button type="submit" disabled={!inv.name.trim()}>Add</button>
          </div>
        </form>
        <div>
          <label htmlFor="csv">Import CSV (columns: name, phone, email)</label>
          <input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </div>
        {invites.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th /></tr></thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.expected_name}</td>
                    <td className="code">{i.normalized_phone ?? "—"}</td>
                    <td>{i.normalized_email ?? "—"}</td>
                    <td>{i.invite_status === "matched" ? "Joined (verified)" : "Not yet"}</td>
                    <td><button className="small" onClick={() => revoke(i.id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="row spread">
          <h2>Audit trail</h2>
          <button className="small" onClick={load}>Refresh</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Event</th><th>By</th><th>About</th><th>Details</th></tr></thead>
            <tbody>
              {events.map((e) => (
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
    </main>
  );
}

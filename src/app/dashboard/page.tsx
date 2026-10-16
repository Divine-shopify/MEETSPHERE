"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { CopyLink } from "@/components/CopyLink";
import { Alert, Check, Spinner, useAction, useApi } from "@/components/ui";
import { api } from "@/lib/client";

const POLICIES = [
  ["host_approval", "Everyone waits for my approval"],
  ["invited_only", "Invited attendees only"],
  ["verified_only", "Anyone with a verified phone/email"],
  ["anyone_with_link", "Anyone with the link"],
] as const;

export default function Dashboard() {
  const router = useRouter();
  const me = useApi<any>("/api/me");
  const meetings = useApi<any>(me.data?.user ? "/api/meetings" : null, [me.data?.user?.id]);
  const presets = useApi<any>(me.data?.user ? "/api/presets" : null, [me.data?.user?.id]);
  const orgs = useApi<any>(me.data?.user ? "/api/orgs" : null, [me.data?.user?.id]);
  const [form, setForm] = useState({ title: "", mode: "interactive", accessPolicy: "host_approval", allowNameOnlyRequests: true, when: "", recurrence: "none", presetId: "", orgId: "" });
  const [created, setCreated] = useState<any>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (me.data && !me.data.user) router.replace("/signin?next=/dashboard");
  }, [me.data, router]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const preset = form.presetId ? presets.data?.presets.find((p: any) => p.id === form.presetId) : null;
    const r = await run(() =>
      api("/api/meetings", {
        body: {
          title: form.title,
          presetId: form.presetId || undefined,
          orgId: form.orgId || undefined,
          scheduledAt: form.when ? new Date(form.when).toISOString() : null,
          // With a preset, the preset's rules apply unless changed here.
          ...(preset ? {} : { mode: form.mode, accessPolicy: form.accessPolicy, allowNameOnlyRequests: form.allowNameOnlyRequests, recurrence: form.recurrence }),
        },
      }),
    );
    if (r) {
      setCreated(r.meeting);
      setForm({ ...form, title: "" });
      meetings.reload();
    }
  }

  if (!me.data?.user) return <main className="container"><Spinner /></main>;
  const list = meetings.data?.meetings ?? [];
  const upcoming = list.filter((m: any) => !m.ended);
  const past = list.filter((m: any) => m.ended);

  return (
    <main className="container stack">
      <AppHeader name={me.data.user.displayName} />
      {!me.data.services.media && (
        <Alert kind="error">Audio/video is not configured on this server (LIVEKIT_* variables missing). Admission works, but rooms won't connect.</Alert>
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
            <input id="title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={120} placeholder="Sunday service, Grade 7 maths, Team sync…" />
          </div>
          {presets.data?.presets?.length > 0 && (
            <div>
              <label htmlFor="preset">Use a preset</label>
              <select id="preset" value={form.presetId} onChange={(e) => setForm({ ...form, presetId: e.target.value })}>
                <option value="">No preset</option>
                {presets.data.presets.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.invitationCount ? ` (${p.invitationCount} invitees)` : ""}</option>)}
              </select>
            </div>
          )}
          {orgs.data?.orgs?.length > 0 && (
            <div>
              <label htmlFor="org">Organization</label>
              <select id="org" value={form.orgId} onChange={(e) => setForm({ ...form, orgId: e.target.value })}>
                <option value="">Personal</option>
                {orgs.data.orgs.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <p className="small muted">Organization meetings use its plan, branding, defaults and retention rules.</p>
            </div>
          )}
          {!form.presetId && (
            <>
              <div>
                <label htmlFor="policy">Who can get in</label>
                <select id="policy" value={form.accessPolicy} onChange={(e) => setForm({ ...form, accessPolicy: e.target.value })}>
                  {POLICIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {form.accessPolicy !== "anyone_with_link" && (
                <Check checked={form.allowNameOnlyRequests} onChange={(v) => setForm({ ...form, allowNameOnlyRequests: v })} label="Let people without a verified phone/email ask to join by name (you review each one)" />
              )}
              <div>
                <label htmlFor="mode">Type</label>
                <select id="mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                  <option value="interactive">Interactive meeting (everyone can talk and share video)</option>
                  <option value="broadcast">Presentation: speakers + audience, with live streaming for large events</option>
                </select>
              </div>
              <div>
                <label htmlFor="rec">Repeats</label>
                <select id="rec" value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}>
                  <option value="none">Doesn't repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekdays">Every weekday</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
            </>
          )}
          <div>
            <label htmlFor="when">Scheduled time (optional)</label>
            <input id="when" type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} />
          </div>
          {error && <Alert kind="error">{error}</Alert>}
          <button className="primary" type="submit" disabled={busy || !form.title.trim()}>{busy ? <Spinner /> : null} Create meeting</button>
        </form>
      </section>
      <MeetingList title="Upcoming and live" items={upcoming} loading={!meetings.data} />
      {past.length > 0 && <MeetingList title="Ended" items={past} loading={false} />}
    </main>
  );
}

function MeetingList({ title, items, loading }: { title: string; items: any[]; loading: boolean }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {loading ? <Spinner /> : items.length === 0 ? <p className="muted">No meetings.</p> : (
        <ul className="list">
          {items.map((m) => (
            <li key={m.code} className="row spread">
              <div>
                <div>
                  <strong>{m.title}</strong> {m.status === "live" && <span className="badge">Live</span>} {m.locked && <span className="badge">Locked</span>}
                  {m.recurrence !== "none" && <span className="badge">Repeats</span>}
                </div>
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
  );
}

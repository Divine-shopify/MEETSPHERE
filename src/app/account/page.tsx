"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, Spinner, useAction, useApi } from "@/components/ui";
import { api } from "@/lib/client";

const USAGE_LABELS: Record<string, string> = {
  participant_minutes: "Participant-minutes",
  recording_minutes: "Recording minutes",
  stream_minutes: "Live-stream minutes",
  dialin_minutes: "Phone minutes",
  otp_sms: "Verification texts",
  otp_email: "Verification emails",
  invite_sms: "Invitation texts",
  invite_email: "Invitation emails",
  ai_summary: "AI summaries",
};

function Account() {
  const router = useRouter();
  const params = useSearchParams();
  const acct = useApi<any>("/api/account");
  const presets = useApi<any>("/api/presets");
  const hooks = useApi<any>("/api/account/webhooks");
  const [name, setName] = useState("");
  const [org, setOrg] = useState({ name: "", slug: "" });
  const [hook, setHook] = useState({ url: "", events: ["meeting.ended", "recording.ready", "summary.ready"] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, error, notice, run } = useAction();

  useEffect(() => {
    if (acct.error?.status === 401) router.replace("/signin?next=/account");
  }, [acct.error, router]);
  if (!acct.data) return <main className="container"><Spinner /></main>;
  const { user, account, orgs, plans, checkoutAvailable } = acct.data;
  const plan = account.plan;

  const go = async (path: string, body: object) => {
    const r = await run(() => api(path, { body }));
    if (r?.url) window.location.href = r.url;
  };

  return (
    <main className="container stack">
      <AppHeader name={user.displayName} />
      <h1>Account</h1>
      {params.get("billing") === "success" && <Alert>Thanks! Your plan updates as soon as payment is confirmed.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}

      <section className="card stack">
        <h2>Profile</h2>
        <p className="small muted">{user.email ?? user.phone}</p>
        <div className="row">
          <input aria-label="Display name" value={name || user.displayName} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="small" disabled={busy || !name.trim()} onClick={() => run(() => api("/api/account", { method: "PATCH", body: { displayName: name } }), "Saved").then(acct.reload)}>Save</button>
        </div>
      </section>

      <section className="card stack">
        <h2>Plan: {plan.name}</h2>
        {account.billing?.status && account.billing.status !== "active" && <Alert kind="error">Billing status: {account.billing.status.replace("_", " ")}</Alert>}
        <div className="grid2">
          {Object.entries(account.usage).length === 0 ? <p className="muted small">No usage this month yet.</p> : Object.entries(account.usage).map(([k, v]) => (
            <div key={k} className="stat">
              <span className="small muted">{USAGE_LABELS[k] ?? k} this month</span>
              <b>{(v as number).toLocaleString()}</b>
              {k === "participant_minutes" && plan.monthlyParticipantMinutes && (
                <div className="bar" aria-hidden><span style={{ width: `${Math.min(100, ((v as number) / plan.monthlyParticipantMinutes) * 100)}%` }} /></div>
              )}
            </div>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th /> {plans.map((p: any) => <th key={p.id}>{p.name}{p.id === plan.id ? " (yours)" : ""}</th>)}</tr></thead>
            <tbody>
              {[
                ["Price / month", (p: any) => (p.priceMonthlyUsd === null ? "Contact us" : p.priceMonthlyUsd === 0 ? "Free" : `$${p.priceMonthlyUsd}`)],
                ["Meeting length", () => "No cutoff"],
                ["Interactive participants", (p: any) => p.maxParticipants],
                ["Presentation audience", (p: any) => p.maxAudience.toLocaleString()],
                ["Participant-minutes / month", (p: any) => (p.monthlyParticipantMinutes ? p.monthlyParticipantMinutes.toLocaleString() : "Custom")],
                ["Recording", (p: any) => (p.recording ? `${p.recordingStorageGb} GB` : "—")],
                ["Live streaming", (p: any) => (p.hlsStreaming ? "✓" : "—")],
                ["AI summaries / month", (p: any) => p.aiSummariesPerMonth || "—"],
                ["Phone dial-in", (p: any) => (p.telephony ? "✓" : "—")],
                ["Branding & webhooks", (p: any) => (p.customBranding ? "✓" : "—")],
                ["Single sign-on", (p: any) => (p.sso ? "✓" : "—")],
              ].map(([label, fn]: any) => (
                <tr key={label}><th>{label}</th>{plans.map((p: any) => <td key={p.id}>{fn(p)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row">
          {checkoutAvailable.pro && plan.id === "free" && <button className="primary" disabled={busy} onClick={() => go("/api/billing/checkout", { plan: "pro" })}>Upgrade to Pro</button>}
          {checkoutAvailable.business && plan.id !== "business" && plan.id !== "enterprise" && <button disabled={busy} onClick={() => go("/api/billing/checkout", { plan: "business" })}>Upgrade to Business</button>}
          {account.billing?.hasCustomer && <button disabled={busy} onClick={() => go("/api/billing/portal", {})}>Manage billing</button>}
          {!checkoutAvailable.pro && !checkoutAvailable.business && <p className="small muted">Online checkout isn't configured on this server.</p>}
        </div>
        <p className="small muted">Fair-use limits are only checked when someone new connects. A running meeting is never cut off.</p>
      </section>

      <section className="card stack">
        <h2>Organizations</h2>
        <ul className="list">
          {orgs.map((o: any) => <li key={o.id} className="row spread"><span>{o.name} <span className="badge">{o.role}</span></span>{o.role !== "member" && <Link className="btn small" href={`/org/${o.slug}`}>Manage</Link>}</li>)}
        </ul>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api("/api/orgs", { body: org }));
            if (r) router.push(`/org/${r.org.slug}`);
          }}
        >
          <input aria-label="Organization name" placeholder="Organization name" value={org.name} onChange={(e) => setOrg({ name: e.target.value, slug: org.slug || "" })} style={{ flex: 2 }} />
          <input aria-label="URL name" placeholder="url-name" value={org.slug} onChange={(e) => setOrg({ ...org, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} style={{ flex: 1 }} />
          <button className="small" disabled={busy || !org.name || org.slug.length < 2}>Create</button>
        </form>
      </section>

      <section className="card stack">
        <h2>Presets</h2>
        <p className="small muted">Reusable rules and invite lists. Save one from any meeting's Manage page.</p>
        {presets.data?.presets?.length ? (
          <ul className="list">
            {presets.data.presets.map((p: any) => (
              <li key={p.id} className="row spread">
                <span>{p.name} <span className="small muted">{p.settings.accessPolicy?.replace(/_/g, " ")}{p.invitationCount ? ` · ${p.invitationCount} invitees` : ""}{p.orgId ? " · shared with organization" : ""}</span></span>
                {p.mine && <button className="small danger" onClick={() => run(() => api(`/api/presets/${p.id}`, { method: "DELETE" })).then(presets.reload)}>Delete</button>}
              </li>
            ))}
          </ul>
        ) : <p className="muted small">No presets yet.</p>}
      </section>

      <section className="card stack">
        <h2>Webhooks</h2>
        <p className="small muted">We POST signed JSON to your URL when things happen (e.g. send recordings to your LMS, post summaries to your CRM). Requires a paid plan.</p>
        {secret && <Alert>Signing secret (shown once): <span className="code">{secret}</span></Alert>}
        <ul className="list">
          {hooks.data?.endpoints?.map((h: any) => (
            <li key={h.id} className="row spread">
              <span className="small"><span className="code">{h.url}</span> · {h.events.join(", ")}{h.failures ? ` · ${h.failures} failed` : ""}</span>
              <button className="small danger" onClick={() => run(() => api(`/api/account/webhooks/${h.id}`, { method: "DELETE" })).then(hooks.reload)}>Delete</button>
            </li>
          ))}
        </ul>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api("/api/account/webhooks", { body: hook }));
            if (r) {
              setSecret(r.secret);
              setHook({ ...hook, url: "" });
              hooks.reload();
            }
          }}
        >
          <input aria-label="Webhook URL" type="url" placeholder="https://example.com/meetsphere-webhook" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
          <div className="row small">
            {(hooks.data?.events ?? []).map((ev: string) => (
              <label key={ev} className="check" style={{ fontWeight: 400 }}>
                <input type="checkbox" checked={hook.events.includes(ev)} onChange={(e) => setHook({ ...hook, events: e.target.checked ? [...hook.events, ev] : hook.events.filter((x) => x !== ev) })} />
                <span>{ev}</span>
              </label>
            ))}
          </div>
          <button className="small" disabled={busy || !hook.url || !hook.events.length}>Add webhook</button>
        </form>
      </section>
      <section className="card stack">
        <h2>Your data</h2>
        <div className="row">
          <a className="btn small" href="/api/account/export">Download my data (JSON)</a>
          <button
            className="small danger"
            disabled={busy}
            onClick={async () => {
              if (prompt('This permanently deletes your account, meetings, recordings and transcripts. Type DELETE to confirm.') !== "DELETE") return;
              const r = await run(() => api("/api/account", { method: "DELETE", body: { confirm: "DELETE" } }));
              if (r) router.replace("/");
            }}
          >
            Delete my account
          </button>
        </div>
      </section>
    </main>
  );
}

export default function Page() {
  return <Suspense><Account /></Suspense>;
}

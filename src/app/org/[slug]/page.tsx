"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, Check, Spinner, Tabs, useAction, useApi } from "@/components/ui";
import { api } from "@/lib/client";

type Tab = "general" | "members" | "sso" | "billing" | "webhooks";

export default function OrgAdmin() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const org = useApi<any>(`/api/orgs/${slug}`);
  const [tab, setTab] = useState<Tab>("general");
  useEffect(() => {
    if (org.error?.status === 401) router.replace(`/signin?next=/org/${slug}`);
  }, [org.error, router, slug]);
  if (org.error) return <main className="container"><Alert kind="error">{org.error.message}</Alert></main>;
  if (!org.data) return <main className="container"><Spinner /></main>;
  if (org.data.role === "member") return <main className="container"><AppHeader /><Alert>Only organization admins can manage {org.data.org.name}.</Alert></main>;
  return (
    <main className="container wide stack">
      <AppHeader />
      <h1>{org.data.org.name}</h1>
      <Tabs<Tab> tabs={[["general", "General"], ["members", "Members"], ["sso", "Single sign-on"], ["billing", "Plan & usage"], ["webhooks", "Webhooks"]]} value={tab} onChange={setTab} />
      {tab === "general" && <General slug={slug} data={org.data} reload={org.reload} />}
      {tab === "members" && <Members slug={slug} myRole={org.data.role} />}
      {tab === "sso" && <Sso slug={slug} enforced={org.data.org.ssoEnforced} reload={org.reload} />}
      {tab === "billing" && <Billing slug={slug} account={org.data.account} />}
      {tab === "webhooks" && <OrgWebhooks slug={slug} />}
    </main>
  );
}

function General({ slug, data, reload }: { slug: string; data: any; reload: () => void }) {
  const o = data.org;
  const [b, setB] = useState({ displayName: o.branding.displayName ?? "", logoUrl: o.branding.logoUrl ?? "", accentColor: o.branding.accentColor ?? "", welcomeText: o.branding.welcomeText ?? "" });
  const [domains, setDomains] = useState((o.allowedEmailDomains ?? []).join(", "));
  const [retention, setRetention] = useState<string>(o.retentionDays ? String(o.retentionDays) : "");
  const d = o.defaultMeetingSettings ?? {};
  const [defaults, setDefaults] = useState({ accessPolicy: d.accessPolicy ?? "host_approval", allowNameOnlyRequests: d.allowNameOnlyRequests ?? true, chatEnabled: d.chatEnabled ?? true, allowScreenShare: d.allowScreenShare ?? true, qaModerated: d.qaModerated ?? false });
  const { busy, error, notice, run } = useAction();
  const save = (body: object) => run(() => api(`/api/orgs/${slug}`, { method: "PATCH", body }), "Saved").then(reload);
  return (
    <div className="grid2">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      <section className="card stack">
        <h2>Branding</h2>
        <p className="small muted">Shown on your organization's meeting pages (Pro plan and above).</p>
        <label htmlFor="bn">Display name</label><input id="bn" value={b.displayName} onChange={(e) => setB({ ...b, displayName: e.target.value })} />
        <label htmlFor="bl">Logo URL (https)</label><input id="bl" value={b.logoUrl} onChange={(e) => setB({ ...b, logoUrl: e.target.value })} />
        <label htmlFor="bc">Accent color</label><input id="bc" value={b.accentColor} onChange={(e) => setB({ ...b, accentColor: e.target.value })} placeholder="#2456d6" />
        <label htmlFor="bw">Welcome text</label><textarea id="bw" rows={2} value={b.welcomeText} onChange={(e) => setB({ ...b, welcomeText: e.target.value })} />
        <button className="small" disabled={busy} onClick={() => save({ branding: Object.fromEntries(Object.entries(b).filter(([, v]) => v)) })}>Save branding</button>
      </section>
      <section className="card stack">
        <h2>Default meeting rules</h2>
        <select aria-label="Default access" value={defaults.accessPolicy} onChange={(e) => setDefaults({ ...defaults, accessPolicy: e.target.value })}>
          <option value="host_approval">Everyone waits for approval</option>
          <option value="invited_only">Invited only</option>
          <option value="verified_only">Verified phone/email only</option>
          <option value="anyone_with_link">Anyone with the link</option>
        </select>
        <Check checked={defaults.allowNameOnlyRequests} onChange={(v) => setDefaults({ ...defaults, allowNameOnlyRequests: v })} label="Allow name-only requests" />
        <Check checked={defaults.chatEnabled} onChange={(v) => setDefaults({ ...defaults, chatEnabled: v })} label="Chat" />
        <Check checked={defaults.allowScreenShare} onChange={(v) => setDefaults({ ...defaults, allowScreenShare: v })} label="Participant screen share" />
        <Check checked={defaults.qaModerated} onChange={(v) => setDefaults({ ...defaults, qaModerated: v })} label="Moderated Q&A" />
        <button className="small" disabled={busy} onClick={() => save({ defaultMeetingSettings: defaults })}>Save defaults</button>
      </section>
      <section className="card stack">
        <h2>Membership & data</h2>
        <label htmlFor="dom">Auto-join email domains</label>
        <input id="dom" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.org, school.edu" />
        <p className="small muted">People who sign in with a verified email at these domains join as members.</p>
        <button className="small" disabled={busy} onClick={() => save({ allowedEmailDomains: domains.split(",").map((x: string) => x.trim()).filter(Boolean) })}>Save domains</button>
        <label htmlFor="ret">Delete meeting content (recordings, transcripts, names) after</label>
        <select id="ret" value={retention} onChange={(e) => setRetention(e.target.value)}>
          <option value="">Keep until deleted</option>
          {[7, 30, 90, 180, 365, 730].map((n) => <option key={n} value={n}>{n} days</option>)}
        </select>
        <button className="small" disabled={busy} onClick={() => save({ retentionDays: retention ? Number(retention) : null })}>Save retention</button>
      </section>
    </div>
  );
}

function Members({ slug, myRole }: { slug: string; myRole: string }) {
  const m = useApi<any>(`/api/orgs/${slug}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const { busy, error, notice, run } = useAction();
  const change = (userId: string, r: string | null) => run(() => api(`/api/orgs/${slug}/members`, { method: "PATCH", body: { userId, role: r } })).then(m.reload);
  return (
    <section className="card stack">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api(`/api/orgs/${slug}/members`, { body: { email, role } }), "Added");
          if (r) {
            setEmail("");
            m.reload();
          }
        }}
      >
        <input aria-label="Email" type="email" placeholder="colleague@example.org" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 2 }} />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1 }}><option value="member">Member</option><option value="admin">Admin</option></select>
        <button className="small" disabled={busy || !email}>Add</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Contact</th><th>Role</th><th /></tr></thead>
          <tbody>
            {m.data?.members?.map((x: any) => (
              <tr key={x.user_id}>
                <td>{x.display_name}</td>
                <td className="small">{x.email ?? x.phone_e164}</td>
                <td>
                  <select aria-label={`Role of ${x.display_name}`} value={x.role} onChange={(e) => change(x.user_id, e.target.value)} disabled={busy || (x.role === "owner" && myRole !== "owner")}>
                    <option value="member">Member</option><option value="admin">Admin</option>{myRole === "owner" && <option value="owner">Owner</option>}
                  </select>
                </td>
                <td><button className="small danger" disabled={busy} onClick={() => confirm(`Remove ${x.display_name}?`) && change(x.user_id, null)}>Remove</button></td>
              </tr>
            ))}
            {m.data?.invites?.map((x: any) => (
              <tr key={x.email}><td className="muted">Invited</td><td className="small">{x.email}</td><td>{x.role}</td><td className="small muted">Joins on first sign-in</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Sso({ slug, enforced, reload }: { slug: string; enforced: boolean; reload: () => void }) {
  const s = useApi<any>(`/api/orgs/${slug}/sso`);
  const [f, setF] = useState<any>(null);
  const { busy, error, notice, run } = useAction();
  useEffect(() => {
    if (s.data) setF({ issuer: s.data.sso?.issuer ?? "", clientId: s.data.sso?.clientId ?? "", clientSecret: "", emailDomains: (s.data.sso?.emailDomains ?? []).join(", "), enabled: s.data.sso?.enabled ?? true });
  }, [s.data]);
  if (!f) return <Spinner />;
  return (
    <section className="card stack">
      <p className="small muted">OpenID Connect (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak…). Enterprise plan. Register this redirect URI with your provider:</p>
      <p className="code small">{s.data.redirectUri}</p>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      <label htmlFor="iss">Issuer URL</label><input id="iss" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder="https://login.microsoftonline.com/<tenant>/v2.0" />
      <label htmlFor="cid">Client ID</label><input id="cid" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
      <label htmlFor="cs">Client secret</label><input id="cs" type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} placeholder={s.data.sso ? "(unchanged)" : ""} />
      <label htmlFor="ed">Allowed email domains</label><input id="ed" value={f.emailDomains} onChange={(e) => setF({ ...f, emailDomains: e.target.value })} placeholder="example.org" />
      <Check checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" />
      <button
        className="small primary"
        disabled={busy}
        onClick={() =>
          run(
            () => api(`/api/orgs/${slug}/sso`, { method: "PUT", body: { ...f, clientSecret: f.clientSecret || undefined, emailDomains: f.emailDomains.split(",").map((x: string) => x.trim()).filter(Boolean) } }),
            "Saved",
          ).then(s.reload)
        }
      >
        Save
      </button>
      {s.data.sso && <a className="btn small" href={`/api/auth/sso/start?org=${slug}&next=/org/${slug}`}>Test sign-in</a>}
      <Check
        checked={enforced}
        onChange={(v) => run(() => api(`/api/orgs/${slug}`, { method: "PATCH", body: { ssoEnforced: v } }), "Saved").then(reload)}
        label="Require SSO for these domains (email codes are refused)"
      />
    </section>
  );
}

function Billing({ slug, account }: { slug: string; account: any }) {
  const { busy, error, run } = useAction();
  const go = async (path: string, body: object) => {
    const r = await run(() => api(path, { body }));
    if (r?.url) window.location.href = r.url;
  };
  return (
    <section className="card stack">
      <h2>Plan: {account.plan.name}</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="grid2">
        {Object.entries(account.usage).map(([k, v]) => <div key={k} className="stat"><span className="small muted">{k.replace(/_/g, " ")} this month</span><b>{(v as number).toLocaleString()}</b></div>)}
      </div>
      <div className="row">
        {account.plan.id === "free" && <button className="primary" disabled={busy} onClick={() => go("/api/billing/checkout", { plan: "pro", org: slug })}>Upgrade to Pro</button>}
        {account.plan.id !== "business" && account.plan.id !== "enterprise" && <button disabled={busy} onClick={() => go("/api/billing/checkout", { plan: "business", org: slug })}>Upgrade to Business</button>}
        {account.billing?.hasCustomer && <button disabled={busy} onClick={() => go("/api/billing/portal", { org: slug })}>Manage billing</button>}
      </div>
      <p className="small muted">Enterprise (SSO, dedicated capacity, custom limits): contact sales.</p>
    </section>
  );
}

function OrgWebhooks({ slug }: { slug: string }) {
  const h = useApi<any>(`/api/orgs/${slug}/webhooks`);
  const events = useApi<any>("/api/account/webhooks");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <section className="card stack">
      {error && <Alert kind="error">{error}</Alert>}
      {secret && <Alert>Signing secret (shown once): <span className="code">{secret}</span></Alert>}
      <ul className="list">
        {h.data?.endpoints?.map((x: any) => (
          <li key={x.id} className="row spread">
            <span className="small code">{x.url}</span>
            <button className="small danger" onClick={() => run(() => api(`/api/orgs/${slug}/webhooks`, { method: "DELETE", body: { id: x.id } })).then(h.reload)}>Delete</button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(() => api(`/api/orgs/${slug}/webhooks`, { body: { url, events: events.data?.events ?? [] } }));
          if (r) {
            setSecret(r.secret);
            setUrl("");
            h.reload();
          }
        }}
      >
        <input aria-label="Webhook URL" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" style={{ flex: 1 }} />
        <button className="small" disabled={busy || !url}>Add (all events)</button>
      </form>
    </section>
  );
}

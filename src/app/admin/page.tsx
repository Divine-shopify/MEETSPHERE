"use client";

import { useState } from "react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, Spinner, useAction, useApi } from "@/components/ui";
import { api } from "@/lib/client";

/** Platform operations: usage, abuse reports, manual plan changes. */
export default function Admin() {
  const overview = useApi<any>("/api/admin");
  const reports = useApi<any>("/api/admin/reports");
  const [plan, setPlan] = useState({ target: "", plan: "enterprise" });
  const { busy, error, notice, run } = useAction();
  if (overview.error) return <main className="container"><AppHeader /><Alert kind="error">{overview.error.message}</Alert></main>;
  if (!overview.data) return <main className="container"><Spinner /></main>;
  const t = overview.data.totals;
  return (
    <main className="container wide stack">
      <AppHeader />
      <h1>Platform admin</h1>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      <section className="grid2">
        {Object.entries(t).map(([k, v]) => <div key={k} className="stat"><span className="small muted">{k.replace(/_/g, " ")}</span><b>{(v as number).toLocaleString()}</b></div>)}
      </section>
      <section className="card stack">
        <h2>Usage this month</h2>
        <div className="grid2">{Object.entries(overview.data.usageThisMonth).map(([k, v]) => <div key={k} className="stat"><span className="small muted">{k}</span><b>{(v as number).toLocaleString()}</b></div>)}</div>
        <h3>Top hosts by participant-minutes</h3>
        <ul className="list">{overview.data.topHosts.map((h: any, i: number) => <li key={i}>{h.display_name} <span className="muted small">{h.email}</span> · {h.minutes.toLocaleString()}</li>)}</ul>
      </section>
      <section className="card stack">
        <h2>Abuse reports</h2>
        <ul className="list">
          {reports.data?.reports?.map((r: any) => (
            <li key={r.id} className="stack" style={{ gap: 4 }}>
              <div><strong>{r.reason.replace(/_/g, " ")}</strong> <span className="badge">{r.status}</span> · {r.meeting_title} (<span className="code">{r.meeting_code}</span>) · host {r.host_name} {r.host_email}</div>
              {r.target_name && <div className="small">About: {r.target_name}</div>}
              {r.details && <div className="small">{r.details}</div>}
              <div className="row">
                {["reviewed", "actioned"].map((s) => <button key={s} className="small" disabled={busy || r.status === s} onClick={() => run(() => api("/api/admin/reports", { method: "PATCH", body: { id: r.id, status: s } })).then(reports.reload)}>Mark {s}</button>)}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card stack">
        <h2>Set a plan manually</h2>
        <p className="small muted">For contracts invoiced outside Stripe. Enter a user's email or an organization's URL name.</p>
        <div className="row">
          <input aria-label="Email or org" value={plan.target} onChange={(e) => setPlan({ ...plan, target: e.target.value })} placeholder="person@example.com or org-slug" style={{ flex: 2 }} />
          <select aria-label="Plan" value={plan.plan} onChange={(e) => setPlan({ ...plan, plan: e.target.value })} style={{ flex: 1 }}>
            {["free", "pro", "business", "enterprise"].map((p) => <option key={p}>{p}</option>)}
          </select>
          <button
            className="small"
            disabled={busy || !plan.target}
            onClick={() => run(() => api("/api/admin/accounts", { body: plan.target.includes("@") ? { email: plan.target, plan: plan.plan } : { orgSlug: plan.target, plan: plan.plan } }), "Plan updated")}
          >
            Apply
          </button>
        </div>
      </section>
    </main>
  );
}

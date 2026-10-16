"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badges } from "@/components/Badges";
import { DevicePreview, type DeviceChoices } from "@/components/DevicePreview";
import { OtpForm } from "@/components/OtpForm";
import { api, ApiError } from "@/lib/client";

const Room = dynamic(() => import("@/components/Room"), { ssr: false, loading: () => <p className="container">Connecting…</p> });

type Method = "phone" | "email" | "name";
const METHOD_LABEL: Record<Method, string> = { phone: "Phone number", email: "Email", name: "Just my name" };

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const [data, setData] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [verifiedNow, setVerifiedNow] = useState<Partial<Record<Method, string>>>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<{ token: string; url: string; role: string; settings: any; choices: DeviceChoices } | null>(null);
  const [left, setLeft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/meetings/${code}`);
      setData(d);
      return d;
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? "This meeting link isn't valid. Check the code with the host." : (err as Error).message);
    }
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  // Waiting room: poll for the host's decision (also after a rejection/removal, in case the host lets them back in).
  const status = data?.myRequest?.status;
  useEffect(() => {
    if (status !== "pending" && status !== "rejected" && status !== "removed") return;
    const t = setInterval(async () => {
      try {
        const r = await api(`/api/meetings/${code}/join`);
        if (r.request?.status !== status) load();
      } catch {
        /* keep polling; transient network errors are expected on mobile */
      }
    }, status === "pending" ? 3000 : 6000);
    return () => clearInterval(t);
  }, [status, code, load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!method) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/meetings/${code}/join`, { body: { name, method } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function connect(choices: DeviceChoices) {
    setError(null);
    setBusy(true);
    try {
      const t = await api(`/api/meetings/${code}/token`, { body: {} });
      setLeft(null);
      setMedia({ ...t, choices });
    } catch (err) {
      setError((err as Error).message);
      load();
    } finally {
      setBusy(false);
    }
  }

  if (media) {
    return (
      <Room
        code={code}
        title={data.meeting.title}
        token={media.token}
        serverUrl={media.url}
        role={media.role}
        choices={media.choices}
        onLeave={(reason) => {
          setMedia(null);
          setLeft(reason);
          load();
        }}
      />
    );
  }

  if (loadError) return <main className="container"><div className="card"><h1>Can't open meeting</h1><p>{loadError}</p><Link href="/">Home</Link></div></main>;
  if (!data) return <main className="container"><span className="spinner" aria-label="Loading" /></main>;

  const m = data.meeting;
  const modes = data.services.verification;
  const isHost = !!data.host;
  const req = data.myRequest;
  const methods: Method[] = m.allowedMethods.filter((x: Method) => x === "name" || modes[x] !== "unavailable");
  const alreadyVerified = (x: Method) => verifiedNow[x] ?? (x === "phone" ? data.myVerified.phone : x === "email" ? data.myVerified.email : null);
  const canPublishByDefault = m.mode === "interactive" || isHost;

  return (
    <main className="container stack">
      <header className="row spread">
        <Link href="/"><strong>MeetSphere</strong></Link>
        {isHost && <Link href={`/m/${code}/manage`}>Manage</Link>}
      </header>
      <section className="card stack">
        <div>
          <h1>{m.title}</h1>
          <p className="muted small">
            Hosted by {m.hostName} · {m.accessPolicyLabel}
            {m.mode === "broadcast" ? " · Presentation" : ""}
            {m.scheduledAt ? ` · ${new Date(m.scheduledAt).toLocaleString()}` : ""}
          </p>
        </div>
        {left && <div className="alert info" role="status">{left}</div>}
        {!data.services.media && (
          <div className="alert error">Audio/video is not configured on this server yet, so the meeting room can't connect.</div>
        )}

        {m.ended ? (
          <p>This meeting has ended.</p>
        ) : isHost ? (
          <>
            <p>You're the host.</p>
            <DevicePreview canPublish onJoin={connect} joinLabel={busy ? "Connecting…" : "Start / join as host"} />
          </>
        ) : req?.status === "admitted" ? (
          <>
            <p className="row">You're in as <strong>{req.name}</strong> <Badges badges={req.badges} /></p>
            <DevicePreview canPublish={canPublishByDefault} onJoin={connect} joinLabel={busy ? "Connecting…" : "Join now"} />
          </>
        ) : req?.status === "pending" ? (
          <div className="stack" aria-live="polite">
            <div className="row"><span className="spinner" aria-hidden /> <strong>Waiting for the host to let you in…</strong></div>
            <p className="muted small">Keep this page open. You asked to join as {req.name} <Badges badges={req.badges} /></p>
          </div>
        ) : req?.status === "rejected" ? (
          <div className="alert error" role="alert">The host declined your request to join.</div>
        ) : req?.status === "removed" ? (
          <div className="alert error" role="alert">The host removed you from this meeting. Ask the host if you think this was a mistake.</div>
        ) : req?.status === "blocked" ? (
          <div className="alert error" role="alert">The host removed you from this meeting.</div>
        ) : m.locked ? (
          <div className="alert error" role="alert">The host has locked this meeting. No one new can join right now.</div>
        ) : (
          <div className="stack">
            <h2>How do you want to join?</h2>
            {methods.length === 0 ? (
              <div className="alert error">This meeting requires phone or email verification, which isn't configured on this server.</div>
            ) : (
              <div className="segmented" role="group" aria-label="Join method">
                {methods.map((x) => (
                  <button key={x} type="button" aria-pressed={method === x} onClick={() => setMethod(x)}>{METHOD_LABEL[x]}</button>
                ))}
              </div>
            )}
            {method === "name" && m.accessPolicy !== "anyone_with_link" && (
              <p className="small muted">The host will see that you only typed a name (not verified) and decide whether to let you in.</p>
            )}
            {(method === "phone" || method === "email") && !alreadyVerified(method) && (
              <OtpForm
                key={method}
                startPath={`/api/meetings/${code}/verify/start`}
                checkPath={`/api/meetings/${code}/verify/check`}
                modes={modes}
                channels={[method]}
                onVerified={(r, ch) => setVerifiedNow((v) => ({ ...v, [ch]: r.verified.contact }))}
              />
            )}
            {method && (method === "name" || alreadyVerified(method)) && (
              <form onSubmit={submit} className="stack">
                {method !== "name" && <p className="small">Verified: <strong>{alreadyVerified(method)}</strong></p>}
                <div>
                  <label htmlFor="name">Your name</label>
                  <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} />
                </div>
                <button className="primary" type="submit" disabled={busy || !name.trim()}>
                  {busy ? <span className="spinner" aria-hidden /> : null} Ask to join
                </button>
              </form>
            )}
          </div>
        )}
        {error && <div className="alert error" role="alert">{error}</div>}
      </section>
    </main>
  );
}

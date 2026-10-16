"use client";

import { useState } from "react";
import { api } from "@/lib/client";

type Channel = "phone" | "email";
type Mode = "provider" | "dev" | "unavailable";

interface Props {
  /** Endpoint prefix: "/api/auth" for sign-in or "/api/meetings/<code>/verify" for joining. */
  startPath: string;
  checkPath: string;
  modes: Record<Channel, Mode>;
  channels?: Channel[];
  initialChannel?: Channel;
  extraCheckBody?: () => Record<string, unknown>;
  submitLabel?: string;
  onVerified: (result: any, channel: Channel) => void;
}

export function OtpForm({ startPath, checkPath, modes, channels = ["phone", "email"], initialChannel, extraCheckBody, submitLabel, onVerified }: Props) {
  const usable = channels.filter((c) => modes[c] !== "unavailable");
  const [channel, setChannel] = useState<Channel>(initialChannel && usable.includes(initialChannel) ? initialChannel : usable[0] ?? "phone");
  const [destination, setDestination] = useState("");
  const [challenge, setChallenge] = useState<{ challengeId: string; maskedDestination: string; delivery: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (usable.length === 0) {
    return (
      <div className="alert error" role="alert">
        Phone and email verification are not configured on this server. Ask the administrator to set up an SMS or email provider.
      </div>
    );
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(startPath, { body: { channel, destination } });
      setChallenge(r);
      setCode("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api(checkPath, { body: { challengeId: challenge.challengeId, code, ...(extraCheckBody?.() ?? {}) } });
      onVerified(r, channel);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {!challenge ? (
        <form onSubmit={send} className="stack">
          {usable.length > 1 && (
            <div className="segmented" role="group" aria-label="Verification method">
              {usable.map((c) => (
                <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>
                  {c === "phone" ? "Phone" : "Email"}
                </button>
              ))}
            </div>
          )}
          <div>
            <label htmlFor="otp-dest">{channel === "phone" ? "Mobile number (with country code)" : "Email address"}</label>
            <input
              id="otp-dest"
              type={channel === "phone" ? "tel" : "email"}
              inputMode={channel === "phone" ? "tel" : "email"}
              autoComplete={channel === "phone" ? "tel" : "email"}
              placeholder={channel === "phone" ? "+44 7911 123456" : "you@example.com"}
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              required
            />
          </div>
          {modes[channel] === "dev" && (
            <div className="alert dev">DEV MODE: no {channel === "phone" ? "text message" : "email"} will be sent. The code will be shown on screen.</div>
          )}
          <button className="primary" type="submit" disabled={busy || !destination.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : null} Send code
          </button>
        </form>
      ) : (
        <form onSubmit={check} className="stack">
          <p>
            {challenge.delivery === "dev" ? "Code generated for" : "We sent a 6-digit code to"} <strong>{challenge.maskedDestination}</strong>.
          </p>
          {challenge.delivery === "dev" && (
            <div className="alert dev" role="status">
              DEV MODE - no message sent. Your code is <span className="code">{challenge.devCode}</span>
            </div>
          )}
          <div>
            <label htmlFor="otp-code">Verification code</label>
            <input
              id="otp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
            />
          </div>
          <button className="primary" type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6}>
            {busy ? <span className="spinner" aria-hidden /> : null} {submitLabel ?? "Verify"}
          </button>
          <div className="row">
            <button type="button" className="small" onClick={() => send()} disabled={busy}>
              Resend code
            </button>
            <button type="button" className="small" onClick={() => setChallenge(null)} disabled={busy}>
              Use a different {channel === "phone" ? "number" : "address"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

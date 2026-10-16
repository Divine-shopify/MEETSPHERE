"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<{ user: { displayName: string } | null } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api("/api/me").then(setMe, () => setMe({ user: null }));
  }, []);

  function join(e: React.FormEvent) {
    e.preventDefault();
    const raw = code.trim().toLowerCase();
    const fromUrl = raw.match(/\/m\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1];
    const c = fromUrl ?? raw.replace(/[^a-z]/g, "").replace(/^(.{3})(.{4})(.{3})$/, "$1-$2-$3");
    if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(c)) {
      setError("Enter a meeting code like abc-defg-hij, or paste the meeting link.");
      return;
    }
    router.push(`/m/${c}`);
  }

  return (
    <main className="container stack">
      <header className="row spread">
        <strong>MeetSphere</strong>
        {me?.user ? (
          <Link href="/dashboard">My meetings</Link>
        ) : (
          <Link href="/signin">Sign in to host</Link>
        )}
      </header>
      <section className="card stack">
        <h1>Meetings where you decide who gets in</h1>
        <p className="muted">
          Invite people by link, phone or email. Guests join from their phone browser, no app needed. You see who verified their number,
          who was invited, and who only typed a name.
        </p>
        <div className="row">
          <Link className="btn primary" href={me?.user ? "/dashboard" : "/signin?next=/dashboard"}>
            Host a meeting
          </Link>
        </div>
      </section>
      <section className="card">
        <form onSubmit={join} className="stack">
          <label htmlFor="code">Join with a code or link</label>
          <input id="code" placeholder="abc-defg-hij" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" />
          {error && <div className="alert error" role="alert">{error}</div>}
          <button type="submit" disabled={!code.trim()}>
            Join
          </button>
        </form>
      </section>
      <p className="small muted">
        Free meetings have no time limit in MeetSphere itself. Fair-use, capacity and media-provider limits still apply.
      </p>
    </main>
  );
}

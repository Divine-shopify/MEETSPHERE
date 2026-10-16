"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { OtpForm } from "@/components/OtpForm";
import { api } from "@/lib/client";

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next")?.startsWith("/") && !params.get("next")?.startsWith("//") ? params.get("next")! : "/dashboard";
  const [modes, setModes] = useState<any>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    api("/api/me").then((me) => {
      if (me.user) router.replace(next);
      else setModes(me.services.verification);
    });
  }, [router, next]);

  return (
    <main className="container">
      <div className="card stack">
        <h1>Sign in to host</h1>
        <p className="muted">We'll text or email you a one-time code. No password needed.</p>
        <div>
          <label htmlFor="name">Your name (shown to attendees)</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="e.g. Pastor Ade, Ms. Rivera" />
          <p className="small muted">Only used when creating a new account.</p>
        </div>
        {modes ? (
          <OtpForm
            startPath="/api/auth/start"
            checkPath="/api/auth/verify"
            modes={modes}
            submitLabel="Sign in"
            extraCheckBody={() => ({ displayName: name || undefined })}
            onVerified={() => router.replace(next)}
          />
        ) : (
          <span className="spinner" aria-label="Loading" />
        )}
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}

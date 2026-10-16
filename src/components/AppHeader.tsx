"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function AppHeader({ name }: { name?: string }) {
  const router = useRouter();
  return (
    <header className="row spread">
      <Link href="/dashboard"><strong>MeetSphere</strong></Link>
      <nav className="row small" aria-label="Main">
        <Link href="/dashboard">Meetings</Link>
        <Link href="/search">Search</Link>
        <Link href="/account">Account</Link>
        {name && <span className="muted hide-mobile">{name}</span>}
        <button
          className="small"
          onClick={async () => {
            await api("/api/auth/signout", { body: {} });
            router.replace("/");
          }}
        >
          Sign out
        </button>
      </nav>
    </header>
  );
}

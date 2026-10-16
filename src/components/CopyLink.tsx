"use client";

import { useState } from "react";

export function CopyLink({ code, title }: { code: string; title?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const url = typeof window === "undefined" ? `/m/${code}` : `${window.location.origin}/m/${code}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("Link copied");
    } catch {
      setCopied("Copy failed. Select the link and copy it manually.");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  async function share() {
    try {
      await navigator.share({ title: title ?? "MeetSphere meeting", text: `Join "${title ?? "my meeting"}" on MeetSphere`, url });
    } catch {
      // user cancelled
    }
  }

  return (
    <div className="stack">
      <input readOnly value={url} aria-label="Meeting link" onFocus={(e) => e.currentTarget.select()} className="code" />
      <div className="row">
        <button type="button" className="small" onClick={copy}>
          Copy link
        </button>
        {typeof navigator !== "undefined" && "share" in navigator && (
          <button type="button" className="small" onClick={share}>
            Share…
          </button>
        )}
        <span role="status" className="small muted">
          {copied}
        </span>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { PollsPanel } from "@/components/PollsPanel";
import { QAPanel } from "@/components/QAPanel";
import { Tabs } from "@/components/ui";
import { api } from "@/lib/client";
import { useMeetingEvents } from "@/lib/useMeetingEvents";

/**
 * Large-audience viewing: plays the meeting's HLS stream (one-to-many, CDN
 * friendly) instead of joining the WebRTC room. Q&A and polls stay interactive.
 */
export default function Watch() {
  const { code } = useParams<{ code: string }>();
  const video = useRef<HTMLVideoElement>(null);
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<"loading" | "waiting" | "playing" | "ended" | "denied" | "error">("loading");
  const [tab, setTab] = useState<"qa" | "polls">("qa");
  const [versions, setVersions] = useState({ qa: 0, polls: 0 });
  const [caption, setCaption] = useState<{ speaker: string; text: string } | null>(null);
  const [needsTap, setNeedsTap] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/meetings/${code}`);
      setData(d);
      if (d.viewer.kind === "none") setState("denied");
      else if (d.meeting.ended) setState("ended");
      else if (!d.liveStreamId) setState("waiting");
    } catch {
      setState("error");
    }
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  useMeetingEvents(code, {
    stream_changed: () => load(),
    meeting_ended: () => setState("ended"),
    qa_changed: () => setVersions((v) => ({ ...v, qa: v.qa + 1 })),
    polls_changed: () => setVersions((v) => ({ ...v, polls: v.polls + 1 })),
    caption: (d) => {
      setCaption(d);
      setTimeout(() => setCaption((c) => (c === d ? null : c)), 6000);
    },
  });

  const streamId = data?.liveStreamId as string | null;
  useEffect(() => {
    if (!streamId || !video.current) return;
    const src = `/api/meetings/${code}/stream/${streamId}/live.m3u8`;
    const el = video.current;
    let hls: any = null;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    // Browsers block autoplay with sound: start muted, then offer "Tap to unmute".
    const play = () => {
      el.muted = true;
      el.play().then(() => {
        setState("playing");
        setNeedsTap(true);
      }, () => setNeedsTap(true));
    };
    (async () => {
      // The playlist appears a few seconds after the stream starts.
      for (let i = 0; i < 30 && !cancelled; i++) {
        const r = await fetch(src, { cache: "no-store" });
        if (r.ok && (await r.text()).includes("#EXTINF")) break;
        setState("waiting");
        await new Promise((res) => (retry = setTimeout(res, 2000)));
      }
      if (cancelled) return;
      const Hls = (await import("hls.js")).default;
      if (Hls.isSupported()) {
        hls = new Hls({ liveSyncDurationCount: 3, lowLatencyMode: false });
        hls.loadSource(src);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          el.dataset.hls = "manifest";
          play();
        });
        hls.on(Hls.Events.MANIFEST_LOADED, () => (el.dataset.manifestLoaded = "1"));
        hls.on(Hls.Events.FRAG_LOADED, () => (el.dataset.fragments = String(Number(el.dataset.fragments ?? 0) + 1)));
        hls.on(Hls.Events.ERROR, (_: unknown, d: any) => {
          el.dataset.hlsError = d.details;
          if (d.details === "manifestIncompatibleCodecsError") return setState("error");
          if (d.fatal) {
            if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else setState("error");
          }
        });
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = src; // Safari / iOS play HLS natively
        el.addEventListener("loadedmetadata", play, { once: true });
      } else setState("error");
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      hls?.destroy();
    };
  }, [streamId, code]);

  const f = data?.meeting?.features ?? {};
  return (
    <main className="room" style={{ position: "fixed" }}>
      <div className="room-top">
        <div className="room-title">{data?.meeting?.title ?? "Live stream"}</div>
        <div className="row">
          {state === "playing" && <span className="badge">🔴 Live</span>}
          <Link className="btn small" href={`/m/${code}`}>Back</Link>
        </div>
      </div>
      <div className="room-body">
        <div className="room-stage" style={{ position: "relative", justifyContent: "center", background: "#000" }}>
          <video ref={video} controls playsInline style={{ width: "100%", maxHeight: "100%", background: "#000" }} aria-label="Live stream" />
          {state !== "playing" && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#cfd5df", textAlign: "center", padding: 16 }}>
              {state === "loading" && "Loading…"}
              {state === "waiting" && "Waiting for the stream to start…"}
              {state === "ended" && "The meeting has ended."}
              {state === "denied" && <span>You need to be admitted to watch. <Link href={`/m/${code}`}>Join the meeting</Link></span>}
              {state === "error" && "This browser can't play the stream. Try Chrome, Edge, Firefox or Safari."}
            </div>
          )}
          {needsTap && (
            <button
              className="primary"
              style={{ position: "absolute", bottom: 72, left: "50%", transform: "translateX(-50%)" }}
              onClick={() => {
                const el = video.current;
                if (!el) return;
                el.muted = false;
                el.play().then(() => {
                  setNeedsTap(false);
                  setState("playing");
                }, () => {});
              }}
            >
              🔊 Tap to unmute
            </button>
          )}
          {caption && <div className="captions"><b>{caption.speaker}:</b> {caption.text}</div>}
        </div>
        {(f.qa || f.polls) && state !== "denied" && (
          <aside className="room-side" style={{ position: "relative", inset: "auto" }}>
            <div className="room-side-body">
              <Tabs tabs={[...(f.qa ? [["qa", "Q&A"]] : []), ...(f.polls ? [["polls", "Polls"]] : [])] as Array<["qa" | "polls", string]>} value={tab} onChange={setTab} />
              {tab === "qa" && f.qa && <QAPanel code={code} moderator={false} version={versions.qa} allowAnonymous={!!f.qaAnonymous} moderated={!!f.qaModerated} />}
              {tab === "polls" && f.polls && <PollsPanel code={code} moderator={false} version={versions.polls} />}
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}

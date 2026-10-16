"use client";

import { useEffect, useRef, useState } from "react";

export interface DeviceChoices {
  audio: boolean;
  video: boolean;
}

function describe(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera/microphone permission was blocked. Allow access in your browser's site settings, or join with them off.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera or microphone was found.";
  if (name === "NotReadableError") return "Your camera or microphone is in use by another app.";
  if (typeof navigator !== "undefined" && !navigator.mediaDevices) {
    return "This browser can't access a camera or microphone here (a secure https:// connection is required).";
  }
  return "Couldn't start your camera or microphone.";
}

/** Local camera/mic check before connecting. Nothing is sent to the server from here. */
export function DevicePreview({ canPublish, onJoin, joinLabel }: { canPublish: boolean; onJoin: (c: DeviceChoices) => void; joinLabel: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audio, setAudio] = useState(true);
  const [video, setVideo] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lowData, setLowData] = useState(false);

  useEffect(() => {
    if (!canPublish || (!audio && !video)) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    navigator.mediaDevices
      ?.getUserMedia({ audio, video: video ? { facingMode: "user", width: { ideal: 640 } } : false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = video ? s : null;
      })
      .catch((err) => !cancelled && setError(describe(err)));
    if (!navigator.mediaDevices) setError(describe(null));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [audio, video, canPublish]);

  if (!canPublish) {
    return (
      <div className="stack">
        <p className="muted">You'll join as an audience member: you can watch, listen, chat and raise your hand. The host can invite you to speak.</p>
        <button className="primary" onClick={() => onJoin({ audio: false, video: false })}>{joinLabel}</button>
      </div>
    );
  }

  return (
    <div className="stack">
      <div style={{ background: "#000", borderRadius: 12, aspectRatio: "4 / 3", maxHeight: 320, overflow: "hidden", display: "grid", placeItems: "center" }}>
        {video ? (
          <video ref={videoRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }} />
        ) : (
          <span style={{ color: "#9aa3b2" }}>Camera off</span>
        )}
      </div>
      <div className="row">
        <button type="button" aria-pressed={audio} onClick={() => setAudio(!audio)}>{audio ? "Mic on" : "Mic off"}</button>
        <button type="button" aria-pressed={video} onClick={() => setVideo(!video)}>{video ? "Camera on" : "Camera off"}</button>
        <button
          type="button"
          aria-pressed={lowData}
          onClick={() => {
            setLowData(!lowData);
            if (!lowData) setVideo(false);
          }}
          title="Join with your camera off to save data"
        >
          Low data
        </button>
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="primary" onClick={() => onJoin({ audio, video })}>{joinLabel}</button>
    </div>
  );
}

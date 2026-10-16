"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start: () => void;
  stop: () => void;
};

function recognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
}

/**
 * Live captions. When the host turns transcription on, each person is asked
 * for consent. Only consenting people's speech is recognized, on their own
 * device (browser speech recognition), and only while their mic is on.
 */
export function Captions({ code, active, micOn, show, bus }: { code: string; active: boolean; micOn: boolean; show: boolean; bus: EventTarget }) {
  const [consent, setConsent] = useState<boolean | undefined>(undefined);
  const [line, setLine] = useState<{ speaker: string; text: string } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api(`/api/meetings/${code}/consent`).then((r) => setConsent(r.consents.transcription), () => {});
  }, [code]);

  useEffect(() => {
    const on = (e: Event) => {
      setLine((e as CustomEvent).detail);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setLine(null), 6000);
    };
    bus.addEventListener("caption", on);
    return () => bus.removeEventListener("caption", on);
  }, [bus]);

  useEffect(() => {
    const Ctor = recognitionCtor();
    if (!active || !consent || !micOn) return;
    if (!Ctor) {
      setUnsupported(true);
      return;
    }
    let stopped = false;
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const text = String(res[0].transcript).trim();
          if (text) api(`/api/meetings/${code}/captions`, { body: { text } }).catch(() => {});
        }
      }
    };
    r.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stopped = true;
        setUnsupported(true);
      }
    };
    // Browsers end recognition after silence; keep it running while captions are on.
    r.onend = () => {
      if (!stopped) setTimeout(() => !stopped && r.start(), 300);
    };
    try {
      r.start();
      rec.current = r;
    } catch {
      setUnsupported(true);
    }
    return () => {
      stopped = true;
      r.onend = null;
      r.stop();
      rec.current = null;
    };
  }, [active, consent, micOn, code]);

  async function answer(granted: boolean) {
    await api(`/api/meetings/${code}/consent`, { body: { kind: "transcription", granted } }).catch(() => {});
    setConsent(granted);
  }

  return (
    <>
      {active && consent === undefined && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cc-title">
          <div className="modal stack">
            <h2 id="cc-title">Captions and transcript are on</h2>
            <p>
              The host turned on live captions. If you agree, your browser converts what you say into text, which everyone sees as captions and the
              host keeps as a transcript. If you don't, your speech isn't transcribed and you'll still see others' captions.
            </p>
            <div className="row">
              <button className="primary" onClick={() => answer(true)}>Allow my speech</button>
              <button onClick={() => answer(false)}>Don't transcribe me</button>
            </div>
          </div>
        </div>
      )}
      {active && consent && unsupported && (
        <div className="banner warn" role="status">Your browser can't transcribe speech here (Chrome, Edge and Safari can). You'll still see others' captions.</div>
      )}
      {show && line && (
        <div className="captions" aria-live="polite">
          <b>{line.speaker}:</b> {line.text}
        </div>
      )}
    </>
  );
}

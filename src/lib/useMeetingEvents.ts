"use client";

import { useEffect, useRef } from "react";

/**
 * Subscribes to the meeting's server-sent events. The browser reconnects
 * automatically; `onReconnect` lets callers refetch state they may have missed.
 */
export function useMeetingEvents(
  code: string | null,
  handlers: Record<string, (data: any) => void>,
  opts: { enabled?: boolean; onReconnect?: () => void } = {},
) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const reconnectRef = useRef(opts.onReconnect);
  reconnectRef.current = opts.onReconnect;
  const enabled = opts.enabled ?? true;
  const types = Object.keys(handlers).sort().join(",");

  useEffect(() => {
    if (!code || !enabled || typeof EventSource === "undefined") return;
    const es = new EventSource(`/api/meetings/${code}/events`);
    let opened = false;
    es.onopen = () => {
      if (opened) reconnectRef.current?.();
      opened = true;
    };
    const listeners = types.split(",").filter(Boolean).map((type) => {
      const fn = (ev: MessageEvent) => {
        let data: any = {};
        try {
          data = JSON.parse(ev.data);
        } catch {}
        ref.current[type]?.(data);
      };
      es.addEventListener(type, fn);
      return [type, fn] as const;
    });
    return () => {
      listeners.forEach(([t, fn]) => es.removeEventListener(t, fn));
      es.close();
    };
  }, [code, enabled, types]);
}

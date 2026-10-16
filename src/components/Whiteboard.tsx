"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

interface Stroke {
  id?: number;
  tool: "pen" | "highlighter" | "eraser";
  color: string;
  width: number;
  points: Array<[number, number]>;
}

const COLORS = ["#111111", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5"];

/** Shared whiteboard. Strokes are stored server-side so late joiners see the full board. */
export function Whiteboard({ code, moderator, enabled, bus, myKey }: { code: string; moderator: boolean; enabled: boolean; bus: EventTarget; myKey: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const seen = useRef(new Set<number>());
  const current = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<Stroke["tool"]>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  // Drawing waits for the initial load so the loaded board can't overwrite a fresh stroke.
  const [ready, setReady] = useState(false);

  const draw = useCallback((ctx: CanvasRenderingContext2D, s: Stroke) => {
    const { width: w, height: h } = ctx.canvas;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = s.tool === "highlighter" ? 0.35 : 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = (s.tool === "highlighter" ? s.width * 4 : s.tool === "eraser" ? s.width * 6 : s.width) * (w / 800);
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] * w + 0.1, s.points[0][1] * h);
    ctx.stroke();
    ctx.restore();
  }, []);

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    strokes.current.forEach((s) => draw(ctx, s));
  }, [draw]);

  useEffect(() => {
    api(`/api/meetings/${code}/whiteboard`).then((r) => {
      // Keep anything drawn or received while loading.
      const known = new Set(r.strokes.map((s: Stroke) => s.id));
      strokes.current = [...r.strokes, ...strokes.current.filter((s) => !s.id || !known.has(s.id))];
      r.strokes.forEach((s: Stroke) => s.id && seen.current.add(s.id));
      redraw();
      setReady(true);
    }, (e) => setError(e.message));
    const onStroke = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (seen.current.has(d.id) || d.by === myKey) return;
      seen.current.add(d.id);
      const s = d.stroke ?? null;
      if (s) {
        strokes.current.push({ ...s, id: d.id });
        draw(canvas.current!.getContext("2d")!, s);
      }
    };
    const onClear = () => {
      strokes.current = [];
      redraw();
    };
    bus.addEventListener("wb_stroke", onStroke);
    bus.addEventListener("wb_clear", onClear);
    window.addEventListener("resize", redraw);
    return () => {
      bus.removeEventListener("wb_stroke", onStroke);
      bus.removeEventListener("wb_clear", onClear);
      window.removeEventListener("resize", redraw);
    };
  }, [code, bus, myKey, draw, redraw]);

  const point = (e: React.PointerEvent): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)];
  };
  function down(e: React.PointerEvent) {
    if (!enabled || !ready) return;
    canvas.current!.setPointerCapture(e.pointerId);
    current.current = { tool, color, width: 3, points: [point(e)] };
  }
  function move(e: React.PointerEvent) {
    const s = current.current;
    if (!s) return;
    s.points.push(point(e));
    const ctx = canvas.current!.getContext("2d")!;
    draw(ctx, { ...s, points: s.points.slice(-2) });
  }
  async function up() {
    const s = current.current;
    current.current = null;
    if (!s) return;
    // Thin out long strokes to keep payloads small.
    const step = Math.ceil(s.points.length / 1500);
    const stroke = { ...s, points: s.points.filter((_, i) => i % step === 0).map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)] as [number, number]) };
    strokes.current.push(stroke);
    try {
      const r = await api(`/api/meetings/${code}/whiteboard`, { body: stroke });
      seen.current.add(r.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      {!enabled && <p className="small muted">The host has turned the whiteboard off.</p>}
      {enabled && !ready && <p className="small muted">Loading the board…</p>}
      <div className="row" role="toolbar" aria-label="Whiteboard tools">
        {(["pen", "highlighter", "eraser"] as const).map((t) => (
          <button key={t} className="small" aria-pressed={tool === t} onClick={() => setTool(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
        {COLORS.map((c) => (
          <button key={c} className="small" aria-label={`Color ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} style={{ width: 32, padding: 0 }}>
            <span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 8, background: c }} />
          </button>
        ))}
        {moderator && <button className="small danger" onClick={() => api(`/api/meetings/${code}/whiteboard/clear`, { body: {} }).catch((e) => setError(e.message))}>Clear</button>}
      </div>
      <canvas ref={canvas} className="wb-canvas" data-ready={ready ? "1" : "0"} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Shared whiteboard" />
      {error && <div className="alert error">{error}</div>}
    </div>
  );
}

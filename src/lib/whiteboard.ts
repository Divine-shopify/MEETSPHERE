import { z } from "zod";
import { query } from "./db";
import { forbidden } from "./errors";
import { publish } from "./events";
import type { Meeting } from "./meetings";
import { enforce } from "./ratelimit";
import type { Viewer } from "./viewer";

// Coordinates are normalized 0..1 so boards look the same on phones and desktops.
export const strokeSchema = z.object({
  tool: z.enum(["pen", "highlighter", "eraser"]).default("pen"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  width: z.number().min(0.5).max(40),
  points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(1).max(2000),
});

export async function getStrokes(m: Meeting, since = 0) {
  const rows = await query<{ id: string; data: z.infer<typeof strokeSchema>; author_key: string }>(
    "SELECT id, data, author_key FROM whiteboard_strokes WHERE meeting_id = $1 AND board = 'main' AND id > $2 ORDER BY id LIMIT 5000",
    [m.id, since],
  );
  return rows.map((r) => ({ id: Number(r.id), ...r.data }));
}

export async function addStroke(m: Meeting, v: Viewer, stroke: z.infer<typeof strokeSchema>) {
  if (!m.whiteboard_enabled) throw forbidden("The whiteboard is turned off.");
  if (!v.key) throw forbidden();
  await enforce(`wb:${v.key}`, 240, 60, "Drawing too fast.");
  const rows = await query<{ id: string }>(
    "INSERT INTO whiteboard_strokes (meeting_id, author_key, data) VALUES ($1, $2, $3) RETURNING id",
    [m.id, v.key, JSON.stringify(stroke)],
  );
  const id = Number(rows[0].id);
  // Small strokes ride along in the event; big ones are fetched by id.
  await publish({ meetingId: m.id, type: "wb_stroke", audience: "all", data: { id, stroke, by: v.key } });
  return { id };
}

export async function clearBoard(m: Meeting, v: Viewer) {
  if (!v.moderator) throw forbidden("Only the host can clear the whiteboard.");
  await query("DELETE FROM whiteboard_strokes WHERE meeting_id = $1 AND board = 'main'", [m.id]);
  await publish({ meetingId: m.id, type: "wb_clear", audience: "all" });
}

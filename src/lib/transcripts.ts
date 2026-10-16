import { z } from "zod";
import { audit } from "./audit";
import { one, query } from "./db";
import { conflict, forbidden } from "./errors";
import { publish } from "./events";
import type { Meeting } from "./meetings";
import { enforce } from "./ratelimit";
import type { Viewer } from "./viewer";
import { emitWebhook } from "./webhooks";

export const segmentSchema = z.object({ text: z.string().trim().min(1).max(2000) });
export const consentSchema = z.object({ kind: z.enum(["transcription", "recording"]), granted: z.boolean() });

/**
 * Captions/transcription are opt-in per person. When the host turns it on,
 * each participant is asked; only people who agree have their speech
 * transcribed (it's done on their own device, so nobody else's audio is
 * processed without consent).
 */
export async function setTranscription(m: Meeting, v: Viewer, on: boolean) {
  if (!v.moderator) throw forbidden();
  if (on && !m.captions_enabled) throw forbidden("Captions are turned off in this meeting's settings.");
  await query("UPDATE meetings SET transcription_state = $2 WHERE id = $1", [m.id, on ? "active" : "off"]);
  await audit({ meetingId: m.id, action: on ? "transcription_started" : "transcription_stopped", actorUserId: v.actorUserId, actorSessionId: v.actorSessionId });
  await publish({ meetingId: m.id, type: "transcription_changed", audience: "all", data: { active: on } });
  if (!on) await emitWebhook(m, "transcript.updated", {});
}

export async function setConsent(m: Meeting, v: Viewer, kind: "transcription" | "recording", granted: boolean) {
  if (!v.key) throw forbidden();
  await query(
    `INSERT INTO consents (meeting_id, subject_key, kind, granted) VALUES ($1, $2, $3, $4)
     ON CONFLICT (meeting_id, subject_key, kind) DO UPDATE SET granted = EXCLUDED.granted, updated_at = now()`,
    [m.id, v.key, kind, granted],
  );
}

export async function myConsents(m: Meeting, v: Viewer) {
  if (!v.key) return {};
  const rows = await query<{ kind: string; granted: boolean }>("SELECT kind, granted FROM consents WHERE meeting_id = $1 AND subject_key = $2", [m.id, v.key]);
  return Object.fromEntries(rows.map((r) => [r.kind, r.granted]));
}

export async function addSegment(m: Meeting, v: Viewer, text: string) {
  if (m.transcription_state !== "active") throw conflict("Transcription isn't on.", "transcription_off");
  if (!v.key) throw forbidden();
  const c = await one<{ granted: boolean }>("SELECT granted FROM consents WHERE meeting_id = $1 AND subject_key = $2 AND kind = 'transcription'", [m.id, v.key]);
  if (!c?.granted) throw forbidden("You haven't agreed to transcription.");
  await enforce(`caption:${v.key}`, 120, 60);
  await query("INSERT INTO transcript_segments (meeting_id, speaker_key, speaker_name, text) VALUES ($1, $2, $3, $4)", [m.id, v.key, v.name, text]);
  await publish({ meetingId: m.id, type: "caption", audience: "all", data: { speaker: v.name, text: text.slice(0, 500) } });
}

export async function getTranscript(m: Meeting) {
  return query<{ speaker_name: string; text: string; spoken_at: string }>(
    "SELECT speaker_name, text, spoken_at FROM transcript_segments WHERE meeting_id = $1 ORDER BY spoken_at, id",
    [m.id],
  );
}

export function transcriptAsText(rows: Array<{ speaker_name: string; text: string; spoken_at: string }>): string {
  return rows.map((r) => `[${new Date(r.spoken_at).toISOString().slice(11, 19)}] ${r.speaker_name}: ${r.text}`).join("\n");
}

export function transcriptAsVtt(rows: Array<{ speaker_name: string; text: string; spoken_at: string }>): string {
  if (!rows.length) return "WEBVTT\n";
  const t0 = new Date(rows[0].spoken_at).getTime();
  const fmt = (ms: number) => new Date(Math.max(ms, 0)).toISOString().slice(11, 23);
  const cues = rows.map((r, i) => {
    const start = new Date(r.spoken_at).getTime() - t0;
    const end = i + 1 < rows.length ? new Date(rows[i + 1].spoken_at).getTime() - t0 : start + 4000;
    return `${i + 1}\n${fmt(start)} --> ${fmt(Math.max(end, start + 1000))}\n<v ${r.speaker_name.replace(/[<>]/g, "")}>${r.text}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

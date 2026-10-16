import { z } from "zod";
import { audit } from "./audit";
import { generateMeetingCode } from "./crypto";
import { one, query, tx, type Db, pool } from "./db";
import { notFound } from "./errors";
import { publish } from "./events";
import { allowedMethods, POLICY_LABELS, type AccessPolicy } from "./policy";

export type Recurrence = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";

export interface Meeting {
  id: string;
  code: string;
  host_user_id: string;
  org_id: string | null;
  preset_id: string | null;
  title: string;
  mode: "interactive" | "broadcast";
  scheduled_at: string | null;
  duration_minutes: number;
  recurrence: Recurrence;
  status: "scheduled" | "live" | "ended";
  access_policy: AccessPolicy;
  allow_name_only_requests: boolean;
  auto_admit_verified_invitees: boolean;
  allow_screen_share: boolean;
  chat_enabled: boolean;
  waiting_message: string | null;
  qa_enabled: boolean;
  qa_moderated: boolean;
  qa_anonymous_allowed: boolean;
  polls_enabled: boolean;
  whiteboard_enabled: boolean;
  captions_enabled: boolean;
  transcription_state: "off" | "active";
  recording_state: "off" | "starting" | "active" | "stopping";
  recording_egress_id: string | null;
  stream_state: "off" | "starting" | "active" | "stopping";
  stream_egress_id: string | null;
  stream_artifact_id: string | null;
  replay_visibility: "host" | "attendees" | "link";
  dialin_enabled: boolean;
  dialin_pin: string | null;
  dialin_rule_id: string | null;
  breakouts_open: boolean;
  retention_days: number | null;
  locked_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export const accessPolicySchema = z.enum(["anyone_with_link", "invited_only", "verified_only", "host_approval"]);
export const recurrenceSchema = z.enum(["none", "daily", "weekdays", "weekly", "biweekly", "monthly"]);

/** Every host-editable meeting setting. Also the shape stored in access presets. */
export const settingsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    mode: z.enum(["interactive", "broadcast"]),
    scheduledAt: z.string().datetime({ offset: true }).nullable(),
    durationMinutes: z.number().int().min(5).max(1440),
    recurrence: recurrenceSchema,
    accessPolicy: accessPolicySchema,
    allowNameOnlyRequests: z.boolean(),
    autoAdmitVerifiedInvitees: z.boolean(),
    allowScreenShare: z.boolean(),
    chatEnabled: z.boolean(),
    waitingMessage: z.string().trim().max(500).nullable(),
    qaEnabled: z.boolean(),
    qaModerated: z.boolean(),
    qaAnonymousAllowed: z.boolean(),
    pollsEnabled: z.boolean(),
    whiteboardEnabled: z.boolean(),
    captionsEnabled: z.boolean(),
    replayVisibility: z.enum(["host", "attendees", "link"]),
    retentionDays: z.number().int().min(1).max(3650).nullable(),
  })
  .partial();
export type Settings = z.infer<typeof settingsSchema>;

export const createMeetingSchema = settingsSchema.extend({
  title: z.string().trim().min(1).max(120),
  presetId: z.string().uuid().nullish(),
  orgId: z.string().uuid().nullish(),
});

const COLUMN_OF: Record<keyof Settings, keyof Meeting> = {
  title: "title",
  mode: "mode",
  scheduledAt: "scheduled_at",
  durationMinutes: "duration_minutes",
  recurrence: "recurrence",
  accessPolicy: "access_policy",
  allowNameOnlyRequests: "allow_name_only_requests",
  autoAdmitVerifiedInvitees: "auto_admit_verified_invitees",
  allowScreenShare: "allow_screen_share",
  chatEnabled: "chat_enabled",
  waitingMessage: "waiting_message",
  qaEnabled: "qa_enabled",
  qaModerated: "qa_moderated",
  qaAnonymousAllowed: "qa_anonymous_allowed",
  pollsEnabled: "polls_enabled",
  whiteboardEnabled: "whiteboard_enabled",
  captionsEnabled: "captions_enabled",
  replayVisibility: "replay_visibility",
  retentionDays: "retention_days",
};

/** Settings that participants' clients need to react to live. */
const PUBLIC_SETTINGS = new Set<keyof Meeting>([
  "title", "mode", "allow_screen_share", "chat_enabled", "qa_enabled", "qa_moderated", "qa_anonymous_allowed",
  "polls_enabled", "whiteboard_enabled", "captions_enabled", "waiting_message", "access_policy", "allow_name_only_requests",
]);

export async function createMeeting(
  hostUserId: string,
  input: z.infer<typeof createMeetingSchema>,
  defaults: Settings = {},
): Promise<Meeting> {
  const merged: Settings = { ...defaults, ...stripUndefined(input) };
  const cols: string[] = ["code", "host_user_id", "org_id", "preset_id"];
  const base: unknown[] = [null, hostUserId, input.orgId ?? null, input.presetId ?? null];
  for (const [k, col] of Object.entries(COLUMN_OF) as Array<[keyof Settings, keyof Meeting]>) {
    if (merged[k] === undefined) continue;
    cols.push(col);
    base.push(merged[k]);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const params = [...base];
    params[0] = generateMeetingCode();
    try {
      return await tx(async (db) => {
        const m = await one<Meeting>(
          `INSERT INTO meetings (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
          params,
          db,
        );
        await db.query("INSERT INTO meeting_roles (meeting_id, user_id, role, granted_by) VALUES ($1, $2, 'host', $2)", [m!.id, hostUserId]);
        await audit({ meetingId: m!.id, action: "meeting_created", actorUserId: hostUserId, metadata: { mode: m!.mode, accessPolicy: m!.access_policy } }, db);
        return m!;
      });
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).code === "23505" && /code/.test((err as { constraint?: string }).constraint ?? "code")) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate a meeting code");
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function getMeetingByCode(code: string, db: Db = pool()): Promise<Meeting | null> {
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) return null;
  return one<Meeting>("SELECT * FROM meetings WHERE code = $1", [code], db);
}

export async function getMeetingById(id: string, db: Db = pool()): Promise<Meeting | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return one<Meeting>("SELECT * FROM meetings WHERE id = $1", [id], db);
}

export async function requireMeeting(code: string): Promise<Meeting> {
  const m = await getMeetingByCode(code);
  if (!m) throw notFound("Meeting not found");
  return m;
}

/** Returns the meeting only if userId hosts it. Non-hosts get 404, not 403, to avoid confirming existence of settings. */
export async function requireHostedMeeting(code: string, userId: string): Promise<Meeting> {
  const m = await getMeetingByCode(code);
  if (!m || m.host_user_id !== userId) throw notFound("Meeting not found");
  return m;
}

export async function listHostedMeetings(userId: string): Promise<Meeting[]> {
  return query<Meeting>("SELECT * FROM meetings WHERE host_user_id = $1 ORDER BY created_at DESC LIMIT 200", [userId]);
}

export async function updateSettings(m: Meeting, actorUserId: string, patch: Settings): Promise<Meeting> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  let publicChange = false;
  for (const [k, col] of Object.entries(COLUMN_OF) as Array<[keyof Settings, keyof Meeting]>) {
    const value = patch[k];
    if (value === undefined || m[col] === value) continue;
    if (col === "scheduled_at" && value && m.scheduled_at && new Date(m.scheduled_at).getTime() === new Date(value as string).getTime()) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
    changes[col] = { from: m[col], to: value };
    if (PUBLIC_SETTINGS.has(col)) publicChange = true;
  }
  if (sets.length === 0) return m;
  params.push(m.id);
  const updated = await tx(async (db) => {
    const row = await one<Meeting>(`UPDATE meetings SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params, db);
    await audit({ meetingId: m.id, action: "settings_changed", actorUserId, metadata: changes }, db);
    return row!;
  });
  if (publicChange) await publish({ meetingId: m.id, type: "settings_changed", audience: "all" });
  return updated;
}

export async function setLocked(m: Meeting, actor: { userId: string | null; sessionId: string | null }, locked: boolean): Promise<Meeting> {
  const updated = await tx(async (db) => {
    const row = await one<Meeting>(
      `UPDATE meetings SET locked_at = ${locked ? "coalesce(locked_at, now())" : "NULL"}, updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id],
      db,
    );
    await audit({ meetingId: m.id, action: locked ? "meeting_locked" : "meeting_unlocked", actorUserId: actor.userId, actorSessionId: actor.sessionId }, db);
    return row!;
  });
  await publish({ meetingId: m.id, type: "settings_changed", audience: "all", data: { locked } });
  return updated;
}

export async function endMeeting(m: Meeting, actorUserId: string): Promise<Meeting> {
  const updated = await tx(async (db) => {
    const row = await one<Meeting>(
      `UPDATE meetings SET status = 'ended', ended_at = coalesce(ended_at, now()), breakouts_open = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [m.id],
      db,
    );
    await audit({ meetingId: m.id, action: "meeting_ended", actorUserId }, db);
    return row!;
  });
  await publish({ meetingId: m.id, type: "meeting_ended", audience: "all" });
  return updated;
}

/**
 * Reopens a recurring or ended meeting for its next session, keeping the same
 * link, invite list and settings. Join decisions from the previous session are
 * cleared so the waiting room starts fresh; blocks stay.
 */
export async function reopenMeeting(m: Meeting, actorUserId: string, nextAt: Date | null): Promise<Meeting> {
  return tx(async (db) => {
    await db.query("DELETE FROM join_requests WHERE meeting_id = $1 AND status <> 'blocked'", [m.id]);
    await db.query("DELETE FROM meeting_roles WHERE meeting_id = $1 AND role <> 'host'", [m.id]);
    await db.query("DELETE FROM breakout_rooms WHERE meeting_id = $1", [m.id]);
    const row = await one<Meeting>(
      `UPDATE meetings SET status = 'scheduled', ended_at = NULL, locked_at = NULL, scheduled_at = coalesce($2, scheduled_at),
         transcription_state = 'off', breakouts_open = false, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [m.id, nextAt],
      db,
    );
    await audit({ meetingId: m.id, action: "settings_changed", actorUserId, metadata: { reopened: true, nextAt } }, db);
    return row!;
  });
}

export async function markLive(m: Meeting): Promise<void> {
  if (m.status === "scheduled") await pool().query("UPDATE meetings SET status = 'live' WHERE id = $1 AND status = 'scheduled'", [m.id]);
}

/** Next occurrence strictly after `after` for a recurring meeting. */
export function nextOccurrence(start: Date, recurrence: Recurrence, after: Date = new Date()): Date | null {
  if (recurrence === "none") return start > after ? start : null;
  const d = new Date(start);
  for (let i = 0; i < 1000 && d <= after; i++) {
    switch (recurrence) {
      case "daily":
        d.setUTCDate(d.getUTCDate() + 1);
        break;
      case "weekdays":
        do d.setUTCDate(d.getUTCDate() + 1);
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
        break;
      case "weekly":
        d.setUTCDate(d.getUTCDate() + 7);
        break;
      case "biweekly":
        d.setUTCDate(d.getUTCDate() + 14);
        break;
      case "monthly":
        d.setUTCMonth(d.getUTCMonth() + 1);
        break;
    }
  }
  return d > after ? d : null;
}

/** Safe subset shown to anyone holding the link. No invitee or host contact data. */
export function publicView(m: Meeting, hostName: string, branding: Record<string, unknown> | null = null) {
  return {
    code: m.code,
    title: m.title,
    hostName,
    mode: m.mode,
    status: m.status,
    scheduledAt: m.scheduled_at,
    durationMinutes: m.duration_minutes,
    recurrence: m.recurrence,
    accessPolicy: m.access_policy,
    accessPolicyLabel: POLICY_LABELS[m.access_policy],
    allowedMethods: allowedMethods(m),
    locked: m.locked_at !== null,
    ended: m.status === "ended",
    waitingMessage: m.waiting_message,
    features: {
      chat: m.chat_enabled,
      screenShare: m.allow_screen_share,
      qa: m.qa_enabled,
      qaModerated: m.qa_moderated,
      qaAnonymous: m.qa_anonymous_allowed,
      polls: m.polls_enabled,
      whiteboard: m.whiteboard_enabled,
      captions: m.captions_enabled,
    },
    transcriptionActive: m.transcription_state === "active",
    recordingActive: m.recording_state === "active" || m.recording_state === "starting",
    streamActive: m.stream_state === "active",
    breakoutsOpen: m.breakouts_open,
    dialIn: m.dialin_enabled && m.dialin_pin ? { pin: m.dialin_pin, number: process.env.DIALIN_NUMBER ?? null } : null,
    branding,
  };
}

export function hostView(m: Meeting) {
  return {
    ...publicView(m, ""),
    id: m.id,
    orgId: m.org_id,
    allowNameOnlyRequests: m.allow_name_only_requests,
    autoAdmitVerifiedInvitees: m.auto_admit_verified_invitees,
    allowScreenShare: m.allow_screen_share,
    chatEnabled: m.chat_enabled,
    qaEnabled: m.qa_enabled,
    qaModerated: m.qa_moderated,
    qaAnonymousAllowed: m.qa_anonymous_allowed,
    pollsEnabled: m.polls_enabled,
    whiteboardEnabled: m.whiteboard_enabled,
    captionsEnabled: m.captions_enabled,
    replayVisibility: m.replay_visibility,
    retentionDays: m.retention_days,
    recordingState: m.recording_state,
    streamState: m.stream_state,
    dialinEnabled: m.dialin_enabled,
    createdAt: m.created_at,
  };
}

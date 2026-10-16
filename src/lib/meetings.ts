import { z } from "zod";
import { audit } from "./audit";
import { generateMeetingCode } from "./crypto";
import { one, query, tx, type Db, pool } from "./db";
import { notFound } from "./errors";
import { allowedMethods, POLICY_LABELS, type AccessPolicy } from "./policy";

export interface Meeting {
  id: string;
  code: string;
  host_user_id: string;
  title: string;
  mode: "interactive" | "broadcast";
  scheduled_at: string | null;
  status: "scheduled" | "live" | "ended";
  access_policy: AccessPolicy;
  allow_name_only_requests: boolean;
  auto_admit_verified_invitees: boolean;
  allow_screen_share: boolean;
  chat_enabled: boolean;
  locked_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export const accessPolicySchema = z.enum(["anyone_with_link", "invited_only", "verified_only", "host_approval"]);

export const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["interactive", "broadcast"]).default("interactive"),
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
  accessPolicy: accessPolicySchema.default("host_approval"),
  allowNameOnlyRequests: z.boolean().default(true),
  autoAdmitVerifiedInvitees: z.boolean().default(true),
});

export const settingsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    accessPolicy: accessPolicySchema,
    allowNameOnlyRequests: z.boolean(),
    autoAdmitVerifiedInvitees: z.boolean(),
    allowScreenShare: z.boolean(),
    chatEnabled: z.boolean(),
  })
  .partial();

const COLS = `id, code, host_user_id, title, mode, scheduled_at, status, access_policy, allow_name_only_requests,
  auto_admit_verified_invitees, allow_screen_share, chat_enabled, locked_at, ended_at, created_at`;

export async function createMeeting(hostUserId: string, input: z.infer<typeof createMeetingSchema>): Promise<Meeting> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await tx(async (db) => {
        const m = await one<Meeting>(
          `INSERT INTO meetings (code, host_user_id, title, mode, scheduled_at, access_policy, allow_name_only_requests, auto_admit_verified_invitees)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
          [
            generateMeetingCode(),
            hostUserId,
            input.title,
            input.mode,
            input.scheduledAt ?? null,
            input.accessPolicy,
            input.allowNameOnlyRequests,
            input.autoAdmitVerifiedInvitees,
          ],
          db,
        );
        await db.query("INSERT INTO meeting_roles (meeting_id, user_id, role, granted_by) VALUES ($1, $2, 'host', $2)", [m!.id, hostUserId]);
        await audit({ meetingId: m!.id, action: "meeting_created", actorUserId: hostUserId, metadata: { mode: input.mode, accessPolicy: input.accessPolicy } }, db);
        return m!;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") continue; // meeting code collision, retry
      throw err;
    }
  }
  throw new Error("Could not allocate a meeting code");
}

export async function getMeetingByCode(code: string, db: Db = pool()): Promise<Meeting | null> {
  if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) return null;
  return one<Meeting>(`SELECT ${COLS} FROM meetings WHERE code = $1`, [code], db);
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
  return query<Meeting>(`SELECT ${COLS} FROM meetings WHERE host_user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId]);
}

export async function updateSettings(m: Meeting, actorUserId: string, patch: z.infer<typeof settingsSchema>): Promise<Meeting> {
  const map: Record<string, [keyof Meeting, unknown]> = {
    title: ["title", patch.title],
    accessPolicy: ["access_policy", patch.accessPolicy],
    allowNameOnlyRequests: ["allow_name_only_requests", patch.allowNameOnlyRequests],
    autoAdmitVerifiedInvitees: ["auto_admit_verified_invitees", patch.autoAdmitVerifiedInvitees],
    allowScreenShare: ["allow_screen_share", patch.allowScreenShare],
    chatEnabled: ["chat_enabled", patch.chatEnabled],
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [, [col, value]] of Object.entries(map)) {
    if (value === undefined || m[col] === value) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
    changes[col] = { from: m[col], to: value };
  }
  if (sets.length === 0) return m;
  params.push(m.id);
  return tx(async (db) => {
    const updated = await one<Meeting>(
      `UPDATE meetings SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING ${COLS}`,
      params,
      db,
    );
    await audit({ meetingId: m.id, action: "settings_changed", actorUserId, metadata: changes }, db);
    return updated!;
  });
}

export async function setLocked(m: Meeting, actorUserId: string, locked: boolean): Promise<Meeting> {
  return tx(async (db) => {
    const updated = await one<Meeting>(
      `UPDATE meetings SET locked_at = ${locked ? "coalesce(locked_at, now())" : "NULL"}, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
      [m.id],
      db,
    );
    await audit({ meetingId: m.id, action: locked ? "meeting_locked" : "meeting_unlocked", actorUserId }, db);
    return updated!;
  });
}

export async function endMeeting(m: Meeting, actorUserId: string): Promise<Meeting> {
  return tx(async (db) => {
    const updated = await one<Meeting>(
      `UPDATE meetings SET status = 'ended', ended_at = coalesce(ended_at, now()), updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
      [m.id],
      db,
    );
    await audit({ meetingId: m.id, action: "meeting_ended", actorUserId }, db);
    return updated!;
  });
}

export async function markLive(m: Meeting): Promise<void> {
  if (m.status === "scheduled") await pool().query("UPDATE meetings SET status = 'live' WHERE id = $1 AND status = 'scheduled'", [m.id]);
}

/** Safe subset shown to anyone holding the link. No invitee or host contact data. */
export function publicView(m: Meeting, hostName: string) {
  return {
    code: m.code,
    title: m.title,
    hostName,
    mode: m.mode,
    status: m.status,
    scheduledAt: m.scheduled_at,
    accessPolicy: m.access_policy,
    accessPolicyLabel: POLICY_LABELS[m.access_policy],
    allowedMethods: allowedMethods(m),
    locked: m.locked_at !== null,
    ended: m.status === "ended",
  };
}

export function hostView(m: Meeting) {
  return {
    ...publicView(m, ""),
    id: m.id,
    allowNameOnlyRequests: m.allow_name_only_requests,
    autoAdmitVerifiedInvitees: m.auto_admit_verified_invitees,
    allowScreenShare: m.allow_screen_share,
    chatEnabled: m.chat_enabled,
    createdAt: m.created_at,
  };
}

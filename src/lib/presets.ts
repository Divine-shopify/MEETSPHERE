import { z } from "zod";
import { one, query } from "./db";
import { forbidden, notFound } from "./errors";
import { invitationInputSchema, listInvitations, normalizeInvitation, type NormalizedInvitation } from "./invitations";
import { settingsSchema, type Meeting, type Settings } from "./meetings";
import { orgRole } from "./orgs";

export const presetSchema = z.object({
  name: z.string().trim().min(1).max(80),
  settings: settingsSchema.omit({ title: true, scheduledAt: true }),
  invitations: z.array(invitationInputSchema).max(10000).default([]),
  orgId: z.string().uuid().nullish(),
});

export interface Preset {
  id: string;
  owner_user_id: string;
  org_id: string | null;
  name: string;
  settings: Settings;
  invitations: NormalizedInvitation[];
  created_at: string;
}

export async function listPresets(userId: string): Promise<Preset[]> {
  return query<Preset>(
    `SELECT * FROM access_presets
      WHERE owner_user_id = $1 OR org_id IN (SELECT org_id FROM org_members WHERE user_id = $1)
      ORDER BY name`,
    [userId],
  );
}

export async function getPresetFor(userId: string, presetId: string): Promise<Preset> {
  const p = await one<Preset>(
    `SELECT * FROM access_presets WHERE id = $2
        AND (owner_user_id = $1 OR org_id IN (SELECT org_id FROM org_members WHERE user_id = $1))`,
    [userId, presetId],
  );
  if (!p) throw notFound("Preset not found");
  return p;
}

export async function savePreset(userId: string, input: z.infer<typeof presetSchema>, id?: string): Promise<Preset> {
  if (input.orgId) {
    const role = await orgRole(input.orgId, userId);
    if (role !== "owner" && role !== "admin") throw forbidden("Only organization admins can create shared presets.");
  }
  const invites: NormalizedInvitation[] = [];
  for (const i of input.invitations) {
    const n = normalizeInvitation(i);
    if (typeof n !== "string") invites.push(n);
  }
  if (id) {
    const existing = await getPresetFor(userId, id);
    if (existing.owner_user_id !== userId) {
      const role = existing.org_id ? await orgRole(existing.org_id, userId) : null;
      if (role !== "owner" && role !== "admin") throw forbidden("Only the creator or an organization admin can edit this preset.");
    }
    return (await one<Preset>(
      "UPDATE access_presets SET name = $2, settings = $3, invitations = $4, updated_at = now() WHERE id = $1 RETURNING *",
      [id, input.name, JSON.stringify(input.settings), JSON.stringify(invites)],
    ))!;
  }
  return (await one<Preset>(
    "INSERT INTO access_presets (owner_user_id, org_id, name, settings, invitations) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [userId, input.orgId ?? null, input.name, JSON.stringify(input.settings), JSON.stringify(invites)],
  ))!;
}

export async function deletePreset(userId: string, id: string): Promise<void> {
  const p = await getPresetFor(userId, id);
  if (p.owner_user_id !== userId) {
    const role = p.org_id ? await orgRole(p.org_id, userId) : null;
    if (role !== "owner" && role !== "admin") throw forbidden();
  }
  await query("DELETE FROM access_presets WHERE id = $1", [id]);
}

/** Snapshot of a meeting's rules and invite list, reusable for the next class/service/team meeting. */
export async function presetFromMeeting(userId: string, m: Meeting, name: string): Promise<Preset> {
  const invites = await listInvitations(m.id);
  return savePreset(userId, {
    name,
    orgId: m.org_id,
    settings: {
      mode: m.mode,
      durationMinutes: m.duration_minutes,
      recurrence: m.recurrence,
      accessPolicy: m.access_policy,
      allowNameOnlyRequests: m.allow_name_only_requests,
      autoAdmitVerifiedInvitees: m.auto_admit_verified_invitees,
      allowScreenShare: m.allow_screen_share,
      chatEnabled: m.chat_enabled,
      waitingMessage: m.waiting_message,
      qaEnabled: m.qa_enabled,
      qaModerated: m.qa_moderated,
      qaAnonymousAllowed: m.qa_anonymous_allowed,
      pollsEnabled: m.polls_enabled,
      whiteboardEnabled: m.whiteboard_enabled,
      captionsEnabled: m.captions_enabled,
      replayVisibility: m.replay_visibility,
      retentionDays: m.retention_days,
    },
    invitations: invites.map((i) => ({ name: i.expected_name, phone: i.normalized_phone, email: i.normalized_email })),
  });
}

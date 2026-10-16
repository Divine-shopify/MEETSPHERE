import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
  WebhookReceiver,
  type ParticipantPermission,
} from "livekit-server-sdk";
import { config } from "./config";
import { query } from "./db";
import { unavailable } from "./errors";
import type { Meeting } from "./meetings";

export type MediaRole = "host" | "cohost" | "speaker" | "participant" | "audience";

export function mediaConfigured(): boolean {
  return config.livekit !== null;
}

export function lk() {
  const c = config.livekit;
  if (!c) throw unavailable("Audio/video is not configured on this server (LIVEKIT_* variables are missing).", "media_not_configured");
  return c;
}

export function livekitHttpUrl(): string {
  return lk().url.replace(/^ws/, "http");
}

function roomService(): RoomServiceClient {
  const c = lk();
  return new RoomServiceClient(livekitHttpUrl(), c.apiKey, c.apiSecret);
}

const BREAKOUT_SEP = "~";
export const roomName = (m: Pick<Meeting, "id">) => m.id;
export const breakoutRoomName = (m: Pick<Meeting, "id">, breakoutId: string) => `${m.id}${BREAKOUT_SEP}${breakoutId}`;

/** "meetingId" or "meetingId~breakoutId" */
export function parseRoomName(room: string): { meetingId: string; breakoutId: string | null } | null {
  const [meetingId, breakoutId] = room.split(BREAKOUT_SEP);
  const uuid = /^[0-9a-f-]{36}$/;
  if (!uuid.test(meetingId) || (breakoutId !== undefined && !uuid.test(breakoutId))) return null;
  return { meetingId, breakoutId: breakoutId ?? null };
}

export const hostIdentity = (userId: string) => `host:${userId}`;
export const guestIdentity = (joinRequestId: string) => `jr:${joinRequestId}`;

export function parseIdentity(identity: string): { kind: "host" | "guest"; id: string } | null {
  const [kind, id] = identity.split(":");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  if (kind === "host") return { kind: "host", id };
  if (kind === "jr") return { kind: "guest", id };
  return null;
}

type PermMeeting = Pick<Meeting, "mode" | "allow_screen_share" | "chat_enabled">;

/** Media permissions derived from meeting settings and the participant's role. */
export function permissionsFor(m: PermMeeting, role: MediaRole) {
  const privileged = role === "host" || role === "cohost";
  const canPublish = privileged || role === "speaker" || (m.mode === "interactive" && role === "participant");
  const sources = [TrackSource.CAMERA, TrackSource.MICROPHONE];
  if (privileged || m.allow_screen_share) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return {
    canSubscribe: true,
    canPublish,
    canPublishSources: canPublish ? sources : [],
    canPublishData: privileged || m.chat_enabled,
    // Names and identity badges come from the server; clients cannot rewrite them.
    canUpdateMetadata: false,
  };
}

export async function createMediaToken(opts: {
  meeting: Meeting;
  room: string;
  identity: string;
  name: string;
  role: MediaRole;
  metadata: Record<string, unknown>;
  attributes?: Record<string, string>;
}): Promise<{ token: string; url: string }> {
  const c = lk();
  const at = new AccessToken(c.apiKey, c.apiSecret, {
    identity: opts.identity,
    name: opts.name,
    ttl: "10m", // only governs the initial connect; LiveKit refreshes tokens for connected clients
    metadata: JSON.stringify(opts.metadata),
    attributes: opts.attributes,
  });
  const p = permissionsFor(opts.meeting, opts.role);
  at.addGrant({
    room: opts.room,
    roomJoin: true,
    roomAdmin: opts.role === "host" || opts.role === "cohost",
    canSubscribe: p.canSubscribe,
    canPublish: p.canPublish,
    // An empty source list could be read as "no restriction", so omit it when publishing is off.
    ...(p.canPublish ? { canPublishSources: p.canPublishSources } : {}),
    canPublishData: p.canPublishData,
    canUpdateOwnMetadata: p.canUpdateMetadata,
  });
  return { token: await at.toJwt(), url: c.url };
}

/** Creates the room with a participant cap. Safe to call repeatedly. */
export async function ensureRoom(room: string, maxParticipants: number): Promise<void> {
  try {
    // emptyTimeout only reclaims an EMPTY room; it is not a meeting duration limit.
    await roomService().createRoom({ name: room, maxParticipants, emptyTimeout: 10 * 60 });
  } catch (err) {
    console.warn("[livekit] createRoom failed", (err as Error).message);
  }
}

const notFoundErr = (err: unknown) => /not found|404|does not exist/i.test((err as Error).message);

/** Rooms an identity is currently connected to (main room and/or a breakout), from webhook-tracked sessions. */
export async function roomsOf(m: Pick<Meeting, "id">, identity: string): Promise<string[]> {
  const rows = await query<{ room: string }>(
    "SELECT DISTINCT room FROM participant_sessions WHERE meeting_id = $1 AND identity = $2 AND left_at IS NULL",
    [m.id, identity],
  );
  const rooms = rows.map((r) => r.room);
  return rooms.length ? rooms : [roomName(m)];
}

export async function allRooms(m: Pick<Meeting, "id">): Promise<string[]> {
  const rows = await query<{ id: string }>("SELECT id FROM breakout_rooms WHERE meeting_id = $1", [m.id]);
  return [roomName(m), ...rows.map((r) => breakoutRoomName(m, r.id))];
}

// Server-side moderation. Best effort: if the participant is not connected,
// the database state still blocks future tokens.

export async function kick(m: Pick<Meeting, "id">, identity: string): Promise<void> {
  if (!mediaConfigured()) return;
  for (const room of await roomsOf(m, identity)) {
    try {
      // revokeTokenTs invalidates any token issued before now, so a kicked client cannot reconnect with it.
      await roomService().removeParticipant(room, identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
    } catch (err) {
      if (!notFoundErr(err)) console.warn("[livekit] removeParticipant failed", (err as Error).message);
    }
  }
}

export async function kickFromRoom(room: string, identity: string): Promise<void> {
  if (!mediaConfigured()) return;
  try {
    await roomService().removeParticipant(room, identity);
  } catch (err) {
    if (!notFoundErr(err)) console.warn("[livekit] removeParticipant failed", (err as Error).message);
  }
}

export async function muteMicrophone(m: Pick<Meeting, "id">, identity: string): Promise<boolean> {
  const svc = roomService();
  let muted = false;
  for (const room of await roomsOf(m, identity)) {
    try {
      const p = await svc.getParticipant(room, identity);
      for (const t of p.tracks) {
        if (t.type === TrackType.AUDIO && !t.muted) {
          await svc.mutePublishedTrack(room, identity, t.sid, true);
          muted = true;
        }
      }
    } catch (err) {
      if (!notFoundErr(err)) throw err;
    }
  }
  return muted;
}

export async function listIdentities(m: Pick<Meeting, "id">, room = roomName(m)): Promise<string[]> {
  if (!mediaConfigured()) return [];
  try {
    const ps = await roomService().listParticipants(room);
    return ps.map((p) => p.identity);
  } catch {
    return [];
  }
}

export async function listParticipantsDetailed(room: string) {
  if (!mediaConfigured()) return [];
  try {
    return await roomService().listParticipants(room);
  } catch {
    return [];
  }
}

export async function updatePermissions(m: Meeting, identity: string, role: MediaRole): Promise<void> {
  if (!mediaConfigured()) return;
  const p = permissionsFor(m, role);
  const permission: Partial<ParticipantPermission> = {
    canSubscribe: p.canSubscribe,
    canPublish: p.canPublish,
    canPublishData: p.canPublishData,
    canPublishSources: p.canPublish ? p.canPublishSources : [],
    canUpdateMetadata: false,
  };
  for (const room of await roomsOf(m, identity)) {
    try {
      await roomService().updateParticipant(room, identity, { permission: permission as ParticipantPermission, attributes: { role } });
    } catch (err) {
      if (!notFoundErr(err)) console.warn("[livekit] updateParticipant failed", (err as Error).message);
    }
  }
}

export async function setAttributes(m: Pick<Meeting, "id">, identity: string, attributes: Record<string, string>): Promise<void> {
  let ok = false;
  for (const room of await roomsOf(m, identity)) {
    try {
      await roomService().updateParticipant(room, identity, { attributes });
      ok = true;
    } catch (err) {
      if (!notFoundErr(err)) throw err;
    }
  }
  if (!ok) throw unavailable("You're not connected to the meeting.", "not_connected");
}

export async function deleteRoom(room: string): Promise<void> {
  if (!mediaConfigured()) return;
  try {
    await roomService().deleteRoom(room);
  } catch (err) {
    if (!notFoundErr(err)) console.warn("[livekit] deleteRoom failed", (err as Error).message);
  }
}

export function webhookReceiver(): WebhookReceiver {
  const c = lk();
  return new WebhookReceiver(c.apiKey, c.apiSecret);
}

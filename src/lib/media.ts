import { AccessToken, RoomServiceClient, TrackSource, TrackType, WebhookReceiver, type ParticipantPermission } from "livekit-server-sdk";
import { config } from "./config";
import { unavailable } from "./errors";
import type { Meeting } from "./meetings";

export type MediaRole = "host" | "cohost" | "speaker" | "participant" | "audience";

export function mediaConfigured(): boolean {
  return config.livekit !== null;
}

function lk() {
  const c = config.livekit;
  if (!c) throw unavailable("Audio/video is not configured on this server (LIVEKIT_* variables are missing).", "media_not_configured");
  return c;
}

function roomService(): RoomServiceClient {
  const c = lk();
  return new RoomServiceClient(c.url.replace(/^ws/, "http"), c.apiKey, c.apiSecret);
}

export const roomName = (m: Pick<Meeting, "id">) => m.id;
export const hostIdentity = (userId: string) => `host:${userId}`;
export const guestIdentity = (joinRequestId: string) => `jr:${joinRequestId}`;

export function parseIdentity(identity: string): { kind: "host" | "guest"; id: string } | null {
  const [kind, id] = identity.split(":");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  if (kind === "host") return { kind: "host", id };
  if (kind === "jr") return { kind: "guest", id };
  return null;
}

/** Media permissions derived from meeting settings and the participant's role. */
export function permissionsFor(m: Pick<Meeting, "mode" | "allow_screen_share" | "chat_enabled">, role: MediaRole) {
  const privileged = role === "host" || role === "cohost";
  const canPublish = privileged || m.mode === "interactive" || role === "speaker";
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
    room: roomName(opts.meeting),
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
export async function ensureRoom(m: Meeting, maxParticipants: number): Promise<void> {
  try {
    // emptyTimeout only reclaims an EMPTY room; it is not a meeting duration limit.
    await roomService().createRoom({ name: roomName(m), maxParticipants, emptyTimeout: 10 * 60 });
  } catch (err) {
    console.warn("[livekit] createRoom failed", (err as Error).message);
  }
}

// Server-side moderation. These are best effort: if the participant is not
// connected the database state still blocks future tokens.

export async function kick(m: Meeting, identity: string): Promise<void> {
  if (!mediaConfigured()) return;
  try {
    // revokeTokenTs invalidates any token issued before now, so a kicked client cannot reconnect with it.
    await roomService().removeParticipant(roomName(m), identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) });
  } catch (err) {
    if (!/not found|404/i.test((err as Error).message)) console.warn("[livekit] removeParticipant failed", (err as Error).message);
  }
}

export async function muteMicrophone(m: Meeting, identity: string): Promise<boolean> {
  const svc = roomService();
  let muted = false;
  try {
    const p = await svc.getParticipant(roomName(m), identity);
    for (const t of p.tracks) {
      if (t.type === TrackType.AUDIO && !t.muted) {
        await svc.mutePublishedTrack(roomName(m), identity, t.sid, true);
        muted = true;
      }
    }
  } catch (err) {
    if (!/not found|404/i.test((err as Error).message)) throw err;
  }
  return muted;
}

export async function listIdentities(m: Meeting): Promise<string[]> {
  if (!mediaConfigured()) return [];
  try {
    const ps = await roomService().listParticipants(roomName(m));
    return ps.map((p) => p.identity);
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
  try {
    await roomService().updateParticipant(roomName(m), identity, { permission: permission as ParticipantPermission, attributes: { role } });
  } catch (err) {
    if (!/not found|404/i.test((err as Error).message)) console.warn("[livekit] updateParticipant failed", (err as Error).message);
  }
}

export async function setAttributes(m: Meeting, identity: string, attributes: Record<string, string>): Promise<void> {
  try {
    await roomService().updateParticipant(roomName(m), identity, { attributes });
  } catch (err) {
    if (/not found|404/i.test((err as Error).message)) throw unavailable("You're not connected to the meeting.", "not_connected");
    throw err;
  }
}

export function webhookReceiver(): WebhookReceiver {
  const c = lk();
  return new WebhookReceiver(c.apiKey, c.apiSecret);
}


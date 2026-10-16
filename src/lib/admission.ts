import { audit } from "./audit";
import { maskContact } from "./contact";
import { one, query, tx, type Db, pool } from "./db";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./errors";
import { publish } from "./events";
import { matchInvitation } from "./invitations";
import {
  breakoutRoomName,
  createMediaToken,
  ensureRoom,
  guestIdentity,
  hostIdentity,
  kick,
  mediaConfigured,
  parseIdentity,
  roomName,
  updatePermissions,
  type MediaRole,
} from "./media";
import { markLive, type Meeting } from "./meetings";
import { evaluateAdmission, identityBadges, type IdentityMethod, type MatchState } from "./policy";
import { planForMeeting } from "./plans";
import type { Session } from "./session";
import { monthlyUsage } from "./usage";
import { emitWebhook } from "./webhooks";

export type JoinStatus = "pending" | "admitted" | "rejected" | "removed" | "blocked";

export interface JoinRequest {
  id: string;
  meeting_id: string;
  session_id: string | null;
  user_id: string | null;
  submitted_name: string;
  identity_method: IdentityMethod | "sso" | "dialin";
  verified_contact: string | null;
  verification_state: "verified" | "unverified";
  match_state: MatchState;
  invitation_id: string | null;
  status: JoinStatus;
  decided_by: "policy" | "host" | null;
  sip_identity: string | null;
  requested_at: string;
  reviewed_at: string | null;
}

/** Who performed a moderation action: the host (user) or a co-host (guest session). */
export interface Actor {
  userId: string | null;
  sessionId: string | null;
}

const JR_COLS = `id, meeting_id, session_id, user_id, submitted_name, identity_method, verified_contact, verification_state,
  match_state, invitation_id, status, decided_by, sip_identity, requested_at, reviewed_at`;

export function isHost(m: Meeting, session: Session | null): boolean {
  return !!session?.user_id && session.user_id === m.host_user_id;
}

async function isBlocked(m: Meeting, session: Session, db: Db): Promise<boolean> {
  const contacts = [session.verified_phone, session.verified_email].filter(Boolean);
  const row = await one(
    `SELECT 1 FROM meeting_blocks WHERE meeting_id = $1
       AND (session_id = $2 OR (user_id IS NOT NULL AND user_id = $3) OR verified_contact = ANY($4::text[]))
     LIMIT 1`,
    [m.id, session.id, session.user_id, contacts],
    db,
  );
  return row !== null;
}

export function badgesFor(r: JoinRequest) {
  const b = identityBadges({
    verification_state: r.verification_state,
    match_state: r.match_state,
    status: r.status,
    decided_by: r.decided_by,
  });
  if (r.identity_method === "dialin") return ["phone_caller", ...b.filter((x) => x !== "name_entered")];
  if (r.identity_method === "sso") return ["sso_verified", ...b.filter((x) => x !== "contact_verified")];
  return b;
}

/** Public, per-applicant view of their own request. */
export function applicantView(r: JoinRequest) {
  return {
    id: r.id,
    status: r.status,
    name: r.submitted_name,
    method: r.identity_method,
    verified: r.verification_state === "verified",
    badges: badgesFor(r),
  };
}

export async function getOwnRequest(m: Meeting, session: Session | null): Promise<JoinRequest | null> {
  if (!session) return null;
  return one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE meeting_id = $1 AND session_id = $2`, [m.id, session.id]);
}

export async function getRequest(m: Meeting, id: string): Promise<JoinRequest | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE id = $1 AND meeting_id = $2`, [id, m.id]);
}

function notifyRequest(m: Meeting, jr: JoinRequest, db?: Db) {
  return Promise.all([
    publish({ meetingId: m.id, type: "request_updated", audience: `jr:${jr.id}`, data: { id: jr.id, status: jr.status } }, db),
    publish({ meetingId: m.id, type: "requests_changed", audience: "moderators", data: { id: jr.id, status: jr.status } }, db),
  ]);
}

export async function submitJoinRequest(opts: {
  meeting: Meeting;
  session: Session;
  name: string;
  method: IdentityMethod | "sso";
  /** Verified org identity (SSO sign-in) for org meetings. */
  ssoEmail?: string | null;
}): Promise<JoinRequest> {
  const { meeting: m, session } = opts;
  if (isHost(m, session)) throw conflict("You host this meeting. Join directly from the host view.", "is_host");

  const jr = await tx(async (db) => {
    // Serialize per meeting+session so double-submits can't create two rows or race a decision.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${m.id}:${session.id}`]);

    const existing = await one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE meeting_id = $1 AND session_id = $2`, [m.id, session.id], db);
    // A decision sticks to the browser session: rejected/removed/blocked sessions can't re-request.
    if (existing) return { jr: existing, created: false };

    const verifiedContact =
      opts.method === "phone"
        ? session.verified_phone
        : opts.method === "email"
          ? session.verified_email
          : opts.method === "sso"
            ? (opts.ssoEmail ?? null)
            : null;
    const blocked = await isBlocked(m, session, db);
    const match = await matchInvitation(m.id, { verifiedContact, name: opts.name }, db);
    const decision = evaluateAdmission(
      {
        access_policy: m.access_policy,
        allow_name_only_requests: m.allow_name_only_requests,
        auto_admit_verified_invitees: m.auto_admit_verified_invitees,
        locked: m.locked_at !== null,
        ended: m.status === "ended",
      },
      { method: opts.method === "sso" ? "email" : opts.method, verified: verifiedContact !== null, match: match.match, blocked, isHost: false },
    );

    if (decision.outcome === "deny") {
      await audit(
        { meetingId: m.id, action: "join_denied", actorSessionId: session.id, reason: decision.code, metadata: { name: opts.name, method: opts.method } },
        db,
      );
      throw new HttpError(403, decision.code, decision.reason);
    }

    const status: JoinStatus = decision.outcome === "admit" ? "admitted" : "pending";
    const row = await one<JoinRequest>(
      `INSERT INTO join_requests (meeting_id, session_id, user_id, submitted_name, identity_method, verified_contact,
         verification_state, match_state, invitation_id, status, decided_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${JR_COLS}`,
      [
        m.id,
        session.id,
        session.user_id,
        opts.name,
        opts.method,
        verifiedContact,
        verifiedContact ? "verified" : "unverified",
        match.match,
        match.invitationId,
        status,
        status === "admitted" ? "policy" : null,
        status === "admitted" ? new Date() : null,
      ],
      db,
    );
    await audit(
      { meetingId: m.id, action: "join_requested", actorSessionId: session.id, targetId: row!.id, metadata: { method: opts.method, match: match.match } },
      db,
    );
    if (status === "admitted") await onAdmitted(m, row!, db, { userId: null, sessionId: null }, decision.reason);
    return { jr: row!, created: true };
  });
  if (jr.created) {
    await notifyRequest(m, jr.jr);
    if (jr.jr.status === "admitted") await emitWebhook(m, "participant.admitted", { name: jr.jr.submitted_name, requestId: jr.jr.id });
  }
  return jr.jr;
}

async function onAdmitted(m: Meeting, jr: JoinRequest, db: Db, actor: Actor, reason: string | null) {
  const role: MediaRole = m.mode === "broadcast" ? "audience" : "participant";
  if (jr.session_id) {
    await db.query(
      `INSERT INTO meeting_roles (meeting_id, guest_session_id, role, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (meeting_id, guest_session_id) WHERE guest_session_id IS NOT NULL DO NOTHING`,
      [m.id, jr.session_id, role, actor.userId],
    );
  }
  if (jr.invitation_id && jr.match_state === "verified_contact_match") {
    await db.query("UPDATE invitations SET invite_status = 'matched' WHERE id = $1 AND invite_status = 'pending'", [jr.invitation_id]);
  }
  const manual = actor.userId !== null || actor.sessionId !== null;
  await audit(
    { meetingId: m.id, action: manual ? "approved" : "auto_admitted", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: jr.id, reason },
    db,
  );
}

async function loadForUpdate(m: Meeting, requestId: string, db: Db): Promise<JoinRequest> {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw notFound("Request not found");
  const jr = await one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE id = $1 AND meeting_id = $2 FOR UPDATE`, [requestId, m.id], db);
  if (!jr) throw notFound("Request not found");
  return jr;
}

export async function approve(m: Meeting, actor: Actor, requestId: string): Promise<JoinRequest> {
  const r = await tx(async (db) => {
    const jr = await loadForUpdate(m, requestId, db);
    if (jr.status === "admitted") return { jr, changed: false };
    if (jr.status === "blocked") throw conflict("Unblock this person before admitting them.", "blocked");
    const updated = await one<JoinRequest>(
      `UPDATE join_requests SET status = 'admitted', decided_by = 'host', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 RETURNING ${JR_COLS}`,
      [jr.id, actor.userId],
      db,
    );
    await onAdmitted(m, updated!, db, actor, null);
    return { jr: updated!, changed: true };
  });
  if (r.changed) {
    await notifyRequest(m, r.jr);
    await emitWebhook(m, "participant.admitted", { name: r.jr.submitted_name, requestId: r.jr.id });
  }
  return r.jr;
}

export async function approveAll(m: Meeting, actor: Actor, filter: "all" | "invited" | "verified"): Promise<number> {
  const cond = filter === "invited" ? "AND match_state = 'verified_contact_match'" : filter === "verified" ? "AND verification_state = 'verified'" : "";
  const pending = await query<{ id: string }>(`SELECT id FROM join_requests WHERE meeting_id = $1 AND status = 'pending' ${cond}`, [m.id]);
  for (const p of pending) await approve(m, actor, p.id);
  return pending.length;
}

export async function reject(m: Meeting, actor: Actor, requestId: string, reason?: string): Promise<JoinRequest> {
  const jr = await tx(async (db) => {
    const jr = await loadForUpdate(m, requestId, db);
    if (jr.status !== "pending") throw conflict("Only waiting requests can be rejected. Use remove for people already in.", "not_pending");
    const updated = await one<JoinRequest>(
      `UPDATE join_requests SET status = 'rejected', decided_by = 'host', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 RETURNING ${JR_COLS}`,
      [jr.id, actor.userId],
      db,
    );
    await audit({ meetingId: m.id, action: "rejected", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: jr.id, reason: reason ?? null }, db);
    return updated!;
  });
  await notifyRequest(m, jr);
  return jr;
}

/** Removes an admitted (or waiting) person. With block=true they can't come back on this session, verified contact, or phone line. */
export async function remove(m: Meeting, actor: Actor, requestId: string, block: boolean, reason?: string): Promise<JoinRequest> {
  const updated = await tx(async (db) => {
    const jr = await loadForUpdate(m, requestId, db);
    if (jr.status === "blocked" || (jr.status === "removed" && !block)) return jr;
    // Co-hosts can't remove the people who appointed them, or each other.
    if (actor.userId === null && jr.session_id) {
      const target = await one<{ role: string }>("SELECT role FROM meeting_roles WHERE meeting_id = $1 AND guest_session_id = $2", [m.id, jr.session_id], db);
      if (target?.role === "cohost") throw forbidden("Only the host can remove a co-host.");
    }
    const status: JoinStatus = block ? "blocked" : "removed";
    const row = await one<JoinRequest>(
      `UPDATE join_requests SET status = $2, decided_by = 'host', reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 RETURNING ${JR_COLS}`,
      [jr.id, status, actor.userId],
      db,
    );
    if (jr.session_id) await db.query("DELETE FROM meeting_roles WHERE meeting_id = $1 AND guest_session_id = $2", [m.id, jr.session_id]);
    await db.query("DELETE FROM breakout_assignments WHERE meeting_id = $1 AND join_request_id = $2", [m.id, jr.id]);
    if (block) {
      await db.query(
        "INSERT INTO meeting_blocks (meeting_id, session_id, user_id, verified_contact, sip_identity, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [m.id, jr.session_id, jr.user_id, jr.verified_contact, jr.sip_identity, actor.userId],
      );
    }
    await audit(
      { meetingId: m.id, action: block ? "blocked" : "removed", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: jr.id, reason: reason ?? null },
      db,
    );
    return row!;
  });
  await kick(m, updated.sip_identity ?? guestIdentity(updated.id));
  await notifyRequest(m, updated);
  return updated;
}

export async function unblock(m: Meeting, actor: Actor, requestId: string): Promise<JoinRequest> {
  const jr = await tx(async (db) => {
    const jr = await loadForUpdate(m, requestId, db);
    if (jr.status !== "blocked") throw badRequest("This person is not blocked.");
    await db.query(
      `DELETE FROM meeting_blocks WHERE meeting_id = $1
         AND (session_id = $2 OR verified_contact = $3 OR sip_identity = $4)`,
      [m.id, jr.session_id, jr.verified_contact, jr.sip_identity],
    );
    const row = await one<JoinRequest>(`UPDATE join_requests SET status = 'removed' WHERE id = $1 RETURNING ${JR_COLS}`, [jr.id], db);
    await audit({ meetingId: m.id, action: "unblocked", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: jr.id }, db);
    return row!;
  });
  await notifyRequest(m, jr);
  return jr;
}

export async function setRole(m: Meeting, actor: Actor, requestId: string, role: "cohost" | "speaker" | "audience" | "participant"): Promise<MediaRole> {
  const jr = await tx(async (db) => {
    const jr = await loadForUpdate(m, requestId, db);
    if (jr.status !== "admitted" || !jr.session_id) throw conflict("Only admitted participants can change role.", "not_admitted");
    const current = await one<{ role: MediaRole }>("SELECT role FROM meeting_roles WHERE meeting_id = $1 AND guest_session_id = $2", [m.id, jr.session_id], db);
    if (!current) throw notFound("Role not found");
    // Only the host grants or revokes co-host.
    if ((role === "cohost" || current.role === "cohost") && actor.userId !== m.host_user_id) {
      throw forbidden("Only the host can change co-hosts.");
    }
    await db.query("UPDATE meeting_roles SET role = $3, granted_by = $4 WHERE meeting_id = $1 AND guest_session_id = $2", [
      m.id,
      jr.session_id,
      role,
      actor.userId,
    ]);
    await audit({ meetingId: m.id, action: "role_changed", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: jr.id, metadata: { from: current.role, role } }, db);
    return jr;
  });
  await updatePermissions(m, guestIdentity(jr.id), role);
  await publish({ meetingId: m.id, type: "role_changed", audience: `jr:${jr.id}`, data: { role } });
  await publish({ meetingId: m.id, type: "requests_changed", audience: "moderators" });
  return role;
}

/** Moderator listing. Contact details are masked; invitee lists stay host-only. */
export async function listForModerators(m: Meeting) {
  const rows = await query<JoinRequest & { expected_name: string | null; role: MediaRole | null; breakout_id: string | null }>(
    `SELECT ${JR_COLS.split(",").map((c) => `jr.${c.trim()}`).join(", ")}, i.expected_name, r.role, ba.breakout_id
       FROM join_requests jr
       LEFT JOIN invitations i ON i.id = jr.invitation_id
       LEFT JOIN meeting_roles r ON r.meeting_id = jr.meeting_id AND r.guest_session_id = jr.session_id
       LEFT JOIN breakout_assignments ba ON ba.meeting_id = jr.meeting_id AND ba.join_request_id = jr.id
      WHERE jr.meeting_id = $1
      ORDER BY jr.requested_at`,
    [m.id],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.submitted_name,
    status: r.status,
    method: r.identity_method,
    maskedContact: maskContact(r.verified_contact),
    matchState: r.match_state,
    invitedAs: r.expected_name,
    badges: badgesFor(r),
    role: r.role ?? (r.sip_identity ? "participant" : null),
    breakoutId: r.breakout_id,
    identity: r.sip_identity ?? guestIdentity(r.id),
    requestedAt: r.requested_at,
  }));
}
/** @deprecated use listForModerators */
export const listForHost = listForModerators;

export interface TokenViewer {
  kind: "host" | "cohost" | "participant" | "none";
  name: string;
  role: MediaRole | null;
  request: JoinRequest | null;
  session: Session | null;
  user: { id: string; display_name: string } | null;
}

/**
 * The only path to a media token. Hosts always pass; everyone else needs an
 * admitted join request bound to this browser session.
 */
export async function issueToken(m: Meeting, v: TokenViewer, opts: { room?: string | null } = {}) {
  if (!mediaConfigured()) {
    throw new HttpError(503, "media_not_configured", "Audio/video is not configured on this server (LIVEKIT_* variables are missing).");
  }
  if (m.status === "ended") throw forbidden("This meeting has ended.");
  const plan = await planForMeeting(m);
  const cap = m.mode === "broadcast" ? plan.maxParticipants + plan.maxAudience : plan.maxParticipants;

  // Fair-use: checked only when someone connects, never to cut off a running meeting.
  if (plan.monthlyParticipantMinutes !== null) {
    const used = await monthlyUsage({ orgId: m.org_id, userId: m.host_user_id }, "participant_minutes");
    const connected = await one<{ n: string }>(
      "SELECT count(*) AS n FROM participant_sessions WHERE meeting_id = $1 AND left_at IS NULL",
      [m.id],
    );
    if (used >= plan.monthlyParticipantMinutes && Number(connected?.n ?? 0) === 0) {
      throw new HttpError(
        402,
        "plan_limit",
        `This host has used this month's ${plan.monthlyParticipantMinutes.toLocaleString()} free participant-minutes. Meetings already running are not affected.`,
      );
    }
  }

  const isModerator = v.kind === "host" || v.kind === "cohost";
  let room = roomName(m);
  let breakoutId: string | null = null;
  if (m.breakouts_open) {
    if (isModerator && opts.room) {
      // Moderators may visit any breakout room.
      const b = await one<{ id: string }>("SELECT id FROM breakout_rooms WHERE id = $1 AND meeting_id = $2", [opts.room, m.id]);
      if (b) breakoutId = b.id;
    } else if (v.request) {
      const a = await one<{ breakout_id: string }>(
        "SELECT breakout_id FROM breakout_assignments WHERE meeting_id = $1 AND join_request_id = $2",
        [m.id, v.request.id],
      );
      breakoutId = a?.breakout_id ?? null;
    }
    if (breakoutId) room = breakoutRoomName(m, breakoutId);
  }

  if (v.kind === "host" && v.user) {
    await ensureRoom(room, cap);
    await markLive(m);
    await audit({ meetingId: m.id, action: "media_token_issued", actorUserId: v.user.id, metadata: { role: "host", room } });
    const t = await createMediaToken({
      meeting: m,
      room,
      identity: hostIdentity(v.user.id),
      name: v.user.display_name,
      role: "host",
      metadata: { role: "host", badges: ["host"] },
      attributes: { role: "host" },
    });
    if (m.status === "scheduled") await emitWebhook(m, "meeting.started", {});
    return { ...t, role: "host" as MediaRole, identity: hostIdentity(v.user.id), room, breakoutId };
  }

  const jr = v.request;
  if (!jr || jr.status !== "admitted" || !v.session) {
    throw new HttpError(403, "not_admitted", "You haven't been admitted to this meeting yet.");
  }
  // Blocks can be added for a contact after admission (e.g. via another session).
  if (await isBlocked(m, v.session, pool())) throw new HttpError(403, "blocked", "The host has removed you from this meeting.");
  const role = v.role ?? "participant";
  await ensureRoom(room, cap);
  await audit({ meetingId: m.id, action: "media_token_issued", actorSessionId: v.session.id, targetId: jr.id, metadata: { role, room } });
  const badges = badgesFor(jr);
  const t = await createMediaToken({
    meeting: m,
    room,
    identity: guestIdentity(jr.id),
    name: jr.submitted_name,
    role,
    metadata: { role, badges },
    attributes: { role },
  });
  return { ...t, role, identity: guestIdentity(jr.id), room, breakoutId };
}

/** Used by the LiveKit webhook to catch anyone in the room who is not admitted. */
export async function identityStillAllowed(m: Meeting, identity: string, _room?: string): Promise<boolean> {
  if (identity === hostIdentity(m.host_user_id)) return true;
  if (identity.startsWith("EG_") || identity.startsWith("egress")) return true; // recording/streaming compositor
  const parsed = parseIdentity(identity);
  if (parsed?.kind === "guest") {
    const jr = await one<{ status: string }>("SELECT status FROM join_requests WHERE id = $1 AND meeting_id = $2", [parsed.id, m.id]);
    return jr?.status === "admitted";
  }
  return false;
}

/**
 * Phone callers reach the room through LiveKit SIP after entering the meeting
 * PIN. Caller ID is not proof of identity, so callers are always labeled
 * "phone caller (unverified)" and subject to lock/block.
 */
export async function admitSipCaller(m: Meeting, sipIdentity: string, callerNumber: string | null): Promise<{ allowed: boolean; reason?: string }> {
  if (!m.dialin_enabled) return { allowed: false, reason: "dialin_disabled" };
  if (m.status === "ended") return { allowed: false, reason: "meeting_ended" };
  const blocked = await one("SELECT 1 FROM meeting_blocks WHERE meeting_id = $1 AND sip_identity = $2", [m.id, sipIdentity]);
  if (blocked) return { allowed: false, reason: "blocked" };
  const existing = await one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE meeting_id = $1 AND sip_identity = $2`, [m.id, sipIdentity]);
  if (existing) return { allowed: existing.status === "admitted", reason: existing.status };
  if (m.locked_at) return { allowed: false, reason: "locked" };
  const name = callerNumber ? `Phone ${maskContact(callerNumber)}` : "Phone caller";
  const jr = await one<JoinRequest>(
    `INSERT INTO join_requests (meeting_id, sip_identity, submitted_name, identity_method, verification_state, match_state, status, decided_by, reviewed_at)
     VALUES ($1, $2, $3, 'dialin', 'unverified', 'none', 'admitted', 'policy', now())
     ON CONFLICT (meeting_id, sip_identity) WHERE sip_identity IS NOT NULL DO NOTHING
     RETURNING ${JR_COLS}`,
    [m.id, sipIdentity, name],
  );
  if (jr) {
    await audit({ meetingId: m.id, action: "auto_admitted", targetId: jr.id, reason: "Dial-in with meeting PIN", metadata: { dialin: true } });
    await notifyRequest(m, jr);
  }
  return { allowed: true };
}

export async function sipIdentityAllowed(m: Meeting, sipIdentity: string): Promise<boolean> {
  const r = await one<{ status: string }>("SELECT status FROM join_requests WHERE meeting_id = $1 AND sip_identity = $2", [m.id, sipIdentity]);
  return r?.status === "admitted";
}

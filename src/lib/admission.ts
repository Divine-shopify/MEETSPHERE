import { audit } from "./audit";
import { maskContact } from "./contact";
import { one, query, tx, type Db, pool } from "./db";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./errors";
import { matchInvitation } from "./invitations";
import {
  createMediaToken,
  ensureRoom,
  guestIdentity,
  hostIdentity,
  kick,
  mediaConfigured,
  parseIdentity,
  updatePermissions,
  type MediaRole,
} from "./media";
import { markLive, type Meeting } from "./meetings";
import { evaluateAdmission, identityBadges, type IdentityMethod, type MatchState } from "./policy";
import { planFor } from "./plans";
import type { Session, User } from "./session";

export type JoinStatus = "pending" | "admitted" | "rejected" | "removed" | "blocked";

export interface JoinRequest {
  id: string;
  meeting_id: string;
  session_id: string;
  user_id: string | null;
  submitted_name: string;
  identity_method: IdentityMethod;
  verified_contact: string | null;
  verification_state: "verified" | "unverified";
  match_state: MatchState;
  invitation_id: string | null;
  status: JoinStatus;
  decided_by: "policy" | "host" | null;
  requested_at: string;
  reviewed_at: string | null;
}

const JR_COLS = `id, meeting_id, session_id, user_id, submitted_name, identity_method, verified_contact, verification_state,
  match_state, invitation_id, status, decided_by, requested_at, reviewed_at`;

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

/** Public, per-applicant view of their own request. */
export function applicantView(r: JoinRequest) {
  return {
    id: r.id,
    status: r.status,
    name: r.submitted_name,
    method: r.identity_method,
    verified: r.verification_state === "verified",
    badges: identityBadges(r),
  };
}

export async function getOwnRequest(m: Meeting, session: Session | null): Promise<JoinRequest | null> {
  if (!session) return null;
  return one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE meeting_id = $1 AND session_id = $2`, [m.id, session.id]);
}

export async function submitJoinRequest(opts: {
  meeting: Meeting;
  session: Session;
  name: string;
  method: IdentityMethod;
}): Promise<JoinRequest> {
  const { meeting: m, session } = opts;
  if (isHost(m, session)) throw conflict("You host this meeting. Join directly from the host view.", "is_host");

  return tx(async (db) => {
    // Serialize per meeting+session so double-submits can't create two rows or race a decision.
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${m.id}:${session.id}`]);

    const existing = await one<JoinRequest>(
      `SELECT ${JR_COLS} FROM join_requests WHERE meeting_id = $1 AND session_id = $2`,
      [m.id, session.id],
      db,
    );
    // A decision sticks to the browser session: rejected/removed/blocked sessions can't re-request.
    if (existing) return existing;

    const verifiedContact = opts.method === "phone" ? session.verified_phone : opts.method === "email" ? session.verified_email : null;
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
      { method: opts.method, verified: verifiedContact !== null, match: match.match, blocked, isHost: false },
    );

    if (decision.outcome === "deny") {
      await audit(
        { meetingId: m.id, action: "join_denied", actorSessionId: session.id, reason: decision.code, metadata: { name: opts.name, method: opts.method } },
        db,
      );
      throw new HttpError(403, decision.code, decision.reason);
    }

    const status: JoinStatus = decision.outcome === "admit" ? "admitted" : "pending";
    const jr = await one<JoinRequest>(
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
      { meetingId: m.id, action: "join_requested", actorSessionId: session.id, targetId: jr!.id, metadata: { method: opts.method, match: match.match } },
      db,
    );
    if (status === "admitted") await onAdmitted(m, jr!, db, null, decision.reason);
    return jr!;
  });
}

async function onAdmitted(m: Meeting, jr: JoinRequest, db: Db, actorUserId: string | null, reason: string | null) {
  const role: MediaRole = m.mode === "broadcast" ? "audience" : "participant";
  await db.query(
    `INSERT INTO meeting_roles (meeting_id, guest_session_id, role, granted_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (meeting_id, guest_session_id) WHERE guest_session_id IS NOT NULL DO NOTHING`,
    [m.id, jr.session_id, role, actorUserId],
  );
  if (jr.invitation_id && jr.match_state === "verified_contact_match") {
    await db.query("UPDATE invitations SET invite_status = 'matched' WHERE id = $1 AND invite_status = 'pending'", [jr.invitation_id]);
  }
  await audit(
    { meetingId: m.id, action: actorUserId ? "approved" : "auto_admitted", actorUserId, targetId: jr.id, reason },
    db,
  );
}

async function loadForHost(m: Meeting, requestId: string, db: Db): Promise<JoinRequest> {
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw notFound("Request not found");
  const jr = await one<JoinRequest>(`SELECT ${JR_COLS} FROM join_requests WHERE id = $1 AND meeting_id = $2 FOR UPDATE`, [requestId, m.id], db);
  if (!jr) throw notFound("Request not found");
  return jr;
}

export async function approve(m: Meeting, host: User, requestId: string): Promise<JoinRequest> {
  return tx(async (db) => {
    const jr = await loadForHost(m, requestId, db);
    if (jr.status === "admitted") return jr;
    if (jr.status === "blocked") throw conflict("Unblock this person before admitting them.", "blocked");
    const updated = await one<JoinRequest>(
      `UPDATE join_requests SET status = 'admitted', decided_by = 'host', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 RETURNING ${JR_COLS}`,
      [jr.id, host.id],
      db,
    );
    await onAdmitted(m, updated!, db, host.id, null);
    return updated!;
  });
}

export async function approveAll(m: Meeting, host: User, filter: "all" | "invited"): Promise<number> {
  const pending = await query<{ id: string }>(
    `SELECT id FROM join_requests WHERE meeting_id = $1 AND status = 'pending'
       ${filter === "invited" ? "AND match_state = 'verified_contact_match'" : ""}`,
    [m.id],
  );
  for (const p of pending) await approve(m, host, p.id);
  return pending.length;
}

export async function reject(m: Meeting, host: User, requestId: string, reason?: string): Promise<JoinRequest> {
  return tx(async (db) => {
    const jr = await loadForHost(m, requestId, db);
    if (jr.status !== "pending") throw conflict("Only waiting requests can be rejected. Use remove for people already in.", "not_pending");
    const updated = await one<JoinRequest>(
      `UPDATE join_requests SET status = 'rejected', decided_by = 'host', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 RETURNING ${JR_COLS}`,
      [jr.id, host.id],
      db,
    );
    await audit({ meetingId: m.id, action: "rejected", actorUserId: host.id, targetId: jr.id, reason: reason ?? null }, db);
    return updated!;
  });
}

/** Removes an admitted (or waiting) person. With block=true they can't come back on this session or verified contact. */
export async function remove(m: Meeting, host: User, requestId: string, block: boolean, reason?: string): Promise<JoinRequest> {
  const updated = await tx(async (db) => {
    const jr = await loadForHost(m, requestId, db);
    if (jr.status === "blocked" || (jr.status === "removed" && !block)) return jr;
    const status: JoinStatus = block ? "blocked" : "removed";
    const row = await one<JoinRequest>(
      `UPDATE join_requests SET status = $2, decided_by = 'host', reviewed_by = $3, reviewed_at = now()
       WHERE id = $1 RETURNING ${JR_COLS}`,
      [jr.id, status, host.id],
      db,
    );
    await db.query("DELETE FROM meeting_roles WHERE meeting_id = $1 AND guest_session_id = $2", [m.id, jr.session_id]);
    if (block) {
      await db.query(
        "INSERT INTO meeting_blocks (meeting_id, session_id, user_id, verified_contact, created_by) VALUES ($1, $2, $3, $4, $5)",
        [m.id, jr.session_id, jr.user_id, jr.verified_contact, host.id],
      );
    }
    await audit({ meetingId: m.id, action: block ? "blocked" : "removed", actorUserId: host.id, targetId: jr.id, reason: reason ?? null }, db);
    return row!;
  });
  await kick(m, guestIdentity(updated.id));
  return updated;
}

/**
 * "Removed" (not blocked) people may ask again from the same session only if
 * the host lets them: the host re-admits them explicitly with approve().
 */
export async function unblock(m: Meeting, host: User, requestId: string): Promise<JoinRequest> {
  return tx(async (db) => {
    const jr = await loadForHost(m, requestId, db);
    if (jr.status !== "blocked") throw badRequest("This person is not blocked.");
    await db.query("DELETE FROM meeting_blocks WHERE meeting_id = $1 AND (session_id = $2 OR verified_contact = $3)", [
      m.id,
      jr.session_id,
      jr.verified_contact,
    ]);
    const row = await one<JoinRequest>(`UPDATE join_requests SET status = 'removed' WHERE id = $1 RETURNING ${JR_COLS}`, [jr.id], db);
    await audit({ meetingId: m.id, action: "unblocked", actorUserId: host.id, targetId: jr.id }, db);
    return row!;
  });
}

export async function setRole(m: Meeting, host: User, requestId: string, role: "speaker" | "audience" | "participant"): Promise<MediaRole> {
  const r = await tx(async (db) => {
    const jr = await loadForHost(m, requestId, db);
    if (jr.status !== "admitted") throw conflict("Only admitted participants can change role.", "not_admitted");
    const res = await db.query("UPDATE meeting_roles SET role = $3, granted_by = $4 WHERE meeting_id = $1 AND guest_session_id = $2", [
      m.id,
      jr.session_id,
      role,
      host.id,
    ]);
    if (!res.rowCount) throw notFound("Role not found");
    await audit({ meetingId: m.id, action: "role_changed", actorUserId: host.id, targetId: jr.id, metadata: { role } }, db);
    return jr;
  });
  await updatePermissions(m, guestIdentity(r.id), role);
  return role;
}

/** Host-only listing. Contact details are masked even for the host; invitee lists stay host-only. */
export async function listForHost(m: Meeting) {
  const rows = await query<JoinRequest & { expected_name: string | null; role: MediaRole | null }>(
    `SELECT ${JR_COLS.split(",").map((c) => `jr.${c.trim()}`).join(", ")}, i.expected_name, r.role
       FROM join_requests jr
       LEFT JOIN invitations i ON i.id = jr.invitation_id
       LEFT JOIN meeting_roles r ON r.meeting_id = jr.meeting_id AND r.guest_session_id = jr.session_id
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
    badges: identityBadges(r),
    role: r.role,
    identity: guestIdentity(r.id),
    requestedAt: r.requested_at,
  }));
}

/**
 * The only path to a media token. Hosts always pass; everyone else needs an
 * admitted join request bound to this browser session.
 */
export async function issueToken(m: Meeting, session: Session | null, user: User | null) {
  if (!mediaConfigured()) {
    throw new HttpError(503, "media_not_configured", "Audio/video is not configured on this server (LIVEKIT_* variables are missing).");
  }
  if (m.status === "ended") throw forbidden("This meeting has ended.");
  const plan = planFor(m.host_user_id);

  if (session && user && isHost(m, session)) {
    await ensureRoom(m, plan.maxParticipants);
    await markLive(m);
    await audit({ meetingId: m.id, action: "media_token_issued", actorUserId: user.id, metadata: { role: "host" } });
    const t = await createMediaToken({
      meeting: m,
      identity: hostIdentity(user.id),
      name: user.display_name,
      role: "host",
      metadata: { role: "host", badges: ["host"] },
      attributes: { role: "host" },
    });
    return { ...t, role: "host" as MediaRole, identity: hostIdentity(user.id) };
  }

  const jr = await getOwnRequest(m, session);
  if (!jr || jr.status !== "admitted") {
    throw new HttpError(403, "not_admitted", "You haven't been admitted to this meeting yet.");
  }
  // Blocks can be added for a contact after admission (e.g. via another session).
  if (await isBlocked(m, session!, pool())) throw new HttpError(403, "blocked", "The host has removed you from this meeting.");
  const roleRow = await one<{ role: MediaRole }>(
    "SELECT role FROM meeting_roles WHERE meeting_id = $1 AND guest_session_id = $2",
    [m.id, jr.session_id],
  );
  const role = roleRow?.role ?? "participant";
  await ensureRoom(m, plan.maxParticipants);
  await audit({ meetingId: m.id, action: "media_token_issued", actorSessionId: session!.id, targetId: jr.id, metadata: { role } });
  const badges = identityBadges(jr);
  const t = await createMediaToken({
    meeting: m,
    identity: guestIdentity(jr.id),
    name: jr.submitted_name,
    role,
    metadata: { role, badges },
    attributes: { role },
  });
  return { ...t, role, identity: guestIdentity(jr.id) };
}

/** Used by the LiveKit webhook to catch anyone in the room who is not admitted. */
export async function identityStillAllowed(m: Meeting, identity: string): Promise<boolean> {
  if (identity === hostIdentity(m.host_user_id)) return true;
  const parsed = parseIdentity(identity);
  if (parsed?.kind !== "guest") return false;
  const jr = await one<{ status: string }>("SELECT status FROM join_requests WHERE id = $1 AND meeting_id = $2", [parsed.id, m.id]);
  return jr?.status === "admitted";
}

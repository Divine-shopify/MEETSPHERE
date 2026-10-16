import { randomUUID } from "node:crypto";
import { config } from "./config";
import { maskContact, normalizeEmail, normalizePhone } from "./contact";
import { generateOtp, hmac, safeEqual } from "./crypto";
import { one, pool, query, tx } from "./db";
import { badRequest, HttpError, tooManyRequests } from "./errors";
import { deliverCode, type Channel } from "./messaging";
import { hit } from "./ratelimit";
import { claimMemberships } from "./orgs";
import { rotateSessionToken, type Session } from "./session";

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export type Purpose = "signin" | "join";

export function normalizeDestination(channel: Channel, raw: string): string {
  const v = channel === "phone" ? normalizePhone(raw) : normalizeEmail(raw);
  if (!v) {
    throw badRequest(
      channel === "phone" ? "Enter a valid phone number including country code, e.g. +44 7700 900123." : "Enter a valid email address.",
      "invalid_contact",
    );
  }
  return v;
}

function codeDigest(challengeId: string, code: string): Buffer {
  return hmac(`${challengeId}:${code}`);
}

export interface StartResult {
  challengeId: string;
  delivery: "provider" | "dev";
  /** Only present in dev mode, where no message was actually sent. */
  devCode?: string;
  maskedDestination: string;
  expiresInSeconds: number;
}

export async function startVerification(opts: {
  session: Session;
  channel: Channel;
  destination: string;
  purpose: Purpose;
  ip: string;
  /** Host whose plan pays for this send (join verifications). */
  billedHostId?: string | null;
  meetingId?: string | null;
}): Promise<StartResult> {
  const destination = normalizeDestination(opts.channel, opts.destination);

  // Organizations that enforce SSO don't allow email-code sign-in for their domains.
  if (opts.purpose === "signin" && opts.channel === "email") {
    const org = await one<{ slug: string }>(
      `SELECT o.slug FROM organizations o LEFT JOIN sso_configs s ON s.org_id = o.id
        WHERE o.sso_enforced AND s.enabled AND ($1 = ANY(s.email_domains) OR $1 = ANY(o.allowed_email_domains)) LIMIT 1`,
      [destination.split("@")[1]],
    );
    if (org) throw new HttpError(403, "sso_required", `Your organization requires single sign-on. Use "Sign in with SSO" (${org.slug}).`);
  }

  // Abuse protection: per-destination cooldown and hourly caps per destination, IP and session.
  const checks: Array<[string, number, number]> = [
    [`otp:cooldown:${destination}`, 1, 30],
    [`otp:dest:${destination}`, 5, 3600],
    [`otp:ip:${opts.ip}`, 20, 3600],
    [`otp:session:${opts.session.id}`, 10, 3600],
  ];
  for (const [key, limit, win] of checks) {
    if (!(await hit(key, limit, win))) {
      throw tooManyRequests("Too many codes requested. Please wait a little before trying again.");
    }
  }

  if (opts.billedHostId) {
    const row = await one<{ n: string }>(
      `SELECT coalesce(sum(quantity), 0) AS n FROM usage_events
       WHERE host_user_id = $1 AND kind IN ('otp_sms', 'otp_email') AND created_at > now() - interval '1 day'`,
      [opts.billedHostId],
    );
    if (Number(row?.n ?? 0) >= config.freePlan.otpSendsPerHostPerDay) {
      throw new HttpError(429, "plan_limit", "This meeting's host has reached today's verification limit. Ask the host to admit you by name.");
    }
  }

  const id = randomUUID();
  const code = generateOtp();
  const delivery = await deliverCode(opts.channel, destination, code);

  await tx(async (db) => {
    // Only the newest code for a session+destination stays valid.
    await db.query(
      `UPDATE verification_challenges SET consumed_at = now()
       WHERE session_id = $1 AND destination = $2 AND consumed_at IS NULL`,
      [opts.session.id, destination],
    );
    await db.query(
      `INSERT INTO verification_challenges (id, session_id, channel, destination, purpose, code_hash, max_attempts, delivery, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9))`,
      [id, opts.session.id, opts.channel, destination, opts.purpose, codeDigest(id, code), MAX_ATTEMPTS, delivery, CODE_TTL_MINUTES],
    );
    if (delivery === "provider") {
      await db.query("INSERT INTO usage_events (host_user_id, meeting_id, kind) VALUES ($1, $2, $3)", [
        opts.billedHostId ?? null,
        opts.meetingId ?? null,
        opts.channel === "phone" ? "otp_sms" : "otp_email",
      ]);
    }
  });

  if (delivery === "dev") {
    console.info(`[verification] DEV MODE - no message sent. Code for ${maskContact(destination)}: ${code}`);
  }

  return {
    challengeId: id,
    delivery,
    devCode: delivery === "dev" ? code : undefined,
    maskedDestination: maskContact(destination)!,
    expiresInSeconds: CODE_TTL_MINUTES * 60,
  };
}

export interface CheckResult {
  channel: Channel;
  destination: string;
  purpose: Purpose;
  userId: string | null;
  /** New session token when the session was upgraded to a signed-in user. */
  rotatedToken?: string;
}

export async function checkVerification(opts: {
  session: Session;
  challengeId: string;
  code: string;
  displayName?: string;
}): Promise<CheckResult> {
  const code = opts.code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw badRequest("Enter the 6-digit code.", "invalid_code");

  // Count the attempt before comparing so parallel guesses can't exceed the cap.
  const ch = await one<{
    id: string;
    channel: Channel;
    destination: string;
    purpose: Purpose;
    code_hash: Buffer;
    attempts: number;
    max_attempts: number;
    expired: boolean;
  }>(
    `UPDATE verification_challenges SET attempts = attempts + 1
     WHERE id = $1 AND session_id = $2 AND consumed_at IS NULL AND attempts < max_attempts
     RETURNING id, channel, destination, purpose, code_hash, attempts, max_attempts, expires_at < now() AS expired`,
    [opts.challengeId, opts.session.id],
  );
  if (!ch) throw badRequest("This code is no longer valid. Request a new one.", "code_invalid");
  if (ch.expired) throw badRequest("This code has expired. Request a new one.", "code_expired");
  if (!safeEqual(codeDigest(ch.id, code), ch.code_hash)) {
    const left = ch.max_attempts - ch.attempts;
    throw badRequest(
      left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Incorrect code. Request a new one.",
      "code_incorrect",
    );
  }

  return tx(async (db) => {
    await db.query("UPDATE verification_challenges SET consumed_at = now() WHERE id = $1", [ch.id]);
    const col = ch.channel === "phone" ? "phone" : "email";
    await db.query(`UPDATE sessions SET verified_${col} = $1, ${col}_verified_at = now() WHERE id = $2`, [ch.destination, opts.session.id]);

    if (ch.purpose !== "signin") {
      return { channel: ch.channel, destination: ch.destination, purpose: ch.purpose, userId: opts.session.user_id };
    }

    const userCol = ch.channel === "phone" ? "phone_e164" : "email";
    let user = await one<{ id: string }>(`SELECT id FROM users WHERE ${userCol} = $1`, [ch.destination], db);
    if (user) {
      await db.query(`UPDATE users SET ${col}_verified_at = coalesce(${col}_verified_at, now()) WHERE id = $1`, [user.id]);
    } else {
      const name = opts.displayName?.trim().slice(0, 80) || "Host";
      user = await one<{ id: string }>(
        `INSERT INTO users (display_name, ${userCol}, ${col}_verified_at) VALUES ($1, $2, now()) RETURNING id`,
        [name, ch.destination],
        db,
      );
    }
    if (ch.channel === "email") await claimMemberships(user!.id, ch.destination, db);
    await db.query("UPDATE sessions SET user_id = $1 WHERE id = $2", [user!.id, opts.session.id]);
    const rotatedToken = await rotateSessionToken(opts.session.id, db);
    return { channel: ch.channel, destination: ch.destination, purpose: ch.purpose, userId: user!.id, rotatedToken };
  });
}

export async function pruneExpiredChallenges(): Promise<void> {
  await query("DELETE FROM verification_challenges WHERE expires_at < now() - interval '1 day'", [], pool());
}

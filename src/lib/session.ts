import { config } from "./config";
import { one, type Db, pool } from "./db";
import { randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "ms_session";
const SESSION_DAYS = 30;

export interface Session {
  id: string;
  user_id: string | null;
  verified_phone: string | null;
  verified_email: string | null;
}

export interface User {
  id: string;
  display_name: string;
  phone_e164: string | null;
  email: string | null;
}

const SESSION_COLUMNS = "id, user_id, verified_phone, verified_email";

export async function findSessionByToken(token: string, db: Db = pool()): Promise<Session | null> {
  if (!token || token.length > 100) return null;
  return one<Session>(
    `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
     WHERE token_hash = $1 AND expires_at > now()
     RETURNING ${SESSION_COLUMNS}`,
    [sha256(token), SESSION_DAYS],
    db,
  );
}

export async function createSession(db: Db = pool()): Promise<{ session: Session; token: string }> {
  const token = randomToken();
  const session = await one<Session>(
    `INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + make_interval(days => $2))
     RETURNING ${SESSION_COLUMNS}`,
    [sha256(token), SESSION_DAYS],
    db,
  );
  return { session: session!, token };
}

/** Issue a fresh token for an existing session (on sign-in) to prevent fixation. */
export async function rotateSessionToken(sessionId: string, db: Db = pool()): Promise<string> {
  const token = randomToken();
  await db.query("UPDATE sessions SET token_hash = $1 WHERE id = $2", [sha256(token), sessionId]);
  return token;
}

export async function destroySession(sessionId: string, db: Db = pool()): Promise<void> {
  await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function getUser(userId: string, db: Db = pool()): Promise<User | null> {
  return one<User>("SELECT id, display_name, phone_e164, email FROM users WHERE id = $1", [userId], db);
}

export function sessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 24 * 3600}`,
  ];
  if (config.isProduction) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

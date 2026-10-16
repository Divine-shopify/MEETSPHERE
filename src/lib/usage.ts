import { one, pool, type Db } from "./db";

export type UsageKind =
  | "otp_sms"
  | "otp_email"
  | "invite_sms"
  | "invite_email"
  | "participant_minutes"
  | "recording_minutes"
  | "stream_minutes"
  | "transcription_minutes"
  | "ai_summary"
  | "dialin_minutes";

export async function recordUsage(
  e: { kind: UsageKind; quantity?: number; hostUserId?: string | null; orgId?: string | null; meetingId?: string | null },
  db: Db = pool(),
): Promise<void> {
  if ((e.quantity ?? 1) <= 0) return;
  await db.query("INSERT INTO usage_events (host_user_id, org_id, meeting_id, kind, quantity) VALUES ($1, $2, $3, $4, $5)", [
    e.hostUserId ?? null,
    e.orgId ?? null,
    e.meetingId ?? null,
    e.kind,
    e.quantity ?? 1,
  ]);
}

/** Usage this calendar month for the billing owner (org if set, else host). */
export async function monthlyUsage(owner: { orgId?: string | null; userId?: string | null }, kind: UsageKind, db: Db = pool()): Promise<number> {
  const row = owner.orgId
    ? await one<{ n: string }>(
        "SELECT coalesce(sum(quantity), 0) AS n FROM usage_events WHERE org_id = $1 AND kind = $2 AND created_at >= date_trunc('month', now())",
        [owner.orgId, kind],
        db,
      )
    : await one<{ n: string }>(
        "SELECT coalesce(sum(quantity), 0) AS n FROM usage_events WHERE host_user_id = $1 AND org_id IS NULL AND kind = $2 AND created_at >= date_trunc('month', now())",
        [owner.userId, kind],
        db,
      );
  return Number(row?.n ?? 0);
}

export async function dailyUsage(owner: { orgId?: string | null; userId?: string | null }, kinds: UsageKind[], db: Db = pool()): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT coalesce(sum(quantity), 0) AS n FROM usage_events
      WHERE ${owner.orgId ? "org_id = $1" : "host_user_id = $1"} AND kind = ANY($2::text[]) AND created_at > now() - interval '1 day'`,
    [owner.orgId ?? owner.userId, kinds],
    db,
  );
  return Number(row?.n ?? 0);
}

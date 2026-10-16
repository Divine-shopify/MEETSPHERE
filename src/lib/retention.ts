import { query } from "./db";
import { deletePrefix, type StorageMode } from "./storage";

/**
 * Housekeeping and data-retention enforcement. Safe to run repeatedly
 * (e.g. hourly from cron hitting /api/cron/cleanup).
 */
export async function runCleanup() {
  const out: Record<string, number> = {};
  const count = async (label: string, sql: string, params: unknown[] = []) => {
    const rows = await query(sql, params);
    out[label] = rows.length;
  };

  await count("sessions", "DELETE FROM sessions WHERE expires_at < now() RETURNING 1");
  await count("challenges", "DELETE FROM verification_challenges WHERE expires_at < now() - interval '1 day' RETURNING 1");
  await count("rateLimits", "DELETE FROM rate_limits WHERE window_start < now() - interval '2 days' RETURNING 1");
  await count("ssoStates", "DELETE FROM sso_states WHERE created_at < now() - interval '1 hour' RETURNING 1");
  await count("staleMediaSessions", "UPDATE participant_sessions SET left_at = now() WHERE left_at IS NULL AND joined_at < now() - interval '24 hours' RETURNING 1");
  await count("webhookDeliveries", "DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days' RETURNING 1");

  // Recordings/streams past their retention date.
  const expired = await query<{ id: string; storage: StorageMode; storage_key: string }>(
    "SELECT id, storage, storage_key FROM meeting_artifacts WHERE retention_until < now() AND status IN ('ready', 'failed') AND storage_key IS NOT NULL",
  );
  for (const a of expired) {
    try {
      await deletePrefix(a.storage, a.storage_key);
      await query("UPDATE meeting_artifacts SET status = 'deleted' WHERE id = $1", [a.id]);
    } catch (err) {
      console.warn("[retention] delete failed", a.id, (err as Error).message);
    }
  }
  out.artifacts = expired.length;

  // Meeting content and personal data once the meeting's retention window has passed.
  const meetings = await query<{ id: string }>(
    `SELECT m.id FROM meetings m LEFT JOIN organizations o ON o.id = m.org_id
      WHERE m.status = 'ended' AND coalesce(m.retention_days, o.retention_days) IS NOT NULL
        AND m.ended_at < now() - make_interval(days => coalesce(m.retention_days, o.retention_days))
        AND EXISTS (SELECT 1 FROM join_requests jr WHERE jr.meeting_id = m.id AND jr.submitted_name <> 'Removed (retention)')`,
  );
  for (const m of meetings) {
    await query("DELETE FROM transcript_segments WHERE meeting_id = $1", [m.id]);
    await query("DELETE FROM meeting_notes WHERE meeting_id = $1", [m.id]);
    await query("DELETE FROM questions WHERE meeting_id = $1", [m.id]);
    await query("DELETE FROM polls WHERE meeting_id = $1", [m.id]);
    await query("DELETE FROM whiteboard_strokes WHERE meeting_id = $1", [m.id]);
    await query("DELETE FROM consents WHERE meeting_id = $1", [m.id]);
    await query(
      "UPDATE join_requests SET submitted_name = 'Removed (retention)', verified_contact = NULL, sip_identity = NULL WHERE meeting_id = $1",
      [m.id],
    );
    await query("UPDATE moderation_events SET metadata = '{}'::jsonb, reason = NULL WHERE meeting_id = $1", [m.id]);
  }
  out.meetingsScrubbed = meetings.length;
  return out;
}

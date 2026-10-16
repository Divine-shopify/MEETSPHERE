import { pool, query, type Db } from "./db";

export type AuditAction =
  | "meeting_created"
  | "settings_changed"
  | "meeting_locked"
  | "meeting_unlocked"
  | "meeting_ended"
  | "invitations_added"
  | "invitation_revoked"
  | "join_requested"
  | "join_denied"
  | "auto_admitted"
  | "approved"
  | "rejected"
  | "removed"
  | "blocked"
  | "unblocked"
  | "muted"
  | "role_changed"
  | "media_token_issued"
  | "participant_joined"
  | "participant_left"
  | "unauthorized_media_join_kicked";

export async function audit(
  e: {
    meetingId: string;
    action: AuditAction;
    actorUserId?: string | null;
    actorSessionId?: string | null;
    targetId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
  db: Db = pool(),
): Promise<void> {
  await db.query(
    `INSERT INTO moderation_events (meeting_id, actor_user_id, actor_session_id, target_id, action, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.meetingId, e.actorUserId ?? null, e.actorSessionId ?? null, e.targetId ?? null, e.action, e.reason ?? null, JSON.stringify(e.metadata ?? {})],
  );
}

export interface AuditRow {
  id: string;
  action: AuditAction;
  actor_name: string | null;
  target_name: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listAudit(meetingId: string, limit = 200): Promise<AuditRow[]> {
  return query<AuditRow>(
    `SELECT e.id, e.action, e.reason, e.metadata, e.created_at,
            coalesce(u.display_name, ajr.submitted_name) AS actor_name,
            tjr.submitted_name AS target_name
       FROM moderation_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       LEFT JOIN join_requests ajr ON ajr.meeting_id = e.meeting_id AND ajr.session_id = e.actor_session_id
       LEFT JOIN join_requests tjr ON tjr.id = e.target_id
      WHERE e.meeting_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2`,
    [meetingId, limit],
  );
}

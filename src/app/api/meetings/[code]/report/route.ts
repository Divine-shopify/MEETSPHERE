import { z } from "zod";
import { audit } from "@/lib/audit";
import { pool } from "@/lib/db";
import { publish } from "@/lib/events";
import { route } from "@/lib/http";
import { enforce } from "@/lib/ratelimit";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };
const schema = z.object({
  targetRequestId: z.string().uuid().nullish(),
  reason: z.enum(["harassment", "spam", "inappropriate_content", "impersonation", "other"]),
  details: z.string().trim().max(2000).optional(),
});

/** Any participant can report abuse to the host and the platform's trust & safety queue. */
export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  const body = await ctx.json(schema);
  await enforce(`report:${viewer.key}`, 5, 3600);
  const target = body.targetRequestId
    ? (await pool().query("SELECT id FROM join_requests WHERE id = $1 AND meeting_id = $2", [body.targetRequestId, meeting.id])).rows[0]?.id
    : null;
  await pool().query(
    "INSERT INTO abuse_reports (meeting_id, reporter_key, target_request_id, reason, details) VALUES ($1, $2, $3, $4, $5)",
    [meeting.id, viewer.key, target ?? null, body.reason, body.details ?? null],
  );
  await audit({ meetingId: meeting.id, action: "abuse_reported", actorSessionId: viewer.actorSessionId, actorUserId: viewer.actorUserId, targetId: target, reason: body.reason });
  await publish({ meetingId: meeting.id, type: "safety_alert", audience: "moderators", data: { code: "abuse_report" } });
  return Response.json({ ok: true }, { status: 201 });
});

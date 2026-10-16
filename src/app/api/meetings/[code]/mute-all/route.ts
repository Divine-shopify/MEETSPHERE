import { audit } from "@/lib/audit";
import { query } from "@/lib/db";
import { route } from "@/lib/http";
import { muteMicrophone } from "@/lib/media";
import { actorOf, requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  // Everyone connected, in any room, except moderators.
  const rows = await query<{ identity: string }>(
    `SELECT DISTINCT ps.identity FROM participant_sessions ps
      WHERE ps.meeting_id = $1 AND ps.left_at IS NULL AND ps.identity NOT LIKE 'host:%'
        AND NOT EXISTS (
          SELECT 1 FROM join_requests jr JOIN meeting_roles r ON r.meeting_id = jr.meeting_id AND r.guest_session_id = jr.session_id
           WHERE jr.meeting_id = ps.meeting_id AND ps.identity = 'jr:' || jr.id AND r.role = 'cohost')`,
    [meeting.id],
  );
  const results = await Promise.all(rows.map((r) => muteMicrophone(meeting, r.identity).catch(() => false)));
  const muted = results.filter(Boolean).length;
  const actor = actorOf(viewer);
  await audit({ meetingId: meeting.id, action: "muted", actorUserId: actor.userId, actorSessionId: actor.sessionId, metadata: { all: true, count: muted } });
  return { muted };
});

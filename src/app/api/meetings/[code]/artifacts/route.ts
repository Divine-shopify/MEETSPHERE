import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { listArtifacts } from "@/lib/recording";
import { canViewReplay } from "@/lib/replay";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  if (!(await canViewReplay(ctx, meeting))) throw forbidden("You don't have access to recordings of this meeting.");
  const items = await listArtifacts(meeting.id);
  return {
    artifacts: items.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      sizeBytes: a.size_bytes ? Number(a.size_bytes) : null,
      durationMs: a.duration_ms ? Number(a.duration_ms) : null,
      error: a.status === "failed" ? a.error : null,
      createdAt: a.created_at,
      retentionUntil: a.retention_until,
    })),
  };
});

import { audit } from "@/lib/audit";
import { one, pool } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import type { Artifact } from "@/lib/recording";
import { canViewReplay } from "@/lib/replay";
import { deletePrefix, localFileResponse, presignedUrl } from "@/lib/storage";

type P = { code: string; id: string };

async function load(meetingId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Recording not found");
  const a = await one<Artifact>("SELECT * FROM meeting_artifacts WHERE id = $1 AND meeting_id = $2 AND status = 'ready'", [id, meetingId]);
  if (!a || !a.storage_key || !a.storage) throw notFound("Recording not found");
  return a;
}

/** Plays (Range-capable) or downloads a recording. HLS streams are served by the stream route. */
export const GET = route<P>(async (ctx, { code, id }) => {
  const meeting = await requireMeeting(code);
  if (!(await canViewReplay(ctx, meeting))) throw forbidden("You don't have access to this recording.");
  const a = await load(meeting.id, id);
  if (a.type !== "recording") throw notFound("Recording not found");
  const download = new URL(ctx.req.url).searchParams.get("download") ? `${meeting.code}-${a.created_at.toString().slice(0, 10)}.mp4` : undefined;
  if (a.storage === "local") return localFileResponse(a.storage_key!, ctx.req, { download });
  return Response.redirect(await presignedUrl(a.storage_key!, 600, download), 302);
});

export const DELETE = route<P>(async (ctx, { code, id }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const a = await load(meeting.id, id);
  await deletePrefix(a.storage!, a.storage_key!);
  await pool().query("UPDATE meeting_artifacts SET status = 'deleted' WHERE id = $1", [a.id]);
  await audit({ meetingId: meeting.id, action: "artifact_deleted", actorUserId: user.id, targetId: a.id });
  return { ok: true };
});

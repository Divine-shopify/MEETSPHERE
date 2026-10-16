import { listForModerators } from "@/lib/admission";
import { query } from "@/lib/db";
import { route } from "@/lib/http";
import { hostView } from "@/lib/meetings";
import { requireModerator } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const [requests, online] = await Promise.all([
    listForModerators(meeting),
    query<{ identity: string; room: string }>(
      "SELECT DISTINCT identity, room FROM participant_sessions WHERE meeting_id = $1 AND left_at IS NULL",
      [meeting.id],
    ),
  ]);
  const roomOf = new Map(online.map((o) => [o.identity, o.room]));
  return {
    meeting: hostView(meeting),
    viewer: { kind: viewer.kind, key: viewer.key },
    requests: requests.map((r) => ({ ...r, connected: roomOf.has(r.identity), room: roomOf.get(r.identity) ?? null })),
  };
});

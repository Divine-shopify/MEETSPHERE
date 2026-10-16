import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { hostView, nextOccurrence, reopenMeeting } from "@/lib/meetings";

type P = { code: string };

/** Start the next session of a recurring/ended meeting on the same link. */
export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const next = meeting.scheduled_at ? nextOccurrence(new Date(meeting.scheduled_at), meeting.recurrence) : null;
  return { meeting: hostView(await reopenMeeting(meeting, user.id, next)) };
});

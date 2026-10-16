import { route } from "@/lib/http";
import { addSegment, segmentSchema } from "@/lib/transcripts";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  const { text } = await ctx.json(segmentSchema);
  await addSegment(meeting, viewer, text);
  return { ok: true };
});

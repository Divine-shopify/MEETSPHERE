import { route } from "@/lib/http";
import { addStroke, getStrokes, strokeSchema } from "@/lib/whiteboard";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting } = await requireParticipant(ctx, code);
  const since = Number(new URL(ctx.req.url).searchParams.get("since") ?? 0) || 0;
  return { strokes: await getStrokes(meeting, since), enabled: meeting.whiteboard_enabled };
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return addStroke(meeting, viewer, await ctx.json(strokeSchema));
});

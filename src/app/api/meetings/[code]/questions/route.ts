import { route } from "@/lib/http";
import { ask, askSchema, list } from "@/lib/qa";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return { questions: await list(meeting, viewer), moderator: viewer.moderator };
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return Response.json(await ask(meeting, viewer, await ctx.json(askSchema)), { status: 201 });
});

import { route } from "@/lib/http";
import { createPoll, createPollSchema, listPolls } from "@/lib/polls";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return { polls: await listPolls(meeting, viewer), moderator: viewer.moderator };
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return Response.json(await createPoll(meeting, viewer, await ctx.json(createPollSchema)), { status: 201 });
});

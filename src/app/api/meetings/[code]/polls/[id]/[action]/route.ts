import { notFound } from "@/lib/errors";
import { route } from "@/lib/http";
import { actOnPoll, castVote, pollActionSchema, voteSchema } from "@/lib/polls";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string; id: string; action: string };

export const POST = route<P>(async (ctx, { code, id, action }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  if (action === "vote") {
    const { options } = await ctx.json(voteSchema);
    await castVote(meeting, viewer, id, options);
  } else if (action === "manage") {
    const { action: a } = await ctx.json(pollActionSchema);
    await actOnPoll(meeting, viewer, id, a);
  } else throw notFound("Unknown action");
  return { ok: true };
});

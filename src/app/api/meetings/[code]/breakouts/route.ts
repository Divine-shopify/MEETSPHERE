import { breakoutSchema, listBreakouts, manageBreakouts } from "@/lib/breakouts";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { requireModerator, requireParticipant } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return listBreakouts(meeting, viewer);
});

export const POST = route<P>(async (ctx, { code }) => {
  const { viewer } = await requireModerator(ctx, code);
  const input = await ctx.json(breakoutSchema);
  const meeting = await requireMeeting(code); // fresh state
  await manageBreakouts(meeting, viewer, input);
  return listBreakouts(await requireMeeting(code), viewer);
});

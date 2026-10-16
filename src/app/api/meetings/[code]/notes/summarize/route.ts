import { route } from "@/lib/http";
import { generateSummary } from "@/lib/notes";
import { enforce } from "@/lib/ratelimit";
import { requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  await enforce(`summary:${meeting.id}`, 5, 3600, "You've generated several summaries this hour. Try again later.");
  return { notes: await generateSummary(meeting, viewer.actorUserId) };
});

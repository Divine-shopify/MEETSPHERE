import { z } from "zod";
import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { aiConfigured, getNotes, saveHostNotes } from "@/lib/notes";
import { canViewReplay } from "@/lib/replay";
import { requireModerator } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  if (!(await canViewReplay(ctx, meeting))) throw forbidden("You don't have access to these notes.");
  return { notes: await getNotes(meeting), aiConfigured: aiConfigured() };
});

export const PUT = route<P>(async (ctx, { code }) => {
  const { meeting } = await requireModerator(ctx, code);
  const { hostNotes } = await ctx.json(z.object({ hostNotes: z.string().max(50000) }));
  await saveHostNotes(meeting, hostNotes);
  return { notes: await getNotes(meeting) };
});

import { z } from "zod";
import { route } from "@/lib/http";
import { setTranscription } from "@/lib/transcripts";
import { requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const { on } = await ctx.json(z.object({ on: z.boolean() }));
  await setTranscription(meeting, viewer, on);
  return { active: on };
});

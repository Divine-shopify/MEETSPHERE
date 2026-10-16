import { z } from "zod";
import { notFound } from "@/lib/errors";
import { route } from "@/lib/http";
import { moderate, moderateSchema, vote } from "@/lib/qa";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string; id: string; action: string };

export const POST = route<P>(async (ctx, { code, id, action }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  if (action === "vote") {
    const { up } = await ctx.json(z.object({ up: z.boolean() }));
    await vote(meeting, viewer, id, up);
  } else if (action === "moderate") {
    const { action: a } = await ctx.json(moderateSchema);
    await moderate(meeting, viewer, id, a);
  } else throw notFound("Unknown action");
  return { ok: true };
});

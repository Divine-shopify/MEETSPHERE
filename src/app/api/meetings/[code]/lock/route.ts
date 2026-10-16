import { z } from "zod";
import { route } from "@/lib/http";
import { hostView, setLocked } from "@/lib/meetings";
import { actorOf, requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const { locked } = await ctx.json(z.object({ locked: z.boolean() }));
  return { meeting: hostView(await setLocked(meeting, actorOf(viewer), locked)) };
});

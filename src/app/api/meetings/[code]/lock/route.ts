import { z } from "zod";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { hostView, setLocked } from "@/lib/meetings";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const { locked } = await ctx.json(z.object({ locked: z.boolean() }));
  return { meeting: hostView(await setLocked(meeting, user.id, locked)) };
});

import { z } from "zod";
import { approveAll } from "@/lib/admission";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const { filter } = await ctx.json(z.object({ filter: z.enum(["all", "invited"]).default("all") }));
  return { admitted: await approveAll(meeting, user, filter) };
});

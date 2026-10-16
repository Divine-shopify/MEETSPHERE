import { z } from "zod";
import { approveAll } from "@/lib/admission";
import { route } from "@/lib/http";
import { actorOf, requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const { filter } = await ctx.json(z.object({ filter: z.enum(["all", "invited", "verified"]).default("all") }));
  return { admitted: await approveAll(meeting, actorOf(viewer), filter) };
});

import { z } from "zod";
import { route } from "@/lib/http";
import { enforce } from "@/lib/ratelimit";
import { dialOut } from "@/lib/telephony";
import { actorOf, requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const { number, name } = await ctx.json(z.object({ number: z.string().max(32), name: z.string().trim().max(80).default("") }));
  await enforce(`dialout:${meeting.id}`, 20, 3600, "Too many outgoing calls from this meeting.");
  await dialOut(meeting, actorOf(viewer), number, name);
  return { ok: true };
});

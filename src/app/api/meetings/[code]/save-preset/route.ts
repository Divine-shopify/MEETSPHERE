import { z } from "zod";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { presetFromMeeting } from "@/lib/presets";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const { name } = await ctx.json(z.object({ name: z.string().trim().min(1).max(80) }));
  const preset = await presetFromMeeting(user.id, meeting, name);
  return Response.json({ preset: { id: preset.id, name: preset.name } }, { status: 201 });
});

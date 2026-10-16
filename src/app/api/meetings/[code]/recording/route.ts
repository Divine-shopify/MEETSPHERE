import { z } from "zod";
import { route } from "@/lib/http";
import { startRecording, stopRecording } from "@/lib/recording";
import { actorOf, requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const { action } = await ctx.json(z.object({ action: z.enum(["start", "stop"]) }));
  if (action === "start") return { artifactId: (await startRecording(meeting, actorOf(viewer))).id };
  await stopRecording(meeting, actorOf(viewer));
  return { ok: true };
});

import { z } from "zod";
import { route } from "@/lib/http";
import { startVerification } from "@/lib/verification";

const schema = z.object({ channel: z.enum(["phone", "email"]), destination: z.string().min(3).max(254) });

export const POST = route(async (ctx) => {
  const body = await ctx.json(schema);
  const session = await ctx.ensureSession();
  return startVerification({ session, channel: body.channel, destination: body.destination, purpose: "signin", ip: ctx.ip() });
});

import { z } from "zod";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { disableDialIn, enableDialIn, telephonyConfig } from "@/lib/telephony";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting } = await hostOf(ctx, code);
  const cfg = telephonyConfig();
  return {
    configured: { dialIn: !!cfg.dialIn, dialOut: !!cfg.dialOut },
    enabled: meeting.dialin_enabled,
    pin: meeting.dialin_pin,
    number: cfg.dialIn?.number ?? null,
  };
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const { enabled } = await ctx.json(z.object({ enabled: z.boolean() }));
  if (enabled) return { enabled: true, ...(await enableDialIn(meeting, user.id)) };
  await disableDialIn(meeting, user.id);
  return { enabled: false };
});

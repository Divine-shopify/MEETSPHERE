import { z } from "zod";
import { getOwnRequest, isHost } from "@/lib/admission";
import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { guestIdentity, setAttributes } from "@/lib/media";
import { requireMeeting } from "@/lib/meetings";
import { enforce } from "@/lib/ratelimit";

type P = { code: string };

// Hand raise goes through the server so it works even when chat/data is disabled
// and participants cannot spoof each other's state.
export const POST = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const session = await ctx.session();
  if (isHost(meeting, session)) throw forbidden("Hosts don't need to raise a hand.");
  const jr = await getOwnRequest(meeting, session);
  if (!jr || jr.status !== "admitted") throw forbidden("You're not in this meeting.");
  const { raised } = await ctx.json(z.object({ raised: z.boolean() }));
  await enforce(`hand:${jr.id}`, 30, 60);
  await setAttributes(meeting, guestIdentity(jr.id), { hand: raised ? String(Date.now()) : "" });
  return { raised };
});

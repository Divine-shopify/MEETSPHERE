import { z } from "zod";
import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { guestIdentity, setAttributes } from "@/lib/media";
import { enforce } from "@/lib/ratelimit";
import { publish } from "@/lib/events";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };

// Hand raise goes through the server so it works even when chat/data is disabled
// and participants cannot spoof each other's state.
export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  if (!viewer.request) throw forbidden("Hosts don't need to raise a hand.");
  const { raised } = await ctx.json(z.object({ raised: z.boolean() }));
  await enforce(`hand:${viewer.request.id}`, 30, 60);
  await setAttributes(meeting, guestIdentity(viewer.request.id), { hand: raised ? String(Date.now()) : "" });
  await publish({ meetingId: meeting.id, type: "hand", audience: "moderators", data: { id: viewer.request.id, raised } });
  return { raised };
});

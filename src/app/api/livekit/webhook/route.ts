import { identityStillAllowed } from "@/lib/admission";
import { audit } from "@/lib/audit";
import { one } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { kick, webhookReceiver } from "@/lib/media";
import type { Meeting } from "@/lib/meetings";

// Defence in depth: if anyone reaches the media room without an admitted
// request (e.g. a token issued just before removal), remove them immediately.
export const POST = route(
  async (ctx) => {
    const body = await ctx.req.text();
    let event;
    try {
      event = await webhookReceiver().receive(body, ctx.req.headers.get("authorization") ?? undefined);
    } catch {
      throw forbidden("Invalid webhook signature");
    }
    const roomId = event.room?.name;
    const identity = event.participant?.identity;
    if (!roomId || !identity || !/^[0-9a-f-]{36}$/.test(roomId)) return { ok: true };
    const meeting = await one<Meeting>("SELECT * FROM meetings WHERE id = $1", [roomId]);
    if (!meeting) return { ok: true };

    if (event.event === "participant_joined") {
      if (!(await identityStillAllowed(meeting, identity))) {
        await kick(meeting, identity);
        await audit({ meetingId: meeting.id, action: "unauthorized_media_join_kicked", metadata: { identity } });
      } else {
        await audit({ meetingId: meeting.id, action: "participant_joined", targetId: identity.split(":")[1] ?? null, metadata: { identity } });
      }
    } else if (event.event === "participant_left") {
      await audit({ meetingId: meeting.id, action: "participant_left", targetId: identity.split(":")[1] ?? null, metadata: { identity } });
    }
    return { ok: true };
  },
  { skipOriginCheck: true },
);

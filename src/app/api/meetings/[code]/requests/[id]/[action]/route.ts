import { z } from "zod";
import { applicantView, approve, getRequest, reject, remove, setRole, unblock } from "@/lib/admission";
import { audit } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { route } from "@/lib/http";
import { guestIdentity, muteMicrophone } from "@/lib/media";
import { actorOf, requireModerator } from "@/lib/viewer";
import { emitWebhook } from "@/lib/webhooks";

type P = { code: string; id: string; action: string };

const reasonSchema = z.object({ reason: z.string().trim().max(200).optional() });
const roleSchema = z.object({ role: z.enum(["cohost", "speaker", "audience", "participant"]) });

async function optionalJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await req.text();
  return schema.parse(text ? JSON.parse(text) : {});
}

export const POST = route<P>(async (ctx, { code, id, action }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  const actor = actorOf(viewer);
  switch (action) {
    case "approve":
      return { request: applicantView(await approve(meeting, actor, id)) };
    case "reject": {
      const { reason } = await optionalJson(ctx.req, reasonSchema);
      return { request: applicantView(await reject(meeting, actor, id, reason)) };
    }
    case "remove":
    case "block": {
      const { reason } = await optionalJson(ctx.req, reasonSchema);
      const r = await remove(meeting, actor, id, action === "block", reason);
      await emitWebhook(meeting, "participant.removed", { name: r.submitted_name, requestId: r.id, blocked: action === "block" });
      return { request: applicantView(r) };
    }
    case "unblock":
      return { request: applicantView(await unblock(meeting, actor, id)) };
    case "role": {
      const { role } = await ctx.json(roleSchema);
      return { role: await setRole(meeting, actor, id, role) };
    }
    case "mute": {
      const jr = await getRequest(meeting, id);
      if (!jr) throw notFound("Request not found");
      const muted = await muteMicrophone(meeting, jr.sip_identity ?? guestIdentity(jr.id));
      if (muted) await audit({ meetingId: meeting.id, action: "muted", actorUserId: actor.userId, actorSessionId: actor.sessionId, targetId: id });
      return { muted };
    }
    default:
      throw notFound("Unknown action");
  }
});

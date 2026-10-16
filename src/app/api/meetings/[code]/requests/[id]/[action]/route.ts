import { z } from "zod";
import { applicantView, approve, reject, remove, setRole, unblock } from "@/lib/admission";
import { audit } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { guestIdentity, muteMicrophone } from "@/lib/media";

type P = { code: string; id: string; action: string };

const reasonSchema = z.object({ reason: z.string().trim().max(200).optional() });
const roleSchema = z.object({ role: z.enum(["speaker", "audience", "participant"]) });

async function optionalJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await req.text();
  return schema.parse(text ? JSON.parse(text) : {});
}

export const POST = route<P>(async (ctx, { code, id, action }) => {
  const { meeting, user } = await hostOf(ctx, code);
  switch (action) {
    case "approve":
      return { request: applicantView(await approve(meeting, user, id)) };
    case "reject": {
      const { reason } = await optionalJson(ctx.req, reasonSchema);
      return { request: applicantView(await reject(meeting, user, id, reason)) };
    }
    case "remove":
    case "block": {
      const { reason } = await optionalJson(ctx.req, reasonSchema);
      return { request: applicantView(await remove(meeting, user, id, action === "block", reason)) };
    }
    case "unblock":
      return { request: applicantView(await unblock(meeting, user, id)) };
    case "role": {
      const { role } = await ctx.json(roleSchema);
      return { role: await setRole(meeting, user, id, role) };
    }
    case "mute": {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Request not found");
      const muted = await muteMicrophone(meeting, guestIdentity(id));
      if (muted) await audit({ meetingId: meeting.id, action: "muted", actorUserId: user.id, targetId: id });
      return { muted };
    }
    default:
      throw notFound("Unknown action");
  }
});

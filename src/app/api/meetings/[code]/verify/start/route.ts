import { z } from "zod";
import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { startVerification } from "@/lib/verification";

type P = { code: string };
const schema = z.object({ channel: z.enum(["phone", "email"]), destination: z.string().min(3).max(254) });

export const POST = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  if (meeting.status === "ended") throw forbidden("This meeting has ended.");
  const body = await ctx.json(schema);
  const session = await ctx.ensureSession();
  return startVerification({
    session,
    channel: body.channel,
    destination: body.destination,
    purpose: "join",
    ip: ctx.ip(),
    billedHostId: meeting.host_user_id,
    meetingId: meeting.id,
  });
});

import { applicantView, getOwnRequest, isHost } from "@/lib/admission";
import { one } from "@/lib/db";
import { route } from "@/lib/http";
import { mediaConfigured } from "@/lib/media";
import { hostView, publicView, requireMeeting } from "@/lib/meetings";
import { channelModes } from "@/lib/messaging";
import { maskContact } from "@/lib/contact";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const session = await ctx.session();
  const host = await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [meeting.host_user_id]);
  const own = await getOwnRequest(meeting, session);
  return {
    meeting: publicView(meeting, host?.display_name ?? "Host"),
    host: isHost(meeting, session) ? hostView(meeting) : null,
    myRequest: own ? applicantView(own) : null,
    myVerified: {
      phone: maskContact(session?.verified_phone ?? null),
      email: maskContact(session?.verified_email ?? null),
    },
    services: { verification: channelModes(), media: mediaConfigured() },
  };
});

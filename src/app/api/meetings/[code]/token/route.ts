import { issueToken } from "@/lib/admission";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { enforce } from "@/lib/ratelimit";
import { getUser } from "@/lib/session";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const session = await ctx.session();
  await enforce(`token:${session?.id ?? ctx.ip()}`, 60, 600);
  const user = session?.user_id ? await getUser(session.user_id) : null;
  const t = await issueToken(meeting, session, user);
  return {
    token: t.token,
    url: t.url,
    role: t.role,
    identity: t.identity,
    settings: { chatEnabled: meeting.chat_enabled, allowScreenShare: meeting.allow_screen_share, mode: meeting.mode },
  };
});

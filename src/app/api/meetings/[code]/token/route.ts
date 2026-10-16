import { z } from "zod";
import { issueToken } from "@/lib/admission";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { enforce } from "@/lib/ratelimit";
import { viewerFor } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const text = await ctx.req.text();
  const body = z.object({ room: z.string().uuid().nullish() }).parse(text ? JSON.parse(text) : {});
  const viewer = await viewerFor(ctx, meeting);
  await enforce(`token:${viewer.session?.id ?? ctx.ip()}`, 60, 600);
  const t = await issueToken(meeting, viewer, { room: body.room });
  return {
    token: t.token,
    url: t.url,
    role: t.role,
    identity: t.identity,
    room: t.room,
    breakoutId: t.breakoutId,
    viewerKey: viewer.key,
    settings: { chatEnabled: meeting.chat_enabled, allowScreenShare: meeting.allow_screen_share, mode: meeting.mode },
  };
});

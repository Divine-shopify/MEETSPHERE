import { z } from "zod";
import { config } from "@/lib/config";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { meetingIcs } from "@/lib/ics";
import { sendInvitations } from "@/lib/invitations";
import { enforce } from "@/lib/ratelimit";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const { ids } = await ctx.json(z.object({ ids: z.array(z.string().uuid()).max(10000).optional() }));
  await enforce(`invite-send:${meeting.id}`, 10, 3600, "You've sent invitations several times this hour. Try again later.");
  const link = `${config.baseUrl}/m/${meeting.code}`;
  const ics = meeting.scheduled_at ? meetingIcs(meeting, { link, hostName: user.display_name }) : null;
  return sendInvitations(meeting, user.display_name, { invitationIds: ids, ics, baseUrl: config.baseUrl });
});

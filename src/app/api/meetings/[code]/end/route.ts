import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { kick, listIdentities } from "@/lib/media";
import { endMeeting, hostView } from "@/lib/meetings";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const ended = await endMeeting(meeting, user.id);
  const identities = await listIdentities(ended);
  await Promise.all(identities.map((id) => kick(ended, id)));
  return { meeting: hostView(ended) };
});

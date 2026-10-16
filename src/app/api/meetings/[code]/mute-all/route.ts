import { audit } from "@/lib/audit";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { hostIdentity, listIdentities, muteMicrophone } from "@/lib/media";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const identities = (await listIdentities(meeting)).filter((i) => i !== hostIdentity(user.id));
  const results = await Promise.all(identities.map((i) => muteMicrophone(meeting, i).catch(() => false)));
  const muted = results.filter(Boolean).length;
  await audit({ meetingId: meeting.id, action: "muted", actorUserId: user.id, metadata: { all: true, count: muted } });
  return { muted };
});

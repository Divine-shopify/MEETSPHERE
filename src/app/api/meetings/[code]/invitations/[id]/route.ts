import { notFound } from "@/lib/errors";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { revokeInvitation } from "@/lib/invitations";

type P = { code: string; id: string };

export const DELETE = route<P>(async (ctx, { code, id }) => {
  const { meeting, user } = await hostOf(ctx, code);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Invitation not found");
  await revokeInvitation(meeting.id, user.id, id);
  return { ok: true };
});

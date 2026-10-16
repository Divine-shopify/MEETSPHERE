import { route } from "@/lib/http";
import { deleteEndpoint } from "@/lib/webhookEndpoints";

type P = { id: string };

export const DELETE = route<P>(async (ctx, { id }) => {
  const { user } = await ctx.requireUser();
  await deleteEndpoint({ userId: user.id }, id);
  return { ok: true };
});

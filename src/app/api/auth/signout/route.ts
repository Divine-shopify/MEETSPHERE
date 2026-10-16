import { route } from "@/lib/http";
import { destroySession } from "@/lib/session";

export const POST = route(async (ctx) => {
  const session = await ctx.session();
  if (session) await destroySession(session.id);
  ctx.clearSession();
  return { ok: true };
});

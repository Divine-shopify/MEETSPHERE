import type { RequestContext } from "./http";
import { requireHostedMeeting, requireMeeting, type Meeting } from "./meetings";
import type { Session, User } from "./session";

/** Loads a meeting the signed-in user hosts; anyone else gets 401/404. */
export async function hostOf(ctx: RequestContext, code: string): Promise<{ meeting: Meeting; user: User; session: Session }> {
  const { user, session } = await ctx.requireUser();
  const meeting = await requireHostedMeeting(code, user.id);
  return { meeting, user, session };
}

export { requireMeeting };

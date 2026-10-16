import { getOwnRequest, type JoinRequest } from "./admission";
import { one } from "./db";
import { forbidden, notFound } from "./errors";
import type { RequestContext } from "./http";
import type { MediaRole } from "./media";
import { requireMeeting, type Meeting } from "./meetings";
import { getUser, type Session, type User } from "./session";

/** Who is acting in a meeting, resolved from the browser session. */
export interface Viewer {
  kind: "host" | "cohost" | "participant" | "none";
  moderator: boolean;
  /** Stable key used for votes, questions, consent: "host:<userId>" or "jr:<joinRequestId>". */
  key: string | null;
  name: string;
  role: MediaRole | null;
  session: Session | null;
  user: User | null;
  request: JoinRequest | null;
  /** For audit/review columns that reference users. */
  actorUserId: string | null;
  actorSessionId: string | null;
}

export async function viewerFor(ctx: RequestContext, m: Meeting): Promise<Viewer> {
  const session = await ctx.session();
  const user = session?.user_id ? await getUser(session.user_id) : null;
  const base = { session, user, actorUserId: user?.id ?? null, actorSessionId: session?.id ?? null };
  if (user && user.id === m.host_user_id) {
    return { ...base, kind: "host", moderator: true, key: `host:${user.id}`, name: user.display_name, role: "host", request: null };
  }
  const jr = await getOwnRequest(m, session);
  if (jr && jr.status === "admitted") {
    const r = await one<{ role: MediaRole }>("SELECT role FROM meeting_roles WHERE meeting_id = $1 AND guest_session_id = $2", [m.id, jr.session_id]);
    const role = r?.role ?? "participant";
    const cohost = role === "cohost";
    return { ...base, kind: cohost ? "cohost" : "participant", moderator: cohost, key: `jr:${jr.id}`, name: jr.submitted_name, role, request: jr };
  }
  return { ...base, kind: "none", moderator: false, key: null, name: "", role: null, request: jr };
}

export async function requireParticipant(ctx: RequestContext, code: string): Promise<{ meeting: Meeting; viewer: Viewer }> {
  const meeting = await requireMeeting(code);
  const viewer = await viewerFor(ctx, meeting);
  if (viewer.kind === "none") throw forbidden("You're not in this meeting.");
  return { meeting, viewer };
}

/** Host or co-host. Everyone else gets 404 so settings/existence don't leak. */
export async function requireModerator(ctx: RequestContext, code: string): Promise<{ meeting: Meeting; viewer: Viewer }> {
  const meeting = await requireMeeting(code);
  const viewer = await viewerFor(ctx, meeting);
  if (!viewer.moderator) {
    if (!viewer.session?.user_id && viewer.kind === "none") {
      const { unauthorized } = await import("./errors");
      throw unauthorized();
    }
    throw notFound("Meeting not found");
  }
  return { meeting, viewer };
}

export function actorOf(v: Viewer) {
  return { userId: v.actorUserId, sessionId: v.actorSessionId };
}

import { one } from "./db";
import type { RequestContext } from "./http";
import type { Meeting } from "./meetings";
import { viewerFor } from "./viewer";

/** Who may watch replays / read transcripts after (or during) a meeting. */
export async function canViewReplay(ctx: RequestContext, m: Meeting): Promise<boolean> {
  const v = await viewerFor(ctx, m);
  if (v.moderator) return true;
  if (m.replay_visibility === "link") return true;
  if (m.replay_visibility === "attendees" && v.session) {
    // Anyone who was admitted at some point (even if they've since left).
    const r = await one(
      "SELECT 1 FROM join_requests WHERE meeting_id = $1 AND session_id = $2 AND status IN ('admitted', 'removed')",
      [m.id, v.session.id],
    );
    return r !== null;
  }
  return false;
}

import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { listIdentities, parseIdentity, updatePermissions } from "@/lib/media";
import { hostView, settingsSchema, updateSettings } from "@/lib/meetings";
import { query } from "@/lib/db";
import type { MediaRole } from "@/lib/media";

type P = { code: string };

export const PATCH = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const patch = await ctx.json(settingsSchema);
  const updated = await updateSettings(meeting, user.id, patch);

  // Push permission changes (screen share / chat) to people already in the room.
  if (patch.allowScreenShare !== undefined || patch.chatEnabled !== undefined) {
    const identities = await listIdentities(updated);
    const roles = await query<{ id: string; role: MediaRole }>(
      `SELECT jr.id, r.role FROM join_requests jr
         JOIN meeting_roles r ON r.meeting_id = jr.meeting_id AND r.guest_session_id = jr.session_id
        WHERE jr.meeting_id = $1 AND jr.status = 'admitted'`,
      [updated.id],
    );
    const roleById = new Map(roles.map((r) => [r.id, r.role]));
    await Promise.all(
      identities.map((identity) => {
        const parsed = parseIdentity(identity);
        const role = parsed?.kind === "guest" ? roleById.get(parsed.id) : undefined;
        return role ? updatePermissions(updated, identity, role) : Promise.resolve();
      }),
    );
  }
  return { meeting: hostView(updated) };
});

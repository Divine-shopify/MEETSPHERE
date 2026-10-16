import { z } from "zod";
import { accountSummary } from "@/lib/accounting";
import { stripeConfig } from "@/lib/billing";
import { pool, query } from "@/lib/db";
import { conflict } from "@/lib/errors";
import { route } from "@/lib/http";
import { deletePrefix, type StorageMode } from "@/lib/storage";
import { listUserOrgs } from "@/lib/orgs";
import { plans } from "@/lib/plans";

export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const s = stripeConfig();
  return {
    user: { id: user.id, displayName: user.display_name, email: user.email, phone: user.phone_e164 },
    account: await accountSummary({ userId: user.id }),
    orgs: await listUserOrgs(user.id),
    plans: Object.values(plans()),
    checkoutAvailable: { pro: !!s?.prices.pro, business: !!s?.prices.business },
  };
});

export const PATCH = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const { displayName } = await ctx.json(z.object({ displayName: z.string().trim().min(1).max(80) }));
  await pool().query("UPDATE users SET display_name = $2 WHERE id = $1", [user.id, displayName]);
  return { ok: true };
});

/**
 * Deletes the account, its meetings (with recordings, transcripts, invite lists)
 * and sessions. Organization ownership must be handed over first.
 */
export const DELETE = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  await ctx.json(z.object({ confirm: z.literal("DELETE") }));
  const owned = await query<{ name: string }>(
    `SELECT o.name FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.role = 'owner'
        AND (SELECT count(*) FROM org_members x WHERE x.org_id = m.org_id AND x.role = 'owner') = 1`,
    [user.id],
  );
  if (owned.length) throw conflict(`Transfer ownership of ${owned.map((o) => o.name).join(", ")} before deleting your account.`, "sole_owner");
  const files = await query<{ storage: StorageMode; storage_key: string }>(
    `SELECT a.storage, a.storage_key FROM meeting_artifacts a JOIN meetings m ON m.id = a.meeting_id
      WHERE m.host_user_id = $1 AND a.storage_key IS NOT NULL AND a.status <> 'deleted'`,
    [user.id],
  );
  for (const f of files) await deletePrefix(f.storage, f.storage_key).catch(() => {});
  // Cascades remove meetings, their content, sessions, presets, webhooks and billing rows.
  await pool().query("DELETE FROM users WHERE id = $1", [user.id]);
  ctx.clearSession();
  return { deleted: true };
});

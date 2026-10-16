import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/admin";
import { pool } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { route } from "@/lib/http";
import { normalizeEmail } from "@/lib/contact";

/** Support staff can set a plan manually (e.g. Enterprise contracts invoiced outside Stripe). */
export const POST = route(async (ctx) => {
  await requirePlatformAdmin(ctx);
  const body = await ctx.json(
    z.object({ email: z.string().optional(), orgSlug: z.string().optional(), plan: z.enum(["free", "pro", "business", "enterprise"]) }),
  );
  let col = "user_id";
  let id: string | undefined;
  if (body.orgSlug) {
    col = "org_id";
    id = (await pool().query("SELECT id FROM organizations WHERE slug = $1", [body.orgSlug])).rows[0]?.id;
  } else if (body.email) {
    id = (await pool().query("SELECT id FROM users WHERE email = $1", [normalizeEmail(body.email)])).rows[0]?.id;
  }
  if (!id) throw notFound("Account not found");
  await pool().query(
    `INSERT INTO billing_accounts (${col}, plan_id, status) VALUES ($1, $2, 'active')
     ON CONFLICT (${col}) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', updated_at = now()`,
    [id, body.plan],
  );
  return { ok: true };
});

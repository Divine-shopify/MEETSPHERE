import { z } from "zod";
import { accountSummary } from "@/lib/accounting";
import { stripeConfig } from "@/lib/billing";
import { pool } from "@/lib/db";
import { route } from "@/lib/http";
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

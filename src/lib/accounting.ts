import { query } from "./db";
import { planForOwner } from "./plans";

/** Plan, limits and this month's usage for a billing owner. */
export async function accountSummary(owner: { userId?: string; orgId?: string }) {
  const plan = await planForOwner(owner);
  const rows = await query<{ kind: string; n: string }>(
    `SELECT kind, sum(quantity) AS n FROM usage_events
      WHERE ${owner.orgId ? "org_id = $1" : "host_user_id = $1 AND org_id IS NULL"} AND created_at >= date_trunc('month', now())
      GROUP BY kind`,
    [owner.orgId ?? owner.userId],
  );
  const billing = await query<{ status: string; current_period_end: string | null; stripe_customer_id: string | null }>(
    `SELECT status, current_period_end, stripe_customer_id FROM billing_accounts WHERE ${owner.orgId ? "org_id" : "user_id"} = $1`,
    [owner.orgId ?? owner.userId],
  );
  return {
    plan,
    billing: billing[0] ? { status: billing[0].status, currentPeriodEnd: billing[0].current_period_end, hasCustomer: !!billing[0].stripe_customer_id } : null,
    usage: Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)])),
  };
}

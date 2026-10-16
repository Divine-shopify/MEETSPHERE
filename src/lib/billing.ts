// Stripe subscriptions over the REST API (no SDK dependency).
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { one, pool, tx } from "./db";
import { badRequest, HttpError } from "./errors";
import type { PlanId } from "./plans";

export type Owner = { userId: string; orgId?: undefined } | { orgId: string; userId?: undefined };

interface BillingAccount {
  id: string;
  user_id: string | null;
  org_id: string | null;
  plan_id: PlanId;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}

export function stripeConfig() {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const prices: Partial<Record<PlanId, string>> = {
    pro: process.env.STRIPE_PRICE_PRO?.trim(),
    business: process.env.STRIPE_PRICE_BUSINESS?.trim(),
  };
  return secretKey ? { secretKey, webhookSecret, prices } : null;
}

function requireStripe() {
  const c = stripeConfig();
  if (!c) throw new HttpError(503, "billing_not_configured", "Billing isn't configured on this server (STRIPE_SECRET_KEY).");
  return c;
}

/** Flattens nested params into Stripe's form encoding: a[b][0]=c */
function encode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? encode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") encode(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe<T>(path: string, params: Record<string, unknown>): Promise<T> {
  const c = requireStripe();
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: encode(params),
  });
  const data = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new HttpError(502, "billing_error", `Stripe: ${data.error?.message ?? res.status}`);
  return data;
}

export async function billingAccount(owner: Owner): Promise<BillingAccount> {
  const col = owner.orgId ? "org_id" : "user_id";
  const id = owner.orgId ?? owner.userId;
  await pool().query(`INSERT INTO billing_accounts (${col}) VALUES ($1) ON CONFLICT (${col}) DO NOTHING`, [id]);
  return (await one<BillingAccount>(`SELECT * FROM billing_accounts WHERE ${col} = $1`, [id]))!;
}

export async function createCheckout(owner: Owner, plan: PlanId, email: string | null): Promise<string> {
  const c = requireStripe();
  const price = c.prices[plan];
  if (!price) throw badRequest(`The ${plan} plan isn't available for online checkout. Contact sales.`);
  const acct = await billingAccount(owner);
  let customer = acct.stripe_customer_id;
  if (!customer) {
    const created = await stripe<{ id: string }>("customers", { email: email ?? undefined, metadata: { billing_account_id: acct.id } });
    customer = created.id;
    await pool().query("UPDATE billing_accounts SET stripe_customer_id = $2 WHERE id = $1", [acct.id, customer]);
  }
  const session = await stripe<{ url: string }>("checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: acct.id,
    line_items: [{ price, quantity: 1 }],
    success_url: `${config.baseUrl}/account?billing=success`,
    cancel_url: `${config.baseUrl}/account?billing=cancel`,
    metadata: { billing_account_id: acct.id, plan },
    subscription_data: { metadata: { billing_account_id: acct.id, plan } },
    allow_promotion_codes: true,
  });
  return session.url;
}

export async function createPortal(owner: Owner): Promise<string> {
  const acct = await billingAccount(owner);
  if (!acct.stripe_customer_id) throw badRequest("No billing account yet. Choose a plan first.");
  const s = await stripe<{ url: string }>("billing_portal/sessions", { customer: acct.stripe_customer_id, return_url: `${config.baseUrl}/account` });
  return s.url;
}

/** Verifies the Stripe-Signature header (v1 HMAC-SHA256 over "t.payload"), with replay tolerance. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  return header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const sig = Buffer.from(p.slice(3), "hex");
      return sig.length === expected.length && timingSafeEqual(sig, expected);
    });
}

function planFromPrice(priceId: string | undefined, fallback: string | undefined): PlanId {
  const c = stripeConfig();
  for (const [plan, price] of Object.entries(c?.prices ?? {})) if (price && price === priceId) return plan as PlanId;
  return (["pro", "business", "enterprise"].includes(fallback ?? "") ? fallback : "free") as PlanId;
}

const STATUS: Record<string, string> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  paused: "canceled",
};

interface StripeEvent {
  id: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Stripe payloads are loosely typed JSON
  data: { object: Record<string, any> };
}

/** Idempotent: each Stripe event id is processed once. */
export async function handleStripeEvent(e: StripeEvent): Promise<void> {
  await tx(async (db) => {
    const fresh = await db.query("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [e.id, e.type]);
    if (!fresh.rowCount) return;
    const o = e.data.object;
    if (e.type === "checkout.session.completed") {
      const acctId = o.client_reference_id ?? o.metadata?.billing_account_id;
      if (!acctId) return;
      await db.query(
        `UPDATE billing_accounts SET stripe_customer_id = coalesce($2, stripe_customer_id), stripe_subscription_id = $3,
           plan_id = $4, status = 'active', updated_at = now() WHERE id = $1`,
        [acctId, o.customer ?? null, o.subscription ?? null, planFromPrice(undefined, o.metadata?.plan)],
      );
    } else if (e.type === "customer.subscription.created" || e.type === "customer.subscription.updated" || e.type === "customer.subscription.deleted") {
      const acctId = o.metadata?.billing_account_id;
      const where = acctId ? "id = $1" : "stripe_customer_id = $1";
      const status = e.type === "customer.subscription.deleted" ? "canceled" : (STATUS[o.status] ?? "incomplete");
      const plan = status === "canceled" ? "free" : planFromPrice(o.items?.data?.[0]?.price?.id, o.metadata?.plan);
      await db.query(
        `UPDATE billing_accounts SET stripe_subscription_id = $2, plan_id = $3, status = $4,
           current_period_end = to_timestamp($5), updated_at = now() WHERE ${where}`,
        [acctId ?? o.customer, o.id, plan, status, o.current_period_end ?? o.items?.data?.[0]?.current_period_end ?? null],
      );
    }
  });
}

import { handleStripeEvent, stripeConfig, verifyStripeSignature } from "@/lib/billing";
import { forbidden, unavailable } from "@/lib/errors";
import { route } from "@/lib/http";

// Stripe -> MeetSphere. Authenticated by the signature, not cookies.
export const POST = route(
  async (ctx) => {
    const secret = stripeConfig()?.webhookSecret;
    if (!secret) throw unavailable("Billing webhooks aren't configured.");
    const payload = await ctx.req.text();
    if (!verifyStripeSignature(payload, ctx.req.headers.get("stripe-signature"), secret)) throw forbidden("Invalid signature");
    await handleStripeEvent(JSON.parse(payload));
    return { received: true };
  },
  { skipOriginCheck: true },
);

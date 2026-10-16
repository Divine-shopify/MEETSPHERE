import { forbidden, unavailable } from "@/lib/errors";
import { route } from "@/lib/http";
import { runCleanup } from "@/lib/retention";
import { deliverDue } from "@/lib/webhooks";
import { safeEqual, sha256 } from "@/lib/crypto";

// Call hourly: curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/cleanup
export const POST = route(
  async (ctx) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw unavailable("CRON_SECRET is not set.");
    const got = (ctx.req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!safeEqual(sha256(got), sha256(secret))) throw forbidden();
    const cleanup = await runCleanup();
    const webhooks = await deliverDue(200);
    return { cleanup, webhooks };
  },
  { skipOriginCheck: true },
);

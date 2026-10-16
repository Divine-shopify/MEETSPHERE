import { z } from "zod";
import { randomToken } from "./crypto";
import { query } from "./db";
import { badRequest, HttpError, notFound } from "./errors";
import { assertPublicUrl } from "./netguard";
import { planForOwner } from "./plans";
import { WEBHOOK_EVENTS } from "./webhooks";

export const endpointSchema = z.object({
  url: z.string().url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
});

type Owner = { userId: string } | { orgId: string };
const col = (o: Owner) => ("orgId" in o ? "org_id" : "owner_user_id");
const id = (o: Owner) => ("orgId" in o ? o.orgId : o.userId);

export async function listEndpoints(owner: Owner) {
  const rows = await query<{ id: string; url: string; events: string[]; active: boolean; created_at: string; failures: string }>(
    `SELECT e.id, e.url, e.events, e.active, e.created_at,
            (SELECT count(*) FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'failed') AS failures
       FROM webhook_endpoints e WHERE ${col(owner)} = $1 ORDER BY e.created_at`,
    [id(owner)],
  );
  return rows.map((r) => ({ ...r, failures: Number(r.failures) }));
}

export async function createEndpoint(owner: Owner, input: z.infer<typeof endpointSchema>) {
  if (!(await planForOwner(owner)).webhooks) throw new HttpError(402, "plan_required", "Webhooks are available on paid plans.");
  try {
    await assertPublicUrl(input.url);
  } catch (err) {
    throw badRequest((err as Error).message, "invalid_url");
  }
  const secret = `whsec_${randomToken(24)}`;
  const rows = await query<{ id: string }>(
    `INSERT INTO webhook_endpoints (${col(owner)}, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING id`,
    [id(owner), input.url, secret, input.events],
  );
  // The signing secret is shown once.
  return { id: rows[0].id, secret };
}

export async function deleteEndpoint(owner: Owner, endpointId: string) {
  if (!/^[0-9a-f-]{36}$/.test(endpointId)) throw notFound("Webhook not found");
  const rows = await query(`DELETE FROM webhook_endpoints WHERE id = $1 AND ${col(owner)} = $2 RETURNING id`, [endpointId, id(owner)]);
  if (!rows.length) throw notFound("Webhook not found");
}

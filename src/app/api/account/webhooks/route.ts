import { route } from "@/lib/http";
import { WEBHOOK_EVENTS } from "@/lib/webhooks";
import { createEndpoint, endpointSchema, listEndpoints } from "@/lib/webhookEndpoints";

export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  return { endpoints: await listEndpoints({ userId: user.id }), events: WEBHOOK_EVENTS };
});

export const POST = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  return Response.json(await createEndpoint({ userId: user.id }, await ctx.json(endpointSchema)), { status: 201 });
});

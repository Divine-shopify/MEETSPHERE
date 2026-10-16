import { z } from "zod";
import { route } from "@/lib/http";
import { requireOrgRole } from "@/lib/orgs";
import { createEndpoint, deleteEndpoint, endpointSchema, listEndpoints } from "@/lib/webhookEndpoints";

type P = { slug: string };

export const GET = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  return { endpoints: await listEndpoints({ orgId: org.id }) };
});

export const POST = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  return Response.json(await createEndpoint({ orgId: org.id }, await ctx.json(endpointSchema)), { status: 201 });
});

export const DELETE = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  const { id } = await ctx.json(z.object({ id: z.string().uuid() }));
  await deleteEndpoint({ orgId: org.id }, id);
  return { ok: true };
});

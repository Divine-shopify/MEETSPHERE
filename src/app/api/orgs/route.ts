import { route } from "@/lib/http";
import { createOrg, createOrgSchema, listUserOrgs } from "@/lib/orgs";
import { enforce } from "@/lib/ratelimit";

export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  return { orgs: await listUserOrgs(user.id) };
});

export const POST = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  await enforce(`org:create:${user.id}`, 5, 86400);
  const org = await createOrg(user.id, await ctx.json(createOrgSchema));
  return Response.json({ org: { id: org.id, name: org.name, slug: org.slug } }, { status: 201 });
});

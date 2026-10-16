import { z } from "zod";
import { createPortal, type Owner } from "@/lib/billing";
import { route } from "@/lib/http";
import { requireOrgRole } from "@/lib/orgs";

export const POST = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const { org } = await ctx.json(z.object({ org: z.string().optional() }));
  let owner: Owner = { userId: user.id };
  if (org) owner = { orgId: (await requireOrgRole(org, user.id, "admin")).org.id };
  return { url: await createPortal(owner) };
});

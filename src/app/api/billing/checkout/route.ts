import { z } from "zod";
import { createCheckout, type Owner } from "@/lib/billing";
import { route } from "@/lib/http";
import { requireOrgRole } from "@/lib/orgs";

export const POST = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const { plan, org } = await ctx.json(z.object({ plan: z.enum(["pro", "business"]), org: z.string().optional() }));
  let owner: Owner = { userId: user.id };
  if (org) owner = { orgId: (await requireOrgRole(org, user.id, "admin")).org.id };
  return { url: await createCheckout(owner, plan, user.email) };
});

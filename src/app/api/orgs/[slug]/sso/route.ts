import { route } from "@/lib/http";
import { requireOrgRole } from "@/lib/orgs";
import { getSsoConfig, redirectUri, saveSsoConfig, ssoConfigSchema } from "@/lib/sso";

type P = { slug: string };

export const GET = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  return { sso: await getSsoConfig(org.id), redirectUri: redirectUri() };
});

export const PUT = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "owner");
  await saveSsoConfig(org, await ctx.json(ssoConfigSchema));
  return { sso: await getSsoConfig(org.id) };
});

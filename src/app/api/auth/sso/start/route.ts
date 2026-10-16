import { route } from "@/lib/http";
import { getOrgBySlug } from "@/lib/orgs";
import { notFound } from "@/lib/errors";
import { startSso } from "@/lib/sso";

// GET so it works as a plain link: /api/auth/sso/start?org=acme&next=/dashboard
export const GET = route(async (ctx) => {
  const params = new URL(ctx.req.url).searchParams;
  const org = await getOrgBySlug(params.get("org") ?? "");
  if (!org) throw notFound("Organization not found");
  const session = await ctx.ensureSession();
  const url = await startSso(org, session, params.get("next") ?? "/dashboard");
  return new Response(null, { status: 302, headers: { Location: url } });
});

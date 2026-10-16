import { accountSummary } from "@/lib/accounting";
import { route } from "@/lib/http";
import { requireOrgRole, updateOrg, updateOrgSchema } from "@/lib/orgs";
import { getSsoConfig } from "@/lib/sso";

type P = { slug: string };

export const GET = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org, role } = await requireOrgRole(slug, user.id, "member");
  const admin = role !== "member";
  return {
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      branding: org.branding,
      defaultMeetingSettings: org.default_meeting_settings,
      allowedEmailDomains: org.allowed_email_domains,
      retentionDays: org.retention_days,
      ssoEnforced: org.sso_enforced,
    },
    role,
    account: admin ? await accountSummary({ orgId: org.id }) : null,
    sso: admin ? await getSsoConfig(org.id) : null,
  };
});

export const PATCH = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  const updated = await updateOrg(org, await ctx.json(updateOrgSchema));
  return { org: { id: updated.id, name: updated.name, slug: updated.slug } };
});

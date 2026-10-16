import { z } from "zod";
import { route } from "@/lib/http";
import { addMember, listMembers, requireOrgRole, setMemberRole } from "@/lib/orgs";

type P = { slug: string };

export const GET = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  return listMembers(org.id);
});

export const POST = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org } = await requireOrgRole(slug, user.id, "admin");
  const { email, role } = await ctx.json(z.object({ email: z.string().max(254), role: z.enum(["admin", "member"]).default("member") }));
  return addMember(org.id, user.id, email, role);
});

export const PATCH = route<P>(async (ctx, { slug }) => {
  const { user } = await ctx.requireUser();
  const { org, role: myRole } = await requireOrgRole(slug, user.id, "admin");
  const { userId, role } = await ctx.json(z.object({ userId: z.string().uuid(), role: z.enum(["owner", "admin", "member"]).nullable() }));
  await setMemberRole(org.id, myRole, userId, role);
  return listMembers(org.id);
});

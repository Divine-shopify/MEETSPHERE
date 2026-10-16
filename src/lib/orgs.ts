import { z } from "zod";
import { normalizeEmail } from "./contact";
import { one, query, tx, type Db, pool } from "./db";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { settingsSchema } from "./meetings";

export type OrgRole = "owner" | "admin" | "member";

export interface Org {
  id: string;
  name: string;
  slug: string;
  branding: Branding;
  default_meeting_settings: Record<string, unknown>;
  allowed_email_domains: string[];
  retention_days: number | null;
  sso_enforced: boolean;
  created_at: string;
}

export const brandingSchema = z.object({
  displayName: z.string().trim().max(80).optional(),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\//, "Logo must be an https:// URL")
    .optional()
    .or(z.literal("")),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #2456d6")
    .optional()
    .or(z.literal("")),
  welcomeText: z.string().trim().max(300).optional(),
});
export type Branding = z.infer<typeof brandingSchema>;

export const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "Use 2-41 lowercase letters, numbers or dashes"),
});

export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    branding: brandingSchema,
    defaultMeetingSettings: settingsSchema.omit({ title: true, scheduledAt: true }),
    allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20),
    retentionDays: z.number().int().min(1).max(3650).nullable(),
    ssoEnforced: z.boolean(),
  })
  .partial();

export async function orgRole(orgId: string, userId: string, db: Db = pool()): Promise<OrgRole | null> {
  const r = await one<{ role: OrgRole }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId], db);
  return r?.role ?? null;
}

export async function getOrgBySlug(slug: string): Promise<Org | null> {
  return one<Org>("SELECT * FROM organizations WHERE slug = $1", [slug.toLowerCase()]);
}

export async function getOrg(id: string): Promise<Org | null> {
  return one<Org>("SELECT * FROM organizations WHERE id = $1", [id]);
}

export async function requireOrgRole(slug: string, userId: string, min: "member" | "admin" | "owner") {
  const org = await getOrgBySlug(slug);
  if (!org) throw notFound("Organization not found");
  const role = await orgRole(org.id, userId);
  const rank = { member: 1, admin: 2, owner: 3 } as const;
  if (!role) throw notFound("Organization not found");
  if (rank[role] < rank[min]) throw forbidden("You need to be an organization " + min + " to do that.");
  return { org, role };
}

export async function listUserOrgs(userId: string) {
  return query<{ id: string; name: string; slug: string; role: OrgRole }>(
    `SELECT o.id, o.name, o.slug, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = $1 ORDER BY o.name`,
    [userId],
  );
}

export async function createOrg(userId: string, input: z.infer<typeof createOrgSchema>): Promise<Org> {
  try {
    return await tx(async (db) => {
      const org = await one<Org>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *", [input.name, input.slug], db);
      await db.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org!.id, userId]);
      await db.query("INSERT INTO billing_accounts (org_id) VALUES ($1)", [org!.id]);
      return org!;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw conflict("That URL name is taken. Try another.", "slug_taken");
    throw err;
  }
}

export async function updateOrg(org: Org, patch: z.infer<typeof updateOrgSchema>): Promise<Org> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.branding !== undefined) add("branding", JSON.stringify(patch.branding));
  if (patch.defaultMeetingSettings !== undefined) add("default_meeting_settings", JSON.stringify(patch.defaultMeetingSettings));
  if (patch.allowedEmailDomains !== undefined) add("allowed_email_domains", patch.allowedEmailDomains);
  if (patch.retentionDays !== undefined) add("retention_days", patch.retentionDays);
  if (patch.ssoEnforced !== undefined) add("sso_enforced", patch.ssoEnforced);
  if (!sets.length) return org;
  params.push(org.id);
  return (await one<Org>(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params))!;
}

export async function listMembers(orgId: string) {
  const members = await query<{ user_id: string; display_name: string; email: string | null; phone_e164: string | null; role: OrgRole; created_at: string }>(
    `SELECT m.user_id, u.display_name, u.email, u.phone_e164, m.role, m.created_at
       FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.role, u.display_name`,
    [orgId],
  );
  const invites = await query<{ email: string; role: OrgRole; created_at: string }>(
    "SELECT email, role, created_at FROM org_member_invites WHERE org_id = $1 ORDER BY created_at",
    [orgId],
  );
  return { members, invites };
}

export async function addMember(orgId: string, inviterId: string, rawEmail: string, role: "admin" | "member") {
  const email = normalizeEmail(rawEmail);
  if (!email) throw badRequest("Enter a valid email address.");
  const user = await one<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  if (user) {
    await pool().query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING",
      [orgId, user.id, role],
    );
    return { added: true, pending: false };
  }
  await pool().query(
    "INSERT INTO org_member_invites (org_id, email, role, invited_by) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, email) DO UPDATE SET role = EXCLUDED.role",
    [orgId, email, role, inviterId],
  );
  return { added: false, pending: true };
}

export async function setMemberRole(orgId: string, actorRole: OrgRole, userId: string, role: OrgRole | null) {
  await tx(async (db) => {
    const current = await one<{ role: OrgRole }>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE", [orgId, userId], db);
    if (!current) throw notFound("Member not found");
    if ((current.role === "owner" || role === "owner") && actorRole !== "owner") throw forbidden("Only owners can change owners.");
    if (current.role === "owner" && role !== "owner") {
      const owners = await one<{ n: string }>("SELECT count(*) AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId], db);
      if (Number(owners?.n) <= 1) throw conflict("An organization needs at least one owner.", "last_owner");
    }
    if (role === null) await db.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
    else await db.query("UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2", [orgId, userId, role]);
  });
}

/**
 * On sign-in with a verified email: claim pending invitations and join orgs
 * that auto-admit the email's domain.
 */
export async function claimMemberships(userId: string, verifiedEmail: string | null, db: Db = pool()): Promise<void> {
  if (!verifiedEmail) return;
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role)
       SELECT org_id, $1, role FROM org_member_invites WHERE email = $2
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [userId, verifiedEmail],
  );
  await db.query("DELETE FROM org_member_invites WHERE email = $1", [verifiedEmail]);
  const domain = verifiedEmail.split("@")[1];
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role)
       SELECT id, $1, 'member' FROM organizations WHERE $2 = ANY(allowed_email_domains)
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [userId, domain],
  );
}

/** Branding shown on meeting pages; only for plans that include it. */
export async function brandingFor(orgId: string | null): Promise<Branding | null> {
  if (!orgId) return null;
  const org = await getOrg(orgId);
  if (!org) return null;
  const { planForOwner } = await import("./plans");
  if (!(await planForOwner({ orgId })).customBranding) return null;
  return { displayName: org.name, ...org.branding };
}

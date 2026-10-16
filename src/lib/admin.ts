import { forbidden } from "./errors";
import type { RequestContext } from "./http";

/** Platform staff: users flagged platform_admin, or whose email is in PLATFORM_ADMIN_EMAILS. */
export async function requirePlatformAdmin(ctx: RequestContext) {
  const { user, session } = await ctx.requireUser();
  const { one } = await import("./db");
  const row = await one<{ platform_admin: boolean }>("SELECT platform_admin FROM users WHERE id = $1", [user.id]);
  const allow = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!row?.platform_admin && !(user.email && allow.includes(user.email))) throw forbidden("Platform admins only.");
  return { user, session };
}

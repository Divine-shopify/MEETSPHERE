import { z } from "zod";
import { route } from "@/lib/http";
import { badRequest } from "@/lib/errors";
import { getUser } from "@/lib/session";
import { checkVerification } from "@/lib/verification";

const schema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().min(4).max(12),
  displayName: z.string().trim().max(80).optional(),
});

export const POST = route(async (ctx) => {
  const body = await ctx.json(schema);
  const session = await ctx.session();
  if (!session) throw badRequest("Your session expired. Request a new code.", "no_session");
  const result = await checkVerification({ session, ...body });
  if (result.purpose !== "signin" || !result.userId || !result.rotatedToken) throw badRequest("This code was not issued for sign-in.");
  ctx.replaceSessionToken(result.rotatedToken, { ...session, user_id: result.userId });
  const user = await getUser(result.userId);
  return { user: { id: user!.id, displayName: user!.display_name } };
});

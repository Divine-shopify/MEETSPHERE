import { z } from "zod";
import { maskContact } from "@/lib/contact";
import { badRequest } from "@/lib/errors";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { checkVerification } from "@/lib/verification";

type P = { code: string };
const schema = z.object({ challengeId: z.string().uuid(), code: z.string().min(4).max(12) });

export const POST = route<P>(async (ctx, { code }) => {
  await requireMeeting(code);
  const body = await ctx.json(schema);
  const session = await ctx.session();
  if (!session) throw badRequest("Your session expired. Request a new code.", "no_session");
  const result = await checkVerification({ session, challengeId: body.challengeId, code: body.code });
  return { verified: { channel: result.channel, contact: maskContact(result.destination) } };
});

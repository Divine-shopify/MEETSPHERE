import { z } from "zod";
import { badRequest } from "@/lib/errors";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { addInvitations, invitationInputSchema, listInvitations, normalizeInvitation } from "@/lib/invitations";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting } = await hostOf(ctx, code);
  return { invitations: await listInvitations(meeting.id) };
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const input = await ctx.json(invitationInputSchema.extend({ defaultCountry: z.string().length(2).toUpperCase().optional() }));
  const normalized = normalizeInvitation(input, input.defaultCountry as never);
  if (typeof normalized === "string") throw badRequest(normalized, "invalid_invitation");
  const result = await addInvitations(meeting.id, user.id, [normalized]);
  if (result.added === 0) throw badRequest("That phone number or email is already on the list.", "duplicate");
  return Response.json(result, { status: 201 });
});

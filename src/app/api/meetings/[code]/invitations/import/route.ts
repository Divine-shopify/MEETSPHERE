import { z } from "zod";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { addInvitations, parseInvitationCsv } from "@/lib/invitations";

type P = { code: string };
const schema = z.object({
  csv: z.string().min(1).max(1_000_000),
  defaultCountry: z.string().length(2).toUpperCase().optional(),
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, user } = await hostOf(ctx, code);
  const body = await ctx.json(schema);
  const { rows, errors } = parseInvitationCsv(body.csv, body.defaultCountry as never);
  const result = await addInvitations(meeting.id, user.id, rows);
  return { ...result, errors: errors.slice(0, 100), errorCount: errors.length };
});

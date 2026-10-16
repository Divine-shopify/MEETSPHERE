import { route } from "@/lib/http";
import { consentSchema, myConsents, setConsent } from "@/lib/transcripts";
import { requireParticipant } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  return { consents: await myConsents(meeting, viewer) };
});

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireParticipant(ctx, code);
  const { kind, granted } = await ctx.json(consentSchema);
  await setConsent(meeting, viewer, kind, granted);
  return { consents: await myConsents(meeting, viewer) };
});

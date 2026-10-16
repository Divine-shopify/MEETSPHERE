import { listAudit } from "@/lib/audit";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting } = await hostOf(ctx, code);
  return { events: await listAudit(meeting.id) };
});

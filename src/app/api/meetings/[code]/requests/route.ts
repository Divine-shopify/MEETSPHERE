import { listForHost } from "@/lib/admission";
import { hostOf } from "@/lib/guards";
import { route } from "@/lib/http";
import { listIdentities } from "@/lib/media";
import { hostView } from "@/lib/meetings";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting } = await hostOf(ctx, code);
  const [requests, connected] = await Promise.all([listForHost(meeting), listIdentities(meeting)]);
  const online = new Set(connected);
  return {
    meeting: hostView(meeting),
    requests: requests.map((r) => ({ ...r, connected: online.has(r.identity) })),
  };
});

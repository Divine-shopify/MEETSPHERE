import { route } from "@/lib/http";
import { safetySnapshot } from "@/lib/safety";
import { requireModerator } from "@/lib/viewer";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const { meeting } = await requireModerator(ctx, code);
  return safetySnapshot(meeting);
});

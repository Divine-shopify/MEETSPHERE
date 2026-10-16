import { route } from "@/lib/http";
import { clearBoard } from "@/lib/whiteboard";
import { requireModerator } from "@/lib/viewer";

type P = { code: string };

export const POST = route<P>(async (ctx, { code }) => {
  const { meeting, viewer } = await requireModerator(ctx, code);
  await clearBoard(meeting, viewer);
  return { ok: true };
});

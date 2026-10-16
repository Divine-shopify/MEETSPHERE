import { route } from "@/lib/http";
import { searchMeetings } from "@/lib/notes";
import { enforce } from "@/lib/ratelimit";

export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  await enforce(`search:${user.id}`, 60, 60);
  const q = new URL(ctx.req.url).searchParams.get("q") ?? "";
  return { results: await searchMeetings(user.id, q) };
});

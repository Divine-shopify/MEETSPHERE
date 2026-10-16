import { route } from "@/lib/http";
import { createMeeting, createMeetingSchema, hostView, listHostedMeetings } from "@/lib/meetings";
import { enforce } from "@/lib/ratelimit";

export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const meetings = await listHostedMeetings(user.id);
  return { meetings: meetings.map(hostView) };
});

export const POST = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const input = await ctx.json(createMeetingSchema);
  await enforce(`meeting:create:${user.id}`, 50, 3600, "You've created a lot of meetings recently. Try again later.");
  const meeting = await createMeeting(user.id, input);
  return Response.json({ meeting: hostView(meeting) }, { status: 201 });
});

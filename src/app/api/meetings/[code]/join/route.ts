import { z } from "zod";
import { applicantView, getOwnRequest, submitJoinRequest } from "@/lib/admission";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import { enforce } from "@/lib/ratelimit";

type P = { code: string };
const schema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  method: z.enum(["phone", "email", "name"]),
});

export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const own = await getOwnRequest(meeting, await ctx.session());
  return { request: own ? applicantView(own) : null, locked: meeting.locked_at !== null, ended: meeting.status === "ended" };
});

export const POST = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const body = await ctx.json(schema);
  // Join-burst protection per IP and per meeting.
  await enforce(`join:ip:${ctx.ip()}`, 30, 600);
  await enforce(`join:meeting:${meeting.id}`, 600, 60, "This meeting is receiving too many join requests. Try again in a minute.");
  const session = await ctx.ensureSession();
  const jr = await submitJoinRequest({ meeting, session, name: body.name, method: body.method });
  return { request: applicantView(jr) };
});

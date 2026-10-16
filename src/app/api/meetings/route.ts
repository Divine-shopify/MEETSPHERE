import { forbidden } from "@/lib/errors";
import { route } from "@/lib/http";
import { addInvitations } from "@/lib/invitations";
import { createMeeting, createMeetingSchema, hostView, listHostedMeetings, type Settings } from "@/lib/meetings";
import { getOrg, orgRole } from "@/lib/orgs";
import { getPresetFor } from "@/lib/presets";
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

  // Layering: organization defaults < preset < explicit fields in this request.
  let defaults: Settings = {};
  if (input.orgId) {
    if (!(await orgRole(input.orgId, user.id))) throw forbidden("You're not a member of that organization.");
    defaults = { ...((await getOrg(input.orgId))?.default_meeting_settings as Settings) };
  }
  const preset = input.presetId ? await getPresetFor(user.id, input.presetId) : null;
  if (preset) defaults = { ...defaults, ...preset.settings };

  const meeting = await createMeeting(user.id, input, defaults);
  if (preset?.invitations.length) await addInvitations(meeting.id, user.id, preset.invitations);
  return Response.json({ meeting: hostView(meeting) }, { status: 201 });
});

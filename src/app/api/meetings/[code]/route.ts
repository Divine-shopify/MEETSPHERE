import { applicantView, getOwnRequest } from "@/lib/admission";
import { maskContact } from "@/lib/contact";
import { one } from "@/lib/db";
import { route } from "@/lib/http";
import { mediaConfigured } from "@/lib/media";
import { hostView, publicView, requireMeeting } from "@/lib/meetings";
import { channelModes } from "@/lib/messaging";
import { brandingFor } from "@/lib/orgs";
import { recordingConfigured } from "@/lib/recording";
import { viewerFor } from "@/lib/viewer";
import { config } from "@/lib/config";
import { googleCalendarUrl } from "@/lib/ics";

type P = { code: string };

export const GET = route<P>(async (ctx, { code }) => {
  const meeting = await requireMeeting(code);
  const viewer = await viewerFor(ctx, meeting);
  const session = viewer.session;
  const host = await one<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [meeting.host_user_id]);
  const own = await getOwnRequest(meeting, session);
  return {
    meeting: publicView(meeting, host?.display_name ?? "Host", await brandingFor(meeting.org_id)),
    host: viewer.kind === "host" ? hostView(meeting) : null,
    viewer: { kind: viewer.kind, moderator: viewer.moderator, key: viewer.key, name: viewer.name, role: viewer.role },
    myRequest: own ? applicantView(own) : null,
    myVerified: {
      phone: maskContact(session?.verified_phone ?? null),
      email: maskContact(session?.verified_email ?? null),
    },
    services: { verification: channelModes(), media: mediaConfigured(), recording: recordingConfigured() },
    googleCalendarUrl: meeting.scheduled_at ? googleCalendarUrl(meeting, `${config.baseUrl}/m/${meeting.code}`) : null,
    // Live HLS stream for admitted participants (large-audience viewing).
    liveStreamId: viewer.kind !== "none" && meeting.stream_state !== "off" ? meeting.stream_artifact_id : null,
  };
});

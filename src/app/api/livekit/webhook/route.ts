import { ParticipantInfo_Kind } from "@livekit/protocol";
import { admitSipCaller, identityStillAllowed, sipIdentityAllowed } from "@/lib/admission";
import { audit } from "@/lib/audit";
import { one, pool } from "@/lib/db";
import { forbidden } from "@/lib/errors";
import { publish } from "@/lib/events";
import { route } from "@/lib/http";
import { kickFromRoom, parseRoomName, webhookReceiver } from "@/lib/media";
import { getMeetingById } from "@/lib/meetings";
import { handleEgressUpdate } from "@/lib/recording";
import { recordUsage } from "@/lib/usage";

// LiveKit server -> MeetSphere. Verified by the JWT signature LiveKit sends.
export const POST = route(
  async (ctx) => {
    const body = await ctx.req.text();
    let event;
    try {
      event = await webhookReceiver().receive(body, ctx.req.headers.get("authorization") ?? undefined);
    } catch {
      throw forbidden("Invalid webhook signature");
    }

    if (event.egressInfo && event.event.startsWith("egress_")) {
      await handleEgressUpdate(event.egressInfo);
      return { ok: true };
    }

    const room = event.room?.name;
    const parsed = room ? parseRoomName(room) : null;
    if (!room || !parsed) return { ok: true };
    const meeting = await getMeetingById(parsed.meetingId);
    if (!meeting) return { ok: true };
    const p = event.participant;
    const identity = p?.identity;

    if (event.event === "participant_joined" && p && identity) {
      const kind = p.kind === ParticipantInfo_Kind.SIP ? "sip" : p.kind === ParticipantInfo_Kind.EGRESS ? "egress" : "standard";
      let allowed: boolean;
      if (kind === "egress") allowed = true;
      else if (kind === "sip") {
        allowed = (await sipIdentityAllowed(meeting, identity)) || (await admitSipCaller(meeting, identity, p.attributes?.["sip.phoneNumber"] ?? null)).allowed;
      } else allowed = await identityStillAllowed(meeting, identity, room);

      if (!allowed) {
        await kickFromRoom(room, identity);
        await audit({ meetingId: meeting.id, action: "unauthorized_media_join_kicked", metadata: { identity, room, kind } });
        return { ok: true };
      }
      if (kind !== "egress") {
        await pool().query("INSERT INTO participant_sessions (meeting_id, room, identity, kind) VALUES ($1, $2, $3, $4)", [meeting.id, room, identity, kind]);
        await audit({ meetingId: meeting.id, action: "participant_joined", targetId: identity.split(":")[1] ?? null, metadata: { identity, room } });
        await publish({ meetingId: meeting.id, type: "presence", audience: "moderators", data: { identity, room, joined: true } });
      }
    } else if (event.event === "participant_left" && identity) {
      const s = await one<{ minutes: number; kind: string }>(
        `UPDATE participant_sessions SET left_at = now()
          WHERE id = (SELECT id FROM participant_sessions WHERE meeting_id = $1 AND room = $2 AND identity = $3 AND left_at IS NULL
                      ORDER BY joined_at DESC LIMIT 1)
          RETURNING ceil(extract(epoch FROM (left_at - joined_at)) / 60)::int AS minutes, kind`,
        [meeting.id, room, identity],
      );
      if (s) {
        const owner = { hostUserId: meeting.host_user_id, orgId: meeting.org_id, meetingId: meeting.id };
        await recordUsage({ kind: "participant_minutes", quantity: s.minutes, ...owner });
        if (s.kind === "sip") await recordUsage({ kind: "dialin_minutes", quantity: s.minutes, ...owner });
        await audit({ meetingId: meeting.id, action: "participant_left", targetId: identity.split(":")[1] ?? null, metadata: { identity, room, minutes: s.minutes } });
        await publish({ meetingId: meeting.id, type: "presence", audience: "moderators", data: { identity, room, joined: false } });
      }
    } else if (event.event === "room_finished") {
      // Close anything left open (e.g. missed participant_left), charging up to now.
      const rows = await pool().query<{ minutes: number }>(
        `UPDATE participant_sessions SET left_at = now() WHERE meeting_id = $1 AND room = $2 AND left_at IS NULL
         RETURNING ceil(extract(epoch FROM (left_at - joined_at)) / 60)::int AS minutes`,
        [meeting.id, room],
      );
      const total = rows.rows.reduce((a, r) => a + r.minutes, 0);
      await recordUsage({ kind: "participant_minutes", quantity: total, hostUserId: meeting.host_user_id, orgId: meeting.org_id, meetingId: meeting.id });
    }
    return { ok: true };
  },
  { skipOriginCheck: true },
);

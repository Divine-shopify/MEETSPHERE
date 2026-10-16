import { z } from "zod";
import { audit } from "./audit";
import { one, query, tx } from "./db";
import { badRequest, conflict, HttpError, notFound } from "./errors";
import { publish } from "./events";
import { breakoutRoomName, deleteRoom } from "./media";
import type { Meeting } from "./meetings";
import { planForMeeting } from "./plans";
import type { Viewer } from "./viewer";

export const breakoutSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), count: z.number().int().min(1).max(200).optional(), names: z.array(z.string().trim().min(1).max(60)).max(200).optional() }),
  z.object({ action: z.literal("assign"), requestId: z.string().uuid(), breakoutId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("auto_assign") }),
  z.object({ action: z.literal("open") }),
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("broadcast"), message: z.string().trim().min(1).max(300) }),
  z.object({ action: z.literal("delete_all") }),
]);

const changed = (m: Meeting) => publish({ meetingId: m.id, type: "breakouts_changed", audience: "all" });

export async function listBreakouts(m: Meeting, v: Viewer) {
  const rooms = await query<{ id: string; name: string }>("SELECT id, name FROM breakout_rooms WHERE meeting_id = $1 ORDER BY position, created_at", [m.id]);
  const assignments = await query<{ join_request_id: string; breakout_id: string; name: string }>(
    `SELECT ba.join_request_id, ba.breakout_id, jr.submitted_name AS name FROM breakout_assignments ba
       JOIN join_requests jr ON jr.id = ba.join_request_id WHERE ba.meeting_id = $1`,
    [m.id],
  );
  const mine = v.request ? assignments.find((a) => a.join_request_id === v.request!.id)?.breakout_id ?? null : null;
  return {
    open: m.breakouts_open,
    myBreakoutId: mine,
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      // Participants see who's in their own room only.
      members: v.moderator || r.id === mine ? assignments.filter((a) => a.breakout_id === r.id).map((a) => ({ id: a.join_request_id, name: a.name })) : undefined,
    })),
  };
}

export async function manageBreakouts(m: Meeting, v: Viewer, input: z.infer<typeof breakoutSchema>) {
  const actor = { actorUserId: v.actorUserId, actorSessionId: v.actorSessionId };
  switch (input.action) {
    case "create": {
      const plan = await planForMeeting(m);
      const names = input.names ?? Array.from({ length: input.count ?? 2 }, (_, i) => `Room ${i + 1}`);
      const existing = await one<{ n: string }>("SELECT count(*) AS n FROM breakout_rooms WHERE meeting_id = $1", [m.id]);
      if (Number(existing?.n) + names.length > plan.breakoutRooms) {
        throw new HttpError(402, "plan_limit", `Your plan allows ${plan.breakoutRooms} breakout rooms.`);
      }
      for (const [i, name] of names.entries()) {
        await query("INSERT INTO breakout_rooms (meeting_id, name, position) VALUES ($1, $2, $3)", [m.id, name, Number(existing?.n) + i]);
      }
      break;
    }
    case "assign": {
      const jr = await one<{ status: string }>("SELECT status FROM join_requests WHERE id = $1 AND meeting_id = $2", [input.requestId, m.id]);
      if (!jr || jr.status !== "admitted") throw notFound("Participant not found");
      if (input.breakoutId === null) {
        await query("DELETE FROM breakout_assignments WHERE meeting_id = $1 AND join_request_id = $2", [m.id, input.requestId]);
      } else {
        const b = await one("SELECT 1 FROM breakout_rooms WHERE id = $1 AND meeting_id = $2", [input.breakoutId, m.id]);
        if (!b) throw notFound("Breakout room not found");
        await query(
          `INSERT INTO breakout_assignments (meeting_id, join_request_id, breakout_id) VALUES ($1, $2, $3)
           ON CONFLICT (meeting_id, join_request_id) DO UPDATE SET breakout_id = EXCLUDED.breakout_id`,
          [m.id, input.requestId, input.breakoutId],
        );
      }
      await publish({ meetingId: m.id, type: "breakouts_changed", audience: `jr:${input.requestId}`, data: { moved: true } });
      break;
    }
    case "auto_assign": {
      await tx(async (db) => {
        const rooms = (await db.query<{ id: string }>("SELECT id FROM breakout_rooms WHERE meeting_id = $1 ORDER BY position", [m.id])).rows;
        if (!rooms.length) throw badRequest("Create breakout rooms first.");
        // Everyone admitted except co-hosts and phone callers, shuffled, dealt round-robin.
        const people = (
          await db.query<{ id: string }>(
            `SELECT jr.id FROM join_requests jr
               LEFT JOIN meeting_roles r ON r.meeting_id = jr.meeting_id AND r.guest_session_id = jr.session_id
              WHERE jr.meeting_id = $1 AND jr.status = 'admitted' AND jr.sip_identity IS NULL AND coalesce(r.role, '') <> 'cohost'`,
            [m.id],
          )
        ).rows.sort(() => Math.random() - 0.5);
        await db.query("DELETE FROM breakout_assignments WHERE meeting_id = $1", [m.id]);
        for (const [i, p] of people.entries()) {
          await db.query("INSERT INTO breakout_assignments (meeting_id, join_request_id, breakout_id) VALUES ($1, $2, $3)", [m.id, p.id, rooms[i % rooms.length].id]);
        }
      });
      break;
    }
    case "open": {
      const rooms = await one<{ n: string }>("SELECT count(*) AS n FROM breakout_rooms WHERE meeting_id = $1", [m.id]);
      if (!Number(rooms?.n)) throw badRequest("Create breakout rooms first.");
      await query("UPDATE meetings SET breakouts_open = true WHERE id = $1", [m.id]);
      await audit({ meetingId: m.id, action: "breakouts_opened", ...actor });
      break;
    }
    case "close":
      if (!m.breakouts_open) throw conflict("Breakout rooms aren't open.", "not_open");
      await query("UPDATE meetings SET breakouts_open = false WHERE id = $1", [m.id]);
      await audit({ meetingId: m.id, action: "breakouts_closed", ...actor });
      break;
    case "broadcast":
      await publish({ meetingId: m.id, type: "broadcast_message", audience: "all", data: { from: v.name, message: input.message } });
      return;
    case "delete_all": {
      if (m.breakouts_open) throw conflict("Close breakout rooms before deleting them.", "open");
      const rooms = await query<{ id: string }>("SELECT id FROM breakout_rooms WHERE meeting_id = $1", [m.id]);
      await query("DELETE FROM breakout_rooms WHERE meeting_id = $1", [m.id]);
      for (const r of rooms) await deleteRoom(breakoutRoomName(m, r.id));
      break;
    }
  }
  await changed(m);
}

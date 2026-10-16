import { query } from "@/lib/db";
import { route } from "@/lib/http";

/** Data portability: everything we hold that's tied to the signed-in user. */
export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const [profile, meetings, invitations, orgs, presets, usage, webhooks] = await Promise.all([
    query("SELECT id, display_name, email, phone_e164, email_verified_at, phone_verified_at, created_at FROM users WHERE id = $1", [user.id]),
    query(
      `SELECT m.code, m.title, m.mode, m.status, m.scheduled_at, m.created_at, m.ended_at,
              (SELECT json_agg(json_build_object('name', jr.submitted_name, 'method', jr.identity_method, 'status', jr.status, 'requested_at', jr.requested_at))
                 FROM join_requests jr WHERE jr.meeting_id = m.id) AS attendees,
              (SELECT json_agg(json_build_object('speaker', s.speaker_name, 'text', s.text, 'at', s.spoken_at) ORDER BY s.spoken_at)
                 FROM transcript_segments s WHERE s.meeting_id = m.id) AS transcript,
              (SELECT row_to_json(n) FROM (SELECT host_notes, summary, decisions, action_items FROM meeting_notes WHERE meeting_id = m.id) n) AS notes
         FROM meetings m WHERE m.host_user_id = $1 ORDER BY m.created_at`,
      [user.id],
    ),
    query(
      "SELECT i.expected_name, i.normalized_phone, i.normalized_email, m.code FROM invitations i JOIN meetings m ON m.id = i.meeting_id WHERE m.host_user_id = $1",
      [user.id],
    ),
    query("SELECT o.name, o.slug, m.role FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1", [user.id]),
    query("SELECT name, settings, invitations, created_at FROM access_presets WHERE owner_user_id = $1", [user.id]),
    query("SELECT kind, sum(quantity) AS total FROM usage_events WHERE host_user_id = $1 GROUP BY kind", [user.id]),
    query("SELECT url, events, created_at FROM webhook_endpoints WHERE owner_user_id = $1", [user.id]),
  ]);
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), profile: profile[0], meetings, invitations, orgs, presets, usage, webhooks }, null, 2);
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="meetsphere-export.json"` },
  });
});

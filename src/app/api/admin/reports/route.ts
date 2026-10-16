import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/admin";
import { pool, query } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { route } from "@/lib/http";

export const GET = route(async (ctx) => {
  await requirePlatformAdmin(ctx);
  const reports = await query(
    `SELECT a.id, a.reason, a.details, a.status, a.created_at, m.code AS meeting_code, m.title AS meeting_title,
            jr.submitted_name AS target_name, u.display_name AS host_name, u.email AS host_email
       FROM abuse_reports a
       LEFT JOIN meetings m ON m.id = a.meeting_id
       LEFT JOIN users u ON u.id = m.host_user_id
       LEFT JOIN join_requests jr ON jr.id = a.target_request_id
      ORDER BY (a.status = 'open') DESC, a.created_at DESC LIMIT 200`,
  );
  return { reports };
});

export const PATCH = route(async (ctx) => {
  const { user } = await requirePlatformAdmin(ctx);
  const { id, status } = await ctx.json(z.object({ id: z.string().uuid(), status: z.enum(["open", "reviewed", "actioned"]) }));
  const r = await pool().query("UPDATE abuse_reports SET status = $2, reviewed_by = $3 WHERE id = $1", [id, status, user.id]);
  if (!r.rowCount) throw notFound("Report not found");
  return { ok: true };
});

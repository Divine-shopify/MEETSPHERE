import { query } from "@/lib/db";
import { safeEqual, sha256 } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/** Prometheus metrics. Protect with METRICS_TOKEN (Bearer) in production. */
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!safeEqual(sha256(got), sha256(token))) return new Response("forbidden", { status: 403 });
  } else if (process.env.NODE_ENV === "production") {
    return new Response("METRICS_TOKEN not set", { status: 503 });
  }
  const g = await query<Record<string, string>>(
    `SELECT
      (SELECT count(*) FROM meetings WHERE status = 'live') AS live_meetings,
      (SELECT count(*) FROM participant_sessions WHERE left_at IS NULL) AS media_sessions,
      (SELECT count(*) FROM participant_sessions WHERE left_at IS NULL AND kind = 'sip') AS phone_sessions,
      (SELECT count(*) FROM join_requests WHERE status = 'pending') AS waiting_requests,
      (SELECT count(*) FROM meetings WHERE recording_state = 'active') AS active_recordings,
      (SELECT count(*) FROM meetings WHERE stream_state = 'active') AS active_streams,
      (SELECT count(*) FROM webhook_deliveries WHERE status = 'pending') AS webhook_backlog,
      (SELECT count(*) FROM abuse_reports WHERE status = 'open') AS open_abuse_reports`,
  );
  const usage = await query<{ kind: string; n: string }>(
    "SELECT kind, coalesce(sum(quantity), 0) AS n FROM usage_events WHERE created_at > now() - interval '1 hour' GROUP BY kind",
  );
  const lines: string[] = [];
  for (const [k, v] of Object.entries(g[0] ?? {})) {
    lines.push(`# TYPE meetsphere_${k} gauge`, `meetsphere_${k} ${Number(v)}`);
  }
  lines.push("# TYPE meetsphere_usage_last_hour gauge");
  for (const u of usage) lines.push(`meetsphere_usage_last_hour{kind="${u.kind}"} ${Number(u.n)}`);
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" } });
}

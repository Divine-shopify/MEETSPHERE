import { requirePlatformAdmin } from "@/lib/admin";
import { one, query } from "@/lib/db";
import { route } from "@/lib/http";

/** Platform-wide operations overview for support staff. */
export const GET = route(async (ctx) => {
  await requirePlatformAdmin(ctx);
  const totals = await one<Record<string, string>>(
    `SELECT (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM organizations) AS orgs,
            (SELECT count(*) FROM meetings) AS meetings,
            (SELECT count(*) FROM meetings WHERE status = 'live') AS live_meetings,
            (SELECT count(DISTINCT identity) FROM participant_sessions WHERE left_at IS NULL) AS connected,
            (SELECT count(*) FROM abuse_reports WHERE status = 'open') AS open_reports,
            (SELECT count(*) FROM webhook_deliveries WHERE status = 'failed' AND created_at > now() - interval '1 day') AS failed_webhooks_24h`,
  );
  const usage = await query<{ kind: string; n: string }>(
    "SELECT kind, sum(quantity) AS n FROM usage_events WHERE created_at >= date_trunc('month', now()) GROUP BY kind ORDER BY kind",
  );
  const topHosts = await query<{ display_name: string; email: string | null; minutes: string }>(
    `SELECT u.display_name, u.email, sum(e.quantity) AS minutes FROM usage_events e JOIN users u ON u.id = e.host_user_id
      WHERE e.kind = 'participant_minutes' AND e.created_at >= date_trunc('month', now())
      GROUP BY u.id ORDER BY minutes DESC LIMIT 20`,
  );
  return {
    totals: Object.fromEntries(Object.entries(totals ?? {}).map(([k, v]) => [k, Number(v)])),
    usageThisMonth: Object.fromEntries(usage.map((u) => [u.kind, Number(u.n)])),
    topHosts: topHosts.map((h) => ({ ...h, minutes: Number(h.minutes) })),
  };
});

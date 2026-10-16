import { pool } from "@/lib/db";
import { livekitHttpUrl, mediaConfigured } from "@/lib/media";
import { storageMode } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Liveness/readiness for load balancers. 503 when the database is unreachable. */
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;
  try {
    await pool().query("SELECT 1");
    checks.database = "ok";
  } catch {
    checks.database = "down";
    ok = false;
  }
  if (mediaConfigured()) {
    try {
      const res = await fetch(livekitHttpUrl(), { signal: AbortSignal.timeout(2000) });
      checks.media = res.ok ? "ok" : `http_${res.status}`;
    } catch {
      checks.media = "unreachable"; // degraded, not down: admission still works
    }
  } else checks.media = "not_configured";
  checks.storage = storageMode() ?? "not_configured";
  return Response.json({ status: ok ? "ok" : "down", checks }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

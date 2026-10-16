import { one, type Db, pool } from "./db";
import { tooManyRequests } from "./errors";

/**
 * Fixed-window counter stored in Postgres so limits hold across server
 * instances. Returns true when the call is within the limit.
 */
export async function hit(key: string, limit: number, windowSeconds: number, db: Db = pool()): Promise<boolean> {
  const row = await one<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSeconds],
    db,
  );
  return (row?.count ?? 0) <= limit;
}

export async function enforce(key: string, limit: number, windowSeconds: number, message?: string): Promise<void> {
  if (!(await hit(key, limit, windowSeconds))) throw tooManyRequests(message);
}

export async function pruneRateLimits(db: Db = pool()): Promise<void> {
  await db.query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'");
}

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config";

const globalForPool = globalThis as unknown as { __meetspherePool?: Pool };

export function pool(): Pool {
  if (!globalForPool.__meetspherePool) {
    globalForPool.__meetspherePool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }
  return globalForPool.__meetspherePool;
}

export type Db = Pick<PoolClient, "query">;

export async function query<T extends QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool()) {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool()) {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalForPool.__meetspherePool) {
    await globalForPool.__meetspherePool.end();
    globalForPool.__meetspherePool = undefined;
  }
}

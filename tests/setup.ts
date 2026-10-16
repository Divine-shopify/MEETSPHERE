import { afterAll, beforeAll, beforeEach } from "vitest";
import { migrate } from "../scripts/migrate";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/meetsphere_test";
process.env.VERIFICATION_DEV_MODE = "true";
process.env.APP_BASE_URL = "http://localhost:3000";
// Dummy media credentials: tokens are signed locally; no media server is contacted in tests.
process.env.LIVEKIT_URL = "ws://127.0.0.1:1";
process.env.LIVEKIT_API_KEY = "testkey";
process.env.LIVEKIT_API_SECRET = "testsecret-testsecret-testsecret-0000";
process.env.ALLOW_PRIVATE_OUTBOUND = "true";
process.env.APP_SECRET = "test-secret-test-secret-test-secret-0123";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RECORDINGS_DIR;
delete process.env.S3_BUCKET;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.RESEND_API_KEY;

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});

beforeEach(async () => {
  const { pool } = await import("../src/lib/db");
  const { rows } = await pool().query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  await pool().query(`TRUNCATE ${rows.map((r) => r.tablename).join(", ")} CASCADE`);
});

afterAll(async () => {
  const { closeBus } = await import("../src/lib/events");
  await closeBus();
  const { closePool } = await import("../src/lib/db");
  await closePool();
});

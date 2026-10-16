import { afterAll, beforeAll, beforeEach } from "vitest";
import { migrate } from "../scripts/migrate";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/meetsphere_test";
process.env.VERIFICATION_DEV_MODE = "true";
process.env.APP_BASE_URL = "http://localhost:3000";
// Dummy media credentials: tokens are signed locally; no media server is contacted in tests.
process.env.LIVEKIT_URL = "ws://127.0.0.1:1";
process.env.LIVEKIT_API_KEY = "testkey";
process.env.LIVEKIT_API_SECRET = "testsecret-testsecret-testsecret-0000";
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.RESEND_API_KEY;

beforeAll(async () => {
  await migrate(process.env.DATABASE_URL!, () => {});
});

beforeEach(async () => {
  const { pool } = await import("../src/lib/db");
  await pool().query(
    `TRUNCATE users, sessions, verification_challenges, rate_limits, meetings, invitations, join_requests,
              meeting_roles, meeting_blocks, moderation_events, meeting_artifacts, usage_events CASCADE`,
  );
});

afterAll(async () => {
  const { closePool } = await import("../src/lib/db");
  await closePool();
});

// Demo data for local development. Sign in as the demo host with the email
// below (dev-mode OTP) to see a meeting with an invite list.
import { Client } from "pg";

const DEMO_EMAIL = "demo-host@example.com";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (display_name, email, email_verified_at) VALUES ('Demo Host', $1, now())
       ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
      [DEMO_EMAIL],
    );
    const hostId = user.rows[0].id;
    const meeting = await db.query<{ id: string; code: string }>(
      `INSERT INTO meetings (code, host_user_id, title, access_policy)
       VALUES ('dem-oroo-mxx', $1, 'Demo: invited-only class', 'invited_only')
       ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title RETURNING id, code`,
      [hostId],
    );
    const m = meeting.rows[0];
    await db.query(
      `INSERT INTO meeting_roles (meeting_id, user_id, role, granted_by) VALUES ($1, $2, 'host', $2)
       ON CONFLICT (meeting_id, user_id) WHERE user_id IS NOT NULL DO NOTHING`,
      [m.id, hostId],
    );
    const invitees = [
      ["Ada Lovelace", "+447911123456", "ada@example.com"],
      ["Grace Hopper", null, "grace@example.com"],
      ["Alan Turing", "+447911123457", null],
    ];
    for (const [name, phone, email] of invitees) {
      await db.query(
        `INSERT INTO invitations (meeting_id, expected_name, normalized_phone, normalized_email) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [m.id, name, phone, email],
      );
    }
    console.log(`Seeded demo host ${DEMO_EMAIL} and meeting /m/${m.code} with ${invitees.length} invitees.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

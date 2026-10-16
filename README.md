# MeetSphere

Phone-first video meetings where the host controls exactly who gets in.
Guests join from a link in their phone browser (no app). Hosts see who
verified a phone/email, who is on the invite list, and who only typed a name.

> Working name. Check trademarks, domains and app-store availability before committing to it.

## Status (Phase 1 MVP)

| Area | State |
| --- | --- |
| Host sign-in by phone/email OTP | Done |
| Create instant/scheduled meeting, share link (copy / native share) | Done |
| Join by verified phone, verified email, or name-only request | Done |
| Expected-attendee list, manual entry and CSV import | Done |
| Admission policies: anyone with link / invited only / verified only / host approval | Done, enforced server-side |
| Waiting room, admit, admit all, reject, remove, block, unblock, lock, end | Done |
| Identity badges: name entered (unverified) / contact verified / invited / host approved | Done |
| Real audio/video, screen share, chat, reactions via LiveKit | Done, tested with real WebRTC |
| Hand raise (server-set, can't be spoofed), mute one / mute all | Done |
| Restrict screen share and chat (applied live to people already in the room) | Done |
| Low-data mode (low-res incoming video) and audio-only mode | Done |
| Reconnect: LiveKit auto-reconnect + rejoin without re-approval | Done |
| Audit trail of admission, moderation and room join/leave | Done |
| Presentation mode (speakers + audience, promote to speaker) | **Preview**: runs on the same SFU, capped by plan limit. Not a scalable broadcast path |
| Large-audience broadcast (thousands of viewers) | **Not implemented** (Phase 3) |
| Recording, transcripts, AI summaries | **Not implemented**. `meeting_artifacts` table exists, nothing writes to it |
| Telephone dial-in | **Not implemented** |
| Paid plans / billing | **Not implemented**. Limits are configurable; everyone is on "free" |
| Native apps | **Not implemented** |

There is **no meeting duration cutoff** in MeetSphere's own logic. Fair-use
limits (participants per room, invitations per meeting, OTP sends per host per
day) are configurable, and your media/SMS/email providers' quotas still apply.

## Quick start (local)

Requirements: Node 20+, PostgreSQL 14+, and for audio/video a LiveKit server
(LiveKit Cloud or the `livekit-server` binary).

```bash
npm install
cp .env.example .env.local          # then edit values
createdb meetsphere
DATABASE_URL=postgres://localhost/meetsphere npm run db:migrate
DATABASE_URL=postgres://localhost/meetsphere npm run db:seed   # optional demo data

# Media, local option: LiveKit dev server (key "devkey", secret "secret")
livekit-server --dev
#   then in .env.local: LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret

# Without SMS/email providers, show codes on screen (clearly labeled, never in production):
#   VERIFICATION_DEV_MODE=true
npm run dev
```

Open http://localhost:3000, "Host a meeting", sign in, create a meeting, open
the link in a private window to join as a guest.

Camera and microphone require a secure context: `localhost` works, but testing
from a phone on your LAN needs HTTPS (e.g. a tunnel such as `cloudflared` or `ngrok`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev server / production build / production server |
| `npm run db:migrate` | Apply SQL migrations in `migrations/` |
| `npm run db:seed` | Demo host `demo-host@example.com` and meeting `/m/dem-oroo-mxx` |
| `npm test` | Unit + HTTP-level integration tests (needs Postgres, see below) |
| `npm run typecheck`, `npm run lint` | TypeScript and ESLint |

### Tests

```bash
createdb meetsphere_test
TEST_DATABASE_URL=postgres://localhost/meetsphere_test npm test
```

Covers the admission policy, invite matching, OTP hashing/attempt limits/rate
limits, session binding of OTP challenges, rejection stickiness, lock/remove/block,
contact-detail privacy, CSRF origin checks, and authorization of every host
endpoint. Media tokens are decoded and their grants asserted.

End-to-end smoke test with real WebRTC (fake camera/mic in headless Chromium),
against a running app (`VERIFICATION_DEV_MODE=true`) and LiveKit server:

```bash
BASE_URL=http://127.0.0.1:3000 CHROMIUM_PATH=/path/to/chrome node tests/e2e/smoke.mjs
```

It signs in a host via OTP, creates a meeting, joins as host, has a guest wait,
checks the token endpoint refuses the waiting guest, admits them, confirms
decoded video both ways, raises a hand, locks the room, removes the guest, and
checks they are disconnected and refused a new token.

## Configuration

All configuration is via environment variables; see [`.env.example`](.env.example).
Secrets are never committed.

| Service | Variables | Needed for |
| --- | --- | --- |
| PostgreSQL | `DATABASE_URL` | Everything |
| App secret | `APP_SECRET` (32+ chars) | HMAC of OTP codes; required in production |
| LiveKit | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Audio/video. Without it, admission works but the room shows "media not configured" |
| Twilio Programmable Messaging | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Phone OTP |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM` | Email OTP |
| Plan limits | `FREE_MAX_PARTICIPANTS`, `FREE_MAX_INVITATIONS`, `FREE_OTP_SENDS_PER_HOST_PER_DAY` | Fair-use caps |

## Docs

- [Architecture and security model](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Load-test plan](docs/LOAD_TEST_PLAN.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

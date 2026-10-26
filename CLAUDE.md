# MeetSphere — context for Claude

Phone-first video meetings and large events with host-controlled admission
(verified phone/email, invite lists, waiting room, blocks). Built from
"MeetSphere Product Vision and Build Prompt"; all three phases are implemented.

## Stack
- Next.js 15 App Router + React 19 + TypeScript (`src/app`, API routes wrapped by `route()` in `src/lib/http.ts`)
- PostgreSQL via `pg`, SQL migrations in `migrations/` (run `npm run migrate`)
- LiveKit (SFU) + Egress (recording/HLS) + SIP (dial-in/out); real-time app events via Postgres LISTEN/NOTIFY → SSE
- Stripe (REST), OIDC SSO, Twilio/Resend, S3, Anthropic API — all optional; missing ones are reported in the UI
- Domain logic lives in `src/lib/*.ts`; UI components in `src/components`

## Commands
- `npm run dev` / `npm run build` / `npm start`
- `npm test` (vitest, needs Postgres: `DATABASE_URL`) — 67 tests
- `node tests/e2e/smoke.mjs` etc. need a running app + LiveKit
- Local stack: `deploy/docker-compose.yml`; env vars documented in `.env.example`

## Status (honest)
- Verified locally: admission, room, collaboration, recording/HLS via Egress, load test (200 viewers, one box)
- Never run against real providers: Twilio/Resend, Stripe checkout, real IdP SSO, S3, SIP trunk, Anthropic API
- `native/` Capacitor Android/iOS projects are generated but never compiled
- Nothing is deployed. See `docs/DEPLOYMENT.md`.

## Conventions
- Validate input with zod in route handlers; throw `HttpError` from `src/lib/errors.ts`
- Every admission/moderation action writes a `moderation_events` audit row
- Sign-in codes are shown on screen only with `VERIFICATION_DEV_MODE=true` (and `DEMO_MODE=true` in production)

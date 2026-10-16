# MeetSphere

Phone-first video meetings and large events where the host controls exactly
who gets in. Guests join from a link in their phone browser (or the installable
app). Hosts see who verified a phone or email, who is on the invite list, and
who only typed a name.

> Working name. Check trademarks, domains and app-store availability before committing to it.

## What's built

"Verified here" means exercised by the automated tests in this repo (see [Testing](#testing)).
"Code complete, needs an account" means implemented and unit-tested against
mocks, but never run against the real third-party service.

| Area | Feature | Status |
| --- | --- | --- |
| **Admission** | Join by verified phone/email (OTP) or name-only request; identity badges (name entered / contact verified / invited / host approved / phone caller) | Verified here |
| | Expected-attendee list, CSV import, phone contact picker (Android Chrome) | Verified here (picker: needs a real Android device) |
| | Policies: anyone with link / invited only / verified only / host approval; waiting room with custom message; admit all / verified / invitees | Verified here |
| | Lock, remove, block (session + verified contact + phone line), unblock, reverse a rejection, end, reopen recurring meeting | Verified here |
| | Co-hosts (moderate, can't change settings or remove each other) | Verified here |
| **Meeting** | Real audio/video, screen share, chat, reactions, hand raise (server-set) | Verified here (real WebRTC, headless Chrome) |
| | Low-data and audio-only modes; auto-reconnect + rejoin without re-approval | Verified here |
| | Q&A (moderated, anonymous, upvotes), polls (single/multi, anonymous or named, share results) | Verified here (via UI) |
| | Whiteboard (shared, persisted for late joiners) | Verified here (via UI) |
| | Breakout rooms (manual/random assignment, auto-move, broadcast message, host visits rooms) | Verified here (via UI) |
| | Live captions with per-person consent; searchable transcript; .txt/.vtt export | Verified here (speech recognition itself runs in the user's browser; headless test injects recognized text) |
| **Large events** | Presentation mode: speakers + subscribe-only audience, promote to speaker | Verified here |
| | Live HLS streaming via LiveKit Egress with access control, watch page (hls.js / native HLS) | Verified here (real Egress; H.264 720p validated with ffprobe) |
| | Load: 200 WebRTC viewers / 20-person gallery on one 4-CPU box | Measured here, see [docs/LOAD_TEST_RESULTS.md](docs/LOAD_TEST_RESULTS.md) |
| **Recording** | Room recording to MP4 (local disk or S3), consent notice, replay page, downloads, retention | Verified here with local disk; S3 path code complete, needs a bucket |
| **AI** | Meeting notes: summary, decisions, action items (Claude), from consented transcript + host notes + Q&A + polls | Verified against a mock API; needs `ANTHROPIC_API_KEY` |
| **Phone** | Dial-in with meeting PIN; host dials out to a phone | Code complete, needs a LiveKit SIP trunk + phone number |
| **Messaging** | SMS (Twilio) and email (Resend) for OTP and invitations; calendar .ics + Google Calendar links | OTP/invite logic verified in dev mode; providers need accounts |
| **Business** | Plans (Free/Pro/Business/Enterprise) with entitlements, usage metering, monthly fair-use caps that never cut off a running meeting | Verified here |
| | Stripe Checkout, customer portal, signed webhooks (idempotent) | Webhook handling verified with signed test events; checkout needs Stripe keys |
| **Enterprise** | Organizations, members, roles, auto-join email domains, branding, default meeting rules, retention | Verified here |
| | OIDC single sign-on (Okta, Entra ID, Google, Auth0, Keycloak), SSO enforcement | Verified against a mock OIDC provider; needs a real IdP |
| | Signed outgoing webhooks with retries and SSRF protection | Verified here |
| | Personal data export and account deletion | Verified here |
| **Safety & ops** | Safety dashboard (join bursts, OTP abuse, blocked connections), abuse reports, platform admin console | Verified here |
| | Health check, Prometheus metrics, hourly cleanup/retention job, audit trail | Verified here |
| **Apps** | Installable PWA (manifest, icons, offline page) | Built; install prompt depends on browser |
| | Android & iOS app shells (Capacitor) | Generated and configured; **not compiled or device-tested** (needs Android Studio / Xcode) |
| **Deploy** | Production Docker image, docker-compose stack (app, Postgres, Redis, LiveKit, Egress, Caddy HTTPS) | Image builds; full compose stack not run as a whole here |

There is **no meeting duration cutoff**. Plan limits (participants, audience,
monthly participant-minutes, recording, AI, phone) are configurable and are
checked only when someone new connects.

## Quick start (local)

Requirements: Node 20+, PostgreSQL 14+. For audio/video, a LiveKit server
(`livekit-server --dev` or LiveKit Cloud).

```bash
npm install
cp .env.example .env.local     # edit values
createdb meetsphere
DATABASE_URL=postgres://localhost/meetsphere npm run db:migrate
DATABASE_URL=postgres://localhost/meetsphere npm run db:seed    # optional demo data

livekit-server --dev            # then LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret
# No SMS/email provider yet? Show codes on screen (dev only):  VERIFICATION_DEV_MODE=true
npm run dev
```

Open http://localhost:3000 → Host a meeting → sign in → create → open the link
in a private window to join as a guest. Phones on your LAN need HTTPS for
camera/mic (use a tunnel such as `cloudflared`).

Production: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (`deploy/docker-compose.yml`).

## Testing

```bash
createdb meetsphere_test
TEST_DATABASE_URL=postgres://localhost/meetsphere_test npm test     # 66 unit + HTTP-level tests
npm run typecheck && npm run lint && npm run build
```

Browser tests (real WebRTC with fake camera/mic) against a running app with
`VERIFICATION_DEV_MODE=true`, a LiveKit server with its webhook pointed at the
app, and (for recording) an Egress worker:

| Script | Covers |
| --- | --- |
| `tests/e2e/smoke.mjs` | OTP sign-in, waiting room, admit, video both ways, hand raise, lock, remove + token refusal |
| `tests/e2e/features.mjs` | Q&A, polls, captions consent, whiteboard, breakout rooms, broadcast message, recording notice, abuse report — all through the UI, phone + desktop |
| `tests/e2e/recording.mjs` | Real Egress recording to MP4 and live HLS: start/stop, webhooks, downloads, access control, watch page, ffprobe validation |

```bash
BASE_URL=http://127.0.0.1:3000 CHROMIUM_PATH=/path/to/chrome DATABASE_URL=... node tests/e2e/features.mjs
```

## Configuration

Everything is environment variables; see [`.env.example`](.env.example) for
the full list. Only `DATABASE_URL` and `APP_SECRET` are required. Each missing
service turns off its feature with an honest message in the UI.

## Docs

- [Architecture and security model](docs/ARCHITECTURE.md)
- [Deployment (single host, multi-region, providers)](docs/DEPLOYMENT.md)
- [Operations runbook](docs/OPERATIONS.md)
- [Load-test plan](docs/LOAD_TEST_PLAN.md) and [results](docs/LOAD_TEST_RESULTS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Native apps](native/README.md)

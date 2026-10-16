# Deployment

## What you need

| Component | Options | Notes |
| --- | --- | --- |
| Node app | Any Node 20+ host (Fly.io, Render, Railway, a VM, Vercel*) | *On serverless, use a pooled Postgres URL (pgBouncer/Neon pooler) |
| PostgreSQL | Neon, Supabase, RDS, Cloud SQL, self-hosted | Run `npm run db:migrate` on each deploy |
| Media | LiveKit Cloud (fastest) or self-hosted LiveKit | Self-hosting needs UDP ports, TURN/TLS, and someone on call |
| SMS OTP | Twilio Programmable Messaging | Needs a sender number; some countries require registration (e.g. US A2P 10DLC) |
| Email OTP | Resend | Verify your sending domain (SPF/DKIM) |
| HTTPS | Required | Browsers block camera/mic on non-secure origins |

## Steps

1. Create the Postgres database and set `DATABASE_URL`.
2. Generate `APP_SECRET`: `openssl rand -base64 48`. Rotating it invalidates outstanding OTP codes only.
3. Create a LiveKit project; set `LIVEKIT_URL` (wss://…), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
4. In LiveKit, add a webhook to `https://<your-domain>/api/livekit/webhook`
   (signed with the same API key). It enables the "kick anyone not admitted" safety net and room join/leave audit events.
5. Configure Twilio and/or Resend. With neither, nobody can verify; name-only requests still work if the host allows them.
6. Set `APP_BASE_URL=https://<your-domain>` and **do not** set `VERIFICATION_DEV_MODE` (it is ignored in production anyway).
7. `npm ci && npm run db:migrate && npm run build && npm start` (port 3000, or `PORT`).

### Reverse proxy

Rate limits use the first `X-Forwarded-For` address. Put the app behind a
proxy/load balancer that **overwrites** that header with the real client IP;
otherwise clients can spoof it and dodge per-IP limits (per-destination,
per-session and per-host limits still hold).

### Housekeeping

Expired sessions, OTP challenges and old rate-limit windows are small but
grow forever. Run daily (cron, scheduled job):

```sql
DELETE FROM sessions WHERE expires_at < now();
DELETE FROM verification_challenges WHERE expires_at < now() - interval '1 day';
DELETE FROM rate_limits WHERE window_start < now() - interval '2 days';
```

Decide a retention period for `moderation_events` and `join_requests`
(they contain names and verified contacts) and add it to your privacy policy.

## Cost risks (model these before a generous free tier)

These are the line items that scale with usage. Check current provider pricing before launch; the numbers change.

| Driver | Scales with | Mitigation in code today |
| --- | --- | --- |
| Media (SFU participant-minutes, egress bandwidth) | participants × minutes × video bitrate | `FREE_MAX_PARTICIPANTS`, adaptive stream + dynacast, low-data/audio-only modes. **No duration cap**, so long idle meetings cost money until people leave |
| SMS OTP | verifications | Per-destination/IP/session limits, `FREE_OTP_SENDS_PER_HOST_PER_DAY`. SMS pumping fraud to premium numbers is the main risk; restrict Twilio geo-permissions to countries you serve |
| Email OTP | verifications | Same limits; much cheaper than SMS |
| Database | requests (waiting-room polling every 3 s per waiting guest and per host) | Fine for small meetings; move to SSE/WebSockets before large events |
| Recording / transcription / telephony | not built | Gate behind paid plans when added (`plans.ts` has flags) |

The validation budget in the product brief ($500) is enough for a domain,
small hosting, LiveKit Cloud's free/entry tier and limited SMS credits for
a 10–30 person pilot. It is not enough for production large events.

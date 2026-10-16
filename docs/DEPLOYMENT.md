# Deployment

## Option A: single host with Docker Compose

Good for a pilot or a small organization (one region, one LiveKit node).

1. A Linux VM with a public IP (4+ vCPU, 8+ GB RAM; add CPU for recording — each
   Egress job uses roughly 2 vCPU) and two DNS names, e.g. `meet.example.com`
   (app) and `rtc.example.com` (LiveKit).
2. Firewall: TCP 80/443 (Caddy), TCP 7881 and **UDP 50000–60000** (WebRTC). Size the
   UDP range at ≥ 2 ports per concurrent participant.
3. `cp .env.example .env` and set at least: `APP_BASE_URL`, `APP_SECRET`,
   `POSTGRES_PASSWORD`, `APP_DOMAIN`, `LIVEKIT_DOMAIN`, `LIVEKIT_URL=wss://rtc.example.com`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `CRON_SECRET`, `METRICS_TOKEN`.
4. Put the same key/secret and your app domain into `deploy/livekit.yaml` and `deploy/egress.yaml`.
5. Start and migrate:
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
   docker compose -f deploy/docker-compose.yml --env-file .env --profile tools run --rm migrate
   ```
6. Check `https://meet.example.com/api/health`. Sign in, make yourself a
   platform admin (`PLATFORM_ADMIN_EMAILS`), and run a test meeting from two phones on mobile data.

Recordings go to the `recordings` volume unless you configure S3 (recommended for anything beyond a pilot).

## Option B: managed services

- **App:** any container host (Fly.io, Render, Railway, ECS, Cloud Run with
  min instances ≥ 1 and request timeouts ≥ 1 h for SSE). Run `scripts/migrate.ts` as a release step.
- **Database:** Neon, Supabase, RDS, Cloud SQL. The app keeps one extra
  connection per instance for LISTEN; use a *session-mode* pooler (not
  transaction-mode) for that connection, or a direct URL.
- **Media:** LiveKit Cloud (handles regions, scaling, TURN). Enable Egress and
  SIP in the LiveKit Cloud project; point its webhook at `https://<app>/api/livekit/webhook`.
- **Storage:** S3/R2. For HLS at scale, put a CDN in front of the bucket.
- **Cron:** call `POST /api/cron/cleanup` hourly with `Authorization: Bearer $CRON_SECRET`.

## Multi-region and redundancy

- **App:** stateless; run ≥ 2 instances per region behind a load balancer.
  Real-time events flow through Postgres, so instances don't need sticky sessions.
- **Database:** primary in one region with a hot standby (managed HA). Cross-region
  read replicas are not used by the app; latency to the primary only affects API
  calls, not media.
- **Media:** LiveKit multi-node with Redis (self-hosted) or LiveKit Cloud. Rooms
  are placed on one node; with Cloud, participants connect to the nearest edge.
- **Large events:** use HLS live streaming + CDN for the audience; keep the
  interactive SFU room to presenters and speakers.
- **Egress:** run a pool sized for peak concurrent recordings + streams (≈2 vCPU each).
  When none is free, starting a recording fails with a clear error (verified).
- **Backups:** daily Postgres snapshots + PITR; bucket versioning or replication for recordings.

## Provider setup

| Service | Steps |
| --- | --- |
| Twilio SMS | Buy a number, register it where required (US A2P 10DLC, UK sender ID…), **restrict Geo Permissions to countries you serve** (SMS-pumping fraud), set `TWILIO_*`. |
| Resend email | Verify your sending domain (SPF/DKIM), set `RESEND_API_KEY`, `EMAIL_FROM`. |
| LiveKit SIP | Create an inbound trunk for your phone number (Twilio/Telnyx SIP trunk → LiveKit), set `LIVEKIT_SIP_INBOUND_TRUNK_ID` and `DIALIN_NUMBER`; outbound trunk for dial-out → `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`. MeetSphere creates a PIN dispatch rule per meeting. |
| Stripe | Create Pro and Business recurring prices → `STRIPE_PRICE_PRO/BUSINESS`; webhook endpoint `https://<app>/api/billing/webhook` for `checkout.session.completed` and `customer.subscription.*` → `STRIPE_WEBHOOK_SECRET`; enable the customer portal. Set prices shown in the UI with `PRO_PRICE_USD` / `BUSINESS_PRICE_USD`. Enterprise is assigned manually in `/admin`. |
| Claude (AI notes) | `ANTHROPIC_API_KEY`; optional `AI_SUMMARY_MODEL` (default `claude-opus-5-5`). |
| SSO | In the IdP, register an OIDC web app with redirect URI `https://<app>/api/auth/sso/callback`, scopes `openid email profile`. Org owner enters issuer, client ID/secret and email domains under Organization → Single sign-on. |
| S3 | Bucket with private ACL; credentials need Put/Get/List/Delete for both the app and Egress (`S3_*`). |

## Reverse proxy requirements

- Overwrite `X-Forwarded-For` with the real client IP (rate limits rely on it).
- Don't buffer `text/event-stream` responses (`/api/meetings/*/events`); allow ≥ 1 h idle.
- Serve everything over HTTPS (camera/mic require it).

## Costs to model before a generous free tier

| Driver | Scales with | Controls in the product |
| --- | --- | --- |
| Media (SFU minutes, egress bandwidth) | participants × minutes × bitrate | participant caps, monthly participant-minute cap (new joins only), adaptive stream, low-data/audio-only |
| HLS delivery | viewers × minutes × bitrate | CDN pricing; paid plans only |
| Recording/streaming compute + storage | minutes recorded, retention | paid plans, retention settings |
| SMS (OTP, invites) | verifications, invitations | per-destination/IP/session limits, per-host daily caps, geo restrictions |
| Phone minutes | callers × minutes | Business plan only, metered |
| AI summaries | summaries × transcript length | paid plans, monthly cap |
| Support & abuse handling | users | safety dashboard, reports queue |

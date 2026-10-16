# Architecture

## Stack

- **Next.js 15 (App Router) + React 19 + TypeScript**: UI and API route handlers in one deployable.
- **PostgreSQL** with plain SQL migrations (`migrations/`), also the real-time bus (LISTEN/NOTIFY) and rate limiter.
- **LiveKit**: SFU for audio/video/screen/data; **Egress** for recordings (MP4) and live streams (HLS); **SIP** for phone dial-in/out.
- **Twilio** (SMS), **Resend** (email), **Stripe** (billing), **Anthropic Claude** (meeting notes), any **OIDC** IdP (SSO), **S3-compatible** storage — all optional, over HTTPS.

```
                   ┌───────────────── Next.js app (stateless, N instances) ─────────────────┐
Browser / PWA ─────┤ pages · API routes · SSE /events · webhooks (LiveKit, Stripe)          │
Native shell       └──┬─────────────┬──────────────┬───────────────┬────────────────┬──────┘
   │  WebRTC          │ SQL/NOTIFY  │ Server API    │ OTP/invites   │ billing/AI/SSO │
   ▼                  ▼             ▼               ▼               ▼                ▼
LiveKit SFU ◀──── PostgreSQL     LiveKit API     Twilio/Resend   Stripe/Claude/IdP
  │  ▲ webhooks                    │
  │  └─────────────────────────────┤
  ▼                                ▼
Egress (Chrome compositor) ──▶ S3 / shared disk ──▶ HLS viewers (CDN) · replays
SIP gateway ◀──▶ phone network
```

## Code map

| Path | Responsibility |
| --- | --- |
| `src/lib/policy.ts` | Pure admission rules and identity badges |
| `src/lib/admission.ts` | Join requests, moderation actions, **the only path to a media token**, phone-caller admission |
| `src/lib/viewer.ts` | Resolves the acting person in a meeting (host / co-host / participant / none) |
| `src/lib/verification.ts` | OTP start/check, hashing, attempt caps, rate limits, sign-in, SSO enforcement |
| `src/lib/events.ts`, `useMeetingEvents.ts` | Postgres NOTIFY → server-sent events with per-audience filtering |
| `src/lib/meetings.ts`, `presets.ts`, `ics.ts` | Settings, recurrence, reopen, presets, calendar export |
| `src/lib/invitations.ts` | Invite list, CSV, matching, sending by SMS/email |
| `src/lib/qa.ts`, `polls.ts`, `whiteboard.ts`, `breakouts.ts` | In-meeting collaboration |
| `src/lib/transcripts.ts`, `notes.ts` | Consent-gated captions, transcripts, AI notes, full-text search |
| `src/lib/recording.ts`, `storage.ts`, `replay.ts` | Egress recording/HLS, local/S3 storage, replay access |
| `src/lib/telephony.ts` | SIP dial-in rules and dial-out |
| `src/lib/plans.ts`, `usage.ts`, `billing.ts`, `accounting.ts` | Entitlements, metering, Stripe |
| `src/lib/orgs.ts`, `sso.ts`, `secretbox.ts` | Organizations, OIDC SSO, encrypted secrets |
| `src/lib/webhooks.ts`, `webhookEndpoints.ts`, `netguard.ts` | Outgoing webhooks, SSRF guard |
| `src/lib/safety.ts`, `retention.ts`, `admin.ts` | Safety signals, data retention, platform admin |
| `src/components/Room.tsx` + panels | Meeting room UI |

## Admission model

Every browser gets an opaque session cookie (HttpOnly, SameSite=Lax; only its
SHA-256 is stored). A guest verifies a phone/email **on that session**; no account needed.
Join requests are unique per (meeting, session) and decisions stick.

| Policy | Verified invitee | Verified, not invited | Name only |
| --- | --- | --- | --- |
| Anyone with link | admit | admit | admit (badge: name entered) |
| Verified only | admit | admit | wait if allowed, else deny |
| Invited only | admit if auto-admit, else wait | wait if allowed, else deny | wait if allowed, else deny |
| Host approval | wait | wait | wait if allowed, else deny |

Ended → deny. Blocked (session, user, verified contact or phone line) → deny.
Locked → deny new requests; admitted people can reconnect. **A typed name never
counts as identity**: equality with an invitee is a `weak_name_match` warning.

Roles: `host` (meeting owner), `cohost` (appointed by the host: moderation,
not settings; can't remove another co-host), `speaker`/`audience` (presentation
mode), `participant`. Moderator endpoints return 404 to everyone else.

## Media authorization

- `POST /api/meetings/:code/token` is the only way to get a LiveKit token: the
  host, or an admitted join request bound to the caller's session (blocks re-checked).
  It also selects the room: main room, the assigned breakout room, or (moderators) any breakout.
- Grants are exact: `roomAdmin` for host/co-host only; publish rights from role
  and mode; screen-share and data permissions from settings; participants can't
  edit their own name/metadata, so identity badges can't be spoofed.
- Settings and role changes are pushed live with `updateParticipant`.
- Remove/block calls `removeParticipant` with `revokeTokenTs` so earlier tokens
  can't reconnect, in every room the person is in.
- The LiveKit webhook kicks anyone in a room who isn't currently admitted
  (defense in depth), tracks presence per room for usage and health, admits
  PIN-verified phone callers, and applies Egress status changes.
- Fair-use: if a host is over the monthly participant-minute cap, **new**
  meetings can't start; meetings with people already connected continue.

## Real-time events

Mutations publish small events (`pg_notify`) with an audience: `all`,
`moderators`, or one join request. Each app instance holds one LISTEN
connection and relays to its SSE clients after filtering per viewer; waiting
guests only see events about their own request. Clients refetch details,
so events never carry private data beyond the audience's view. Slow polling is
kept as a fallback where proxies block SSE.

## Privacy and consent

- **Captions/transcripts:** opt-in per person when the host turns them on;
  speech is recognized on the speaker's own device and only while their mic is
  on; the server rejects segments from anyone without consent.
- **Recording:** everyone sees a persistent indicator and must acknowledge a
  notice (or leave); acknowledgements are stored.
- **AI notes:** built only from consented transcript lines, host notes, Q&A
  and poll results; plan-gated and opt-in per meeting.
- **Replays:** host-only by default; optionally attendees or anyone with the link.
- **Retention:** per meeting or per organization; the hourly job deletes
  recordings and scrubs names/contacts/transcripts after the window.
- Invitee contacts are host-only; waiting-room contacts are masked.

## Security controls

- OTP: 6 digits, HMAC-SHA256 with `APP_SECRET`, 10-minute expiry, 5 attempts
  (counted before comparison), bound to the requesting session; send limits per
  destination/IP/session plus a per-host daily cap; no enumeration.
- CSRF: cross-site `Origin`/`Sec-Fetch-Site` rejected on mutations, JSON-only bodies.
- SSRF: user-supplied URLs (webhooks, OIDC issuers) are resolved and refused if
  they point at private, loopback or link-local addresses; no redirects.
- SSO: authorization code + PKCE, state bound to the browser session and
  single-use, ID token verified against the IdP's JWKS (issuer, audience, nonce),
  client secrets encrypted at rest (AES-256-GCM).
- Webhooks out: HMAC-SHA256 signatures with timestamps; Stripe webhooks in:
  signature + 5-minute replay window + idempotency table.
- Storage paths are server-generated and checked against traversal; downloads
  are authorized per request; S3 access is via short-lived presigned URLs.
- Security headers: HSTS, nosniff, frame-deny, strict referrer, permissions policy.

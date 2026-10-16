# Architecture

## Stack

- **Next.js 15 (App Router) + React 19 + TypeScript**: UI and API route handlers in one deployable.
- **PostgreSQL** via `pg` with plain SQL migrations (`migrations/*.sql`, `scripts/migrate.ts`).
- **LiveKit** (SFU) for audio/video/screen share/data. The browser uses
  `livekit-client` + `@livekit/components-react`; the server uses
  `livekit-server-sdk` to mint tokens and moderate rooms.
- **Twilio** (SMS) and **Resend** (email) over plain HTTPS for OTP delivery.

```
Browser ──HTTPS──▶ Next.js API ──▶ PostgreSQL
   │                    │
   │                    ├──▶ Twilio / Resend (OTP)
   │                    └──▶ LiveKit RoomService (kick, mute, permissions)
   └──WebRTC──▶ LiveKit SFU ──webhook──▶ /api/livekit/webhook
```

## Code map

| Path | Responsibility |
| --- | --- |
| `src/lib/policy.ts` | Pure admission rules (`evaluateAdmission`) and identity badges |
| `src/lib/admission.ts` | Join requests, host decisions, blocks, **the only path to a media token** |
| `src/lib/verification.ts` | OTP start/check, hashing, attempt caps, rate limits, sign-in |
| `src/lib/invitations.ts` | Expected-attendee list, CSV parsing, invite matching |
| `src/lib/meetings.ts` | Meeting CRUD, settings, lock/end, public vs host views |
| `src/lib/media.ts` | LiveKit tokens, grants, room moderation, webhook receiver |
| `src/lib/http.ts` | Route wrapper: sessions, CSRF origin check, JSON validation, error mapping |
| `src/lib/plans.ts` | Configurable plan limits (no duration limit) |
| `src/app/api/**` | Thin route handlers over the services above |
| `src/app/m/[code]` | Join flow → waiting room → device check → room |
| `src/components/Room.tsx`, `HostPanel.tsx` | Meeting room and live host controls |

## Admission model

Every browser gets an opaque session cookie (HttpOnly, SameSite=Lax; only the
SHA-256 of the token is stored). A guest verifies a phone or email **on that
session**; there is no account needed to join.

A join request is unique per `(meeting, session)`. Once decided, the decision
sticks: a rejected, removed or blocked session gets the same answer back
instead of a new request.

`evaluateAdmission` (pure function, fully unit tested) decides:

| Policy | Verified invitee | Verified, not invited | Name only |
| --- | --- | --- | --- |
| Anyone with link | admit | admit | admit (badge: name entered) |
| Verified only | admit | admit | wait if name requests allowed, else deny |
| Invited only | admit if auto-admit on, else wait | wait if manual review allowed, else deny | wait if allowed, else deny |
| Host approval | wait | wait | wait if allowed, else deny |

Ended → deny. Blocked (by session, user, or verified contact) → deny. Locked → deny new requests; already-admitted people can still reconnect.

**A typed name never counts as identity.** Name equality with an invitee is
stored as `weak_name_match`, shown to the host as a warning, and never admits.
Claiming the phone/email method without a verified contact on the session is denied.

### Identity states

`name_entered` (unverified) → `contact_verified` → `invited` (verified contact matches the list) → `host_approved` (host decided).
Badges are embedded in the LiveKit token metadata by the server, and participants
cannot update their own metadata/attributes, so they can't fake a badge.

## Media authorization

- `POST /api/meetings/:code/token` is the only way to get a LiveKit token. It
  requires the host's signed-in session, or an **admitted** join request bound
  to the caller's session, and re-checks blocks.
- Tokens are short-lived for connect (10 min) and carry exact grants:
  `roomAdmin` only for the host; `canPublish=false` for presentation audience;
  `canPublishSources` excludes screen share when disabled; `canPublishData=false`
  when chat is disabled.
- Remove/block calls LiveKit `removeParticipant` with `revokeTokenTs`, so
  previously issued tokens can't reconnect.
- The LiveKit webhook (`participant_joined`) kicks anyone in the room whose
  join request isn't currently admitted: defense in depth if a token leaks or
  races a removal.
- Settings changes (screen share / chat) are pushed to connected participants
  with `updateParticipant` permissions.

## Verification security

- 6-digit codes, stored only as `HMAC-SHA256(APP_SECRET, challengeId:code)`.
- Expire after 10 minutes; max 5 attempts, counted atomically before comparison.
- Challenges are bound to the requesting session (a stolen challenge id is useless elsewhere).
- Rate limits (Postgres-backed, multi-instance safe): 1 send per destination per 30 s,
  5 per destination per hour, 20 per IP per hour, 10 per session per hour,
  plus a per-host daily cap billed to the meeting's host.
- Responses never reveal whether a contact is invited or registered (no enumeration).
- Dev mode only when `VERIFICATION_DEV_MODE=true`, a provider is missing, **and**
  `NODE_ENV !== production`. The UI labels it "DEV MODE - no message sent".

## Other protections

- CSRF: mutations reject a cross-site `Origin` / `Sec-Fetch-Site`, require
  `application/json`, and cookies are SameSite=Lax.
- Host endpoints return 404 to non-hosts (no existence leak); everything is
  checked server-side, not just hidden in the UI.
- Invitee phone numbers/emails are only returned by host-only endpoints; the
  host's waiting room shows masked contacts.
- Join-burst limits per IP and per meeting; token minting limited per session.
- Security headers (nosniff, frame deny, referrer policy, permissions policy).

## Data model

`users`, `sessions`, `verification_challenges`, `rate_limits`, `meetings`,
`invitations`, `join_requests`, `meeting_roles`, `meeting_blocks`,
`moderation_events` (audit trail), `meeting_artifacts` (reserved; nothing
writes to it yet), `usage_events` (metered OTP sends). See `migrations/001_init.sql`
for constraints and indexes.

## Interactive vs presentation rooms

Both currently run on the LiveKit SFU. Presentation mode makes the audience
subscribe-only and lets the host promote a participant to speaker (the
audience-to-speaker handoff) without exposing every audience camera. This is
**not** the scalable viewer path: thousands of viewers need an egress →
HLS/CDN or a LiveKit multi-node deployment, with load testing first (see
`LOAD_TEST_PLAN.md`). Capacity is capped by `FREE_MAX_PARTICIPANTS` via the
room's `maxParticipants`.

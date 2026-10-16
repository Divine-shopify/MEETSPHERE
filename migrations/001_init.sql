-- MeetSphere initial schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name       text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  phone_e164         text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email              text CHECK (email = lower(email)),
  phone_verified_at  timestamptz,
  email_verified_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX users_phone_uniq ON users (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX users_email_uniq ON users (email) WHERE email IS NOT NULL;

-- Browser sessions. Guests get a session too; a session can carry a verified
-- phone/email without ever becoming a user account.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         bytea NOT NULL UNIQUE,
  user_id            uuid REFERENCES users(id) ON DELETE CASCADE,
  verified_phone     text,
  phone_verified_at  timestamptz,
  verified_email     text,
  email_verified_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- OTP challenges. Codes are stored only as HMAC digests.
CREATE TABLE verification_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('phone', 'email')),
  destination   text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('signin', 'join')),
  code_hash     bytea NOT NULL,
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  delivery      text NOT NULL CHECK (delivery IN ('provider', 'dev')),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_challenges_session_idx ON verification_challenges (session_id, created_at DESC);

CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE meetings (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                          text NOT NULL UNIQUE CHECK (code ~ '^[a-z]{3}-[a-z]{4}-[a-z]{3}$'),
  host_user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  mode                          text NOT NULL DEFAULT 'interactive' CHECK (mode IN ('interactive', 'broadcast')),
  scheduled_at                  timestamptz,
  status                        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
  access_policy                 text NOT NULL DEFAULT 'host_approval'
                                CHECK (access_policy IN ('anyone_with_link', 'invited_only', 'verified_only', 'host_approval')),
  allow_name_only_requests      boolean NOT NULL DEFAULT true,
  auto_admit_verified_invitees  boolean NOT NULL DEFAULT true,
  allow_screen_share            boolean NOT NULL DEFAULT true,
  chat_enabled                  boolean NOT NULL DEFAULT true,
  locked_at                     timestamptz,
  ended_at                      timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_host_idx ON meetings (host_user_id, created_at DESC);

CREATE TABLE invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  expected_name     text NOT NULL CHECK (char_length(expected_name) BETWEEN 1 AND 80),
  normalized_phone  text CHECK (normalized_phone ~ '^\+[1-9][0-9]{6,14}$'),
  normalized_email  text CHECK (normalized_email = lower(normalized_email)),
  invite_status     text NOT NULL DEFAULT 'pending' CHECK (invite_status IN ('pending', 'matched', 'revoked')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_meeting_idx ON invitations (meeting_id);
CREATE UNIQUE INDEX invitations_phone_uniq ON invitations (meeting_id, normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE UNIQUE INDEX invitations_email_uniq ON invitations (meeting_id, normalized_email) WHERE normalized_email IS NOT NULL;

CREATE TABLE join_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id          uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id          uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_name      text NOT NULL CHECK (char_length(submitted_name) BETWEEN 1 AND 80),
  identity_method     text NOT NULL CHECK (identity_method IN ('phone', 'email', 'name')),
  verified_contact    text,
  verification_state  text NOT NULL CHECK (verification_state IN ('unverified', 'verified')),
  match_state         text NOT NULL CHECK (match_state IN ('none', 'weak_name_match', 'verified_contact_match')),
  invitation_id       uuid REFERENCES invitations(id) ON DELETE SET NULL,
  status              text NOT NULL CHECK (status IN ('pending', 'admitted', 'rejected', 'removed', 'blocked')),
  decided_by          text CHECK (decided_by IN ('policy', 'host')),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  -- One request per browser session per meeting: a rejected session cannot
  -- simply re-request.
  UNIQUE (meeting_id, session_id),
  CHECK (identity_method = 'name' OR verification_state = 'verified'),
  CHECK (verification_state = 'unverified' OR verified_contact IS NOT NULL)
);
CREATE INDEX join_requests_meeting_status_idx ON join_requests (meeting_id, status, requested_at);

CREATE TABLE meeting_roles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE,
  guest_session_id  uuid REFERENCES sessions(id) ON DELETE CASCADE,
  role              text NOT NULL CHECK (role IN ('host', 'cohost', 'speaker', 'participant', 'audience')),
  granted_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (guest_session_id IS NULL))
);
CREATE UNIQUE INDEX meeting_roles_user_uniq ON meeting_roles (meeting_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX meeting_roles_guest_uniq ON meeting_roles (meeting_id, guest_session_id) WHERE guest_session_id IS NOT NULL;

-- Blocks survive a new browser session when the blocked person had verified a
-- contact or signed in.
CREATE TABLE meeting_blocks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  session_id        uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE,
  verified_contact  text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_blocks_meeting_idx ON meeting_blocks (meeting_id);

CREATE TABLE moderation_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id        uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  target_id         uuid,
  action            text NOT NULL,
  reason            text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_events_meeting_idx ON moderation_events (meeting_id, created_at DESC);

CREATE TABLE meeting_artifacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('recording', 'transcript', 'notes', 'export')),
  storage_key      text,
  text_ref         text,
  consent_state    text NOT NULL DEFAULT 'not_requested'
                   CHECK (consent_state IN ('not_requested', 'requested', 'granted', 'denied')),
  retention_until  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_artifacts_meeting_idx ON meeting_artifacts (meeting_id);

-- Metered usage for plan limits (OTP sends now; recording/AI/telephony later).
CREATE TABLE usage_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  meeting_id    uuid REFERENCES meetings(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('otp_sms', 'otp_email')),
  quantity      int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_host_idx ON usage_events (host_user_id, kind, created_at);

-- Phase 2 and 3: engagement, collaboration, recording/broadcast, telephony,
-- billing, organizations/SSO, integrations, safety and retention.

-- ---------- Organizations ----------
CREATE TABLE organizations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug                     text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  branding                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_meeting_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_email_domains    text[] NOT NULL DEFAULT '{}',
  retention_days           int CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
  sso_enforced             boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id);

-- Pending membership for people who haven't signed in yet (claimed on sign-in by verified email).
CREATE TABLE org_member_invites (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       text NOT NULL CHECK (email = lower(email)),
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, email)
);

CREATE TABLE sso_configs (
  org_id                uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  issuer                text NOT NULL,
  client_id             text NOT NULL,
  client_secret_enc     text NOT NULL,
  email_domains         text[] NOT NULL DEFAULT '{}',
  enabled               boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sso_states (
  state          text PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code_verifier  text NOT NULL,
  nonce          text NOT NULL,
  next_path      text NOT NULL DEFAULT '/dashboard',
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN sso_subject text;
CREATE UNIQUE INDEX users_sso_subject_uniq ON users (sso_subject) WHERE sso_subject IS NOT NULL;

-- ---------- Billing ----------
CREATE TABLE billing_accounts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  org_id                  uuid UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id                 text NOT NULL DEFAULT 'free' CHECK (plan_id IN ('free', 'pro', 'business', 'enterprise')),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete')),
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  current_period_end      timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (org_id IS NULL))
);

CREATE TABLE stripe_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Meetings: new settings and state ----------
ALTER TABLE meetings
  ADD COLUMN org_id                uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN preset_id             uuid,
  ADD COLUMN recurrence            text NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly')),
  ADD COLUMN duration_minutes      int NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 5 AND 1440),
  ADD COLUMN waiting_message       text CHECK (char_length(waiting_message) <= 500),
  ADD COLUMN qa_enabled            boolean NOT NULL DEFAULT true,
  ADD COLUMN qa_moderated          boolean NOT NULL DEFAULT false,
  ADD COLUMN qa_anonymous_allowed  boolean NOT NULL DEFAULT true,
  ADD COLUMN polls_enabled         boolean NOT NULL DEFAULT true,
  ADD COLUMN whiteboard_enabled    boolean NOT NULL DEFAULT true,
  ADD COLUMN captions_enabled      boolean NOT NULL DEFAULT true,
  ADD COLUMN transcription_state   text NOT NULL DEFAULT 'off' CHECK (transcription_state IN ('off', 'active')),
  ADD COLUMN recording_state       text NOT NULL DEFAULT 'off' CHECK (recording_state IN ('off', 'starting', 'active', 'stopping')),
  ADD COLUMN recording_egress_id   text,
  ADD COLUMN stream_state          text NOT NULL DEFAULT 'off' CHECK (stream_state IN ('off', 'starting', 'active', 'stopping')),
  ADD COLUMN stream_egress_id      text,
  ADD COLUMN stream_artifact_id    uuid,
  ADD COLUMN replay_visibility     text NOT NULL DEFAULT 'host' CHECK (replay_visibility IN ('host', 'attendees', 'link')),
  ADD COLUMN dialin_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN dialin_pin            text UNIQUE CHECK (dialin_pin ~ '^[0-9]{6,10}$'),
  ADD COLUMN dialin_rule_id        text,
  ADD COLUMN breakouts_open        boolean NOT NULL DEFAULT false,
  ADD COLUMN retention_days        int CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650);
CREATE INDEX meetings_org_idx ON meetings (org_id);
CREATE INDEX meetings_scheduled_idx ON meetings (scheduled_at) WHERE scheduled_at IS NOT NULL;

-- Phone (SIP) callers have no browser session.
ALTER TABLE join_requests ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE join_requests ADD COLUMN sip_identity text;
ALTER TABLE join_requests DROP CONSTRAINT join_requests_identity_method_check;
ALTER TABLE join_requests ADD CONSTRAINT join_requests_identity_method_check CHECK (identity_method IN ('phone', 'email', 'name', 'sso', 'dialin'));
ALTER TABLE join_requests ADD CONSTRAINT join_requests_session_or_sip CHECK (session_id IS NOT NULL OR sip_identity IS NOT NULL);
CREATE UNIQUE INDEX join_requests_sip_uniq ON join_requests (meeting_id, sip_identity) WHERE sip_identity IS NOT NULL;
ALTER TABLE meeting_blocks ADD COLUMN sip_identity text;

-- Invitations can be sent by SMS/email.
ALTER TABLE invitations ADD COLUMN last_sent_at timestamptz, ADD COLUMN send_count int NOT NULL DEFAULT 0;

-- ---------- Presets ----------
CREATE TABLE access_presets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  settings       jsonb NOT NULL,
  invitations    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_presets_owner_idx ON access_presets (owner_user_id);
CREATE INDEX access_presets_org_idx ON access_presets (org_id);

-- ---------- Q&A ----------
CREATE TABLE questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  author_key    text NOT NULL,
  author_name   text NOT NULL,
  anonymous     boolean NOT NULL DEFAULT false,
  body          text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  status        text NOT NULL CHECK (status IN ('pending', 'visible', 'answered', 'dismissed')),
  pinned        boolean NOT NULL DEFAULT false,
  votes         int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  answered_at   timestamptz
);
CREATE INDEX questions_meeting_idx ON questions (meeting_id, status, votes DESC);
CREATE TABLE question_votes (
  question_id  uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  voter_key    text NOT NULL,
  PRIMARY KEY (question_id, voter_key)
);

-- ---------- Polls ----------
CREATE TABLE polls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  created_by_key   text NOT NULL,
  question         text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  options          jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 10),
  allow_multiple   boolean NOT NULL DEFAULT false,
  anonymous        boolean NOT NULL DEFAULT true,
  results_visible  boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  opened_at        timestamptz,
  closed_at        timestamptz
);
CREATE INDEX polls_meeting_idx ON polls (meeting_id, created_at);
CREATE TABLE poll_votes (
  poll_id         uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_key       text NOT NULL,
  voter_name      text,
  option_indexes  int[] NOT NULL CHECK (cardinality(option_indexes) >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, voter_key)
);

-- ---------- Breakout rooms ----------
CREATE TABLE breakout_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX breakout_rooms_meeting_idx ON breakout_rooms (meeting_id);
CREATE TABLE breakout_assignments (
  meeting_id       uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  join_request_id  uuid NOT NULL REFERENCES join_requests(id) ON DELETE CASCADE,
  breakout_id      uuid NOT NULL REFERENCES breakout_rooms(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, join_request_id)
);

-- ---------- Whiteboard ----------
CREATE TABLE whiteboard_strokes (
  id          bigserial PRIMARY KEY,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  board       text NOT NULL DEFAULT 'main',
  author_key  text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whiteboard_strokes_meeting_idx ON whiteboard_strokes (meeting_id, board, id);

-- ---------- Consent, transcripts and notes ----------
CREATE TABLE consents (
  meeting_id   uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  subject_key  text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('transcription', 'recording')),
  granted      boolean NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, subject_key, kind)
);

CREATE TABLE transcript_segments (
  id            bigserial PRIMARY KEY,
  meeting_id    uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_key   text NOT NULL,
  speaker_name  text NOT NULL,
  text          text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  source        text NOT NULL DEFAULT 'browser' CHECK (source IN ('browser', 'provider')),
  spoken_at     timestamptz NOT NULL DEFAULT now(),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
);
CREATE INDEX transcript_segments_meeting_idx ON transcript_segments (meeting_id, spoken_at);
CREATE INDEX transcript_segments_tsv_idx ON transcript_segments USING gin (tsv);

CREATE TABLE meeting_notes (
  meeting_id    uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  host_notes    text NOT NULL DEFAULT '',
  summary       text,
  decisions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_items  jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_model      text,
  generated_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple', coalesce(host_notes, '') || ' ' || coalesce(summary, '') || ' ' || decisions::text || ' ' || action_items::text)
                ) STORED
);
CREATE INDEX meeting_notes_tsv_idx ON meeting_notes USING gin (tsv);

-- ---------- Artifacts (recordings, streams) ----------
ALTER TABLE meeting_artifacts
  ADD COLUMN status       text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'deleted')),
  ADD COLUMN egress_id    text UNIQUE,
  ADD COLUMN storage      text CHECK (storage IN ('local', 's3')),
  ADD COLUMN size_bytes   bigint,
  ADD COLUMN duration_ms  bigint,
  ADD COLUMN error        text,
  ADD COLUMN ended_at     timestamptz;
ALTER TABLE meeting_artifacts DROP CONSTRAINT meeting_artifacts_type_check;
ALTER TABLE meeting_artifacts ADD CONSTRAINT meeting_artifacts_type_check CHECK (type IN ('recording', 'stream', 'transcript', 'notes', 'export'));

-- ---------- Media sessions (usage + health) ----------
CREATE TABLE participant_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  room        text NOT NULL,
  identity    text NOT NULL,
  kind        text NOT NULL DEFAULT 'standard',
  joined_at   timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz
);
CREATE INDEX participant_sessions_open_idx ON participant_sessions (meeting_id, identity) WHERE left_at IS NULL;
CREATE INDEX participant_sessions_meeting_idx ON participant_sessions (meeting_id, joined_at);

ALTER TABLE usage_events DROP CONSTRAINT usage_events_kind_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_kind_check CHECK (kind IN (
  'otp_sms', 'otp_email', 'invite_sms', 'invite_email', 'participant_minutes', 'recording_minutes',
  'stream_minutes', 'transcription_minutes', 'ai_summary', 'dialin_minutes'));
ALTER TABLE usage_events ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX usage_events_org_idx ON usage_events (org_id, kind, created_at);

-- ---------- Integrations: outgoing webhooks ----------
CREATE TABLE webhook_endpoints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,
  url            text NOT NULL CHECK (url ~ '^https?://'),
  secret         text NOT NULL,
  events         text[] NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_user_id IS NULL) <> (org_id IS NULL))
);
CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event            text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- ---------- Safety ----------
CREATE TABLE abuse_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id         uuid REFERENCES meetings(id) ON DELETE SET NULL,
  reporter_key       text NOT NULL,
  target_request_id  uuid REFERENCES join_requests(id) ON DELETE SET NULL,
  reason             text NOT NULL CHECK (reason IN ('harassment', 'spam', 'inappropriate_content', 'impersonation', 'other')),
  details            text CHECK (char_length(details) <= 2000),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'actioned')),
  reviewed_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX abuse_reports_status_idx ON abuse_reports (status, created_at DESC);

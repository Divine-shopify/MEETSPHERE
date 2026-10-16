-- Phone callers are identified only by (spoofable) caller ID, so they are
-- "unverified" like name-only guests.
ALTER TABLE join_requests DROP CONSTRAINT join_requests_check;
ALTER TABLE join_requests ADD CONSTRAINT join_requests_verification_check
  CHECK (identity_method IN ('name', 'dialin') OR verification_state = 'verified');

-- Security events only. Never store request bodies, cookies, tokens, IP or raw UA.
CREATE TABLE access_logs (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event IN ('login_started','login_succeeded','login_failed','logout','admin_login_succeeded','admin_login_failed','admin_password_changed')),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')),
  reason TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK(provider IN ('google','admin')),
  browser TEXT,
  os TEXT,
  device_type TEXT,
  country TEXT
);
CREATE INDEX access_logs_time ON access_logs(occurred_at DESC, id DESC);
CREATE INDEX access_logs_event_time ON access_logs(event, occurred_at DESC, id DESC);
CREATE TABLE access_log_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  collection_started_at TEXT NOT NULL
);
INSERT INTO access_log_settings VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- At most one failed verifier event per real handoff; anonymous junk cannot fill the log.
ALTER TABLE auth_login_codes ADD COLUMN failure_logged_at TEXT;

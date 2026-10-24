ALTER TABLE auth_transactions ADD COLUMN browser_code_challenge TEXT;

CREATE TABLE auth_login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_auth_login_codes_expiry ON auth_login_codes(expires_at);


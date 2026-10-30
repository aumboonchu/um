-- Roles are provisioned separately for an explicitly selected existing Google user.
-- No first-visitor bootstrap, plaintext password, or public role assignment endpoint.
CREATE TABLE admin_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations = 100000),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  credential_revision INTEGER NOT NULL DEFAULT 1,
  login_window_start INTEGER NOT NULL DEFAULT 0,
  login_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_accounts(user_id) ON DELETE CASCADE,
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  credential_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_admin_sessions_owner ON admin_sessions(user_id, expires_at);
ALTER TABLE products ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN catalog_operation_id TEXT;
CREATE TABLE admin_catalog_mutations (
  user_id TEXT NOT NULL REFERENCES admin_accounts(user_id),
  operation_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  payload_hash TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  primary_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  issuer TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, issuer, provider_subject)
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  upc TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  package_size TEXT,
  unit TEXT,
  category TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE product_source_snapshots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_product_id TEXT,
  source_url TEXT,
  source_price_minor INTEGER,
  regular_price_minor INTEGER,
  availability TEXT,
  promotion_ends_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE product_overrides (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  field_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, user_id, field_name)
);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, name)
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor > 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  total_minor INTEGER NOT NULL CHECK (total_minor > 0),
  purchased_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sync_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE sync_operations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'conflict', 'validation_error', 'retryable_error')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX idx_auth_sessions_token_expiry ON auth_sessions(token_hash, expires_at);
CREATE INDEX idx_user_identities_user ON user_identities(user_id);
CREATE INDEX idx_product_source_snapshots_product_fetched ON product_source_snapshots(product_id, fetched_at);
CREATE INDEX idx_product_overrides_user_product ON product_overrides(user_id, product_id);
CREATE INDEX idx_stores_user_name ON stores(user_id, name);
CREATE INDEX idx_purchases_user_purchased_at ON purchases(user_id, purchased_at);
CREATE INDEX idx_purchases_product_purchased_at ON purchases(product_id, purchased_at);
CREATE INDEX idx_purchases_store_purchased_at ON purchases(store_id, purchased_at);
CREATE INDEX idx_sync_batches_user_created ON sync_batches(user_id, created_at);
CREATE INDEX idx_sync_operations_batch_status ON sync_operations(batch_id, status);


-- Account-specific display details. Never rewrite the shared SKU/GTIN or paid receipts.
CREATE TABLE product_profiles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brand TEXT,
  package_size TEXT,
  unit TEXT,
  category TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  last_operation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE product_profile_mutations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);

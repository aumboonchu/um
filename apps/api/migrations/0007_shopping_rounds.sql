-- Existing purchases remain unassigned. Never infer historical receipt boundaries.
CREATE TABLE shopping_rounds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  checked_out_at TEXT NOT NULL,
  store_name TEXT,
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'card', 'transfer', 'other')),
  note TEXT,
  total_minor INTEGER NOT NULL CHECK(total_minor > 0),
  line_count INTEGER NOT NULL CHECK(line_count BETWEEN 1 AND 100),
  created_at TEXT NOT NULL
);
ALTER TABLE purchases ADD COLUMN shopping_round_id TEXT REFERENCES shopping_rounds(id) ON DELETE RESTRICT;
CREATE INDEX idx_rounds_user_date ON shopping_rounds(user_id, checked_out_at, id);
CREATE INDEX idx_purchases_round ON purchases(shopping_round_id);
-- Immutable checkout snapshot; later catalog edits must not rewrite a receipt.
CREATE TABLE shopping_round_lines (
  round_id TEXT NOT NULL REFERENCES shopping_rounds(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  product_upc TEXT,
  package_size TEXT,
  unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor > 0),
  quantity REAL NOT NULL CHECK(quantity > 0),
  total_minor INTEGER NOT NULL CHECK(total_minor > 0),
  note TEXT,
  PRIMARY KEY(round_id, position)
);

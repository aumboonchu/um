ALTER TABLE purchases ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE purchases ADD COLUMN deleted_at TEXT;
ALTER TABLE purchases ADD COLUMN last_mutation_id TEXT;

CREATE TABLE purchase_mutations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
  payload_hash TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX idx_purchases_user_active_date ON purchases(user_id, deleted_at, purchased_at);

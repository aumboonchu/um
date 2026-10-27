-- An immutable, account-scoped receipt makes confirming/retrying a UUID idempotent.
-- These tables add metadata only; existing products and purchase references stay intact.
CREATE TABLE product_image_imports (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  retailer_code TEXT,
  image_sha256 TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX idx_product_image_imports_product ON product_image_imports(product_id);

-- Separate from receipts so multiple UUIDs can safely refer to one confirmed image.
-- Differently confirmed fields produce a different payload hash; nothing is overwritten.
CREATE TABLE product_image_fingerprints (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_sha256 TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, image_sha256, payload_hash)
);
CREATE INDEX idx_product_image_fingerprints_product ON product_image_fingerprints(product_id);

-- Reserved for extraction quotas: scopes are user:<id>:<date> / global:<date>.
-- No image bytes, credentials, OCR text, or vision prompts are stored here.
CREATE TABLE image_extraction_usage (
  scope TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  updated_at TEXT NOT NULL
);

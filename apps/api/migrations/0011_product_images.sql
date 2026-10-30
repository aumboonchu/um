-- Store only the explicitly confirmed, canvas-reencoded product crop.
-- Original shopping screenshots are never persisted here.
CREATE TABLE product_images (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  jpeg BLOB NOT NULL CHECK (length(jpeg) > 0 AND length(jpeg) <= 131072),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  width INTEGER NOT NULL CHECK (width BETWEEN 16 AND 640),
  height INTEGER NOT NULL CHECK (height BETWEEN 16 AND 640),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

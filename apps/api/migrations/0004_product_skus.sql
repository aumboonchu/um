-- Keep product IDs and all referencing rows intact: no parent table rebuild/drop.
-- Legacy products retain their old barcode as their SKU and as their UPC.
ALTER TABLE products RENAME COLUMN upc TO sku;
ALTER TABLE products ADD COLUMN upc TEXT;
UPDATE products SET upc = sku;
CREATE UNIQUE INDEX idx_products_upc ON products(upc);

-- Source identity is distinct from snapshots (which may record price history).
CREATE TABLE product_source_links (
  source TEXT NOT NULL,
  source_product_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  PRIMARY KEY (source, source_product_id)
);
CREATE INDEX idx_product_source_links_product ON product_source_links(product_id);

-- Reuse any existing verified source identity without rewriting historical rows.
INSERT OR IGNORE INTO product_source_links (source, source_product_id, product_id, source_url)
SELECT source, source_product_id, product_id, source_url
FROM product_source_snapshots
WHERE source = 'bigc' AND source_product_id IS NOT NULL AND source_url IS NOT NULL
ORDER BY fetched_at ASC, id ASC;


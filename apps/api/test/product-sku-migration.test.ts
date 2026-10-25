import { applyD1Migrations, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('product SKU migration compatibility', () => {
  it('preserves legacy UPCs, source snapshots, and purchase references without rebuilding tables', async () => {
    const legacyMigrations = env.TEST_MIGRATIONS.filter((migration) => migration.name < '0004')
    await applyD1Migrations(env.DB, legacyMigrations)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id) VALUES ('legacy-user')"),
      env.DB.prepare("INSERT INTO products (id, upc, name) VALUES ('legacy-product', '8851959129012', 'Legacy product')"),
      env.DB.prepare("INSERT INTO product_source_snapshots (id, product_id, source, source_product_id) VALUES ('legacy-source', 'legacy-product', 'bigc', '123456')"),
      env.DB.prepare("INSERT INTO purchases (id, user_id, product_id, unit_price_minor, quantity, total_minor, purchased_at) VALUES ('legacy-purchase', 'legacy-user', 'legacy-product', 1250, 1, 1250, '2026-10-24T00:00:00.000Z')"),
    ])
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    expect(await env.DB.prepare("SELECT sku, upc, name FROM products WHERE id = 'legacy-product'").first()).toEqual({
      sku: '8851959129012', upc: '8851959129012', name: 'Legacy product',
    })
    expect(await env.DB.prepare("SELECT product_id FROM purchases WHERE id = 'legacy-purchase'").first('product_id')).toBe('legacy-product')
    expect(await env.DB.prepare("SELECT product_id FROM product_source_snapshots WHERE id = 'legacy-source'").first('product_id')).toBe('legacy-product')
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])

    await env.DB.prepare("INSERT INTO products (id, sku, upc, name) VALUES ('sku-only-a', 'BIGC-234567', NULL, 'SKU-only A')").run()
    await env.DB.prepare("INSERT INTO products (id, sku, upc, name) VALUES ('sku-only-b', 'BIGC-345678', NULL, 'SKU-only B')").run()
    await expect(env.DB.prepare("INSERT INTO products (id, sku, upc, name) VALUES ('duplicate-upc', 'BIGC-456789', '8851959129012', 'Duplicate')").run()).rejects.toThrow()
  })
})


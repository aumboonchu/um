import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseBigCProductDocument } from '../src/products'

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      upc TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      brand TEXT,
      package_size TEXT,
      unit TEXT,
      category TEXT,
      image_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS product_source_snapshots (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_product_id TEXT,
      source_url TEXT,
      source_price_minor INTEGER,
      regular_price_minor INTEGER,
      availability TEXT,
      promotion_ends_at TEXT,
      fetched_at TEXT NOT NULL
    )`),
    env.DB.prepare('DELETE FROM product_source_snapshots'),
    env.DB.prepare('DELETE FROM products'),
  ])
})

describe('Big C product parsing', () => {
  it('accepts only an exact UPC from structured data', () => {
    const result = parseBigCProductDocument(
      `<script type="application/ld+json">{
        "@type":"Product",
        "name":"น้ำดื่มตัวอย่าง 600 มล.",
        "gtin13":"8851959129012",
        "brand":{"name":"Smart Brand"},
        "image":"https://www.bigc.co.th/example.jpg",
        "offers":{"price":"12.50","highPrice":"15.00"}
      }</script>`,
      '8851959129012',
      'https://www.bigc.co.th/search?q=8851959129012',
    )

    expect(result).toMatchObject({
      name: 'น้ำดื่มตัวอย่าง 600 มล.',
      brand: 'Smart Brand',
      sourcePriceMinor: 1250,
      regularPriceMinor: 1500,
    })
  })

  it('does not select a product with a different barcode', () => {
    const result = parseBigCProductDocument(
      '<script type="application/ld+json">{"name":"Wrong","gtin13":"0000000000000"}</script>',
      '8851959129012',
      'https://www.bigc.co.th/search?q=8851959129012',
    )

    expect(result).toBeNull()
  })
})

describe('product lookup route', () => {
  it('returns a D1 product without querying Big C again', async () => {
    await env.DB.prepare(
      `INSERT INTO products
        (id, upc, name, brand, package_size, unit, category, image_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        'product-1',
        '8851959129012',
        'สินค้าจากฐานข้อมูล',
        'Smart Brand',
        null,
        null,
        null,
        null,
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      )
      .run()

    const response = await SELF.fetch('https://example.com/api/v1/products/upc/8851959129012')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { id: 'product-1', name: 'สินค้าจากฐานข้อมูล', source: 'smartcart' },
      meta: { source: 'smartcart' },
    })
  })
})


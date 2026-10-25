import { SELF, applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const userId = 'history-test-user'
const otherUserId = 'history-other-user'
const sessionToken = 'history-test-session-token'

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))

beforeEach(async () => {
  const now = new Date(Date.now() + 60_000).toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM purchases WHERE user_id IN (?, ?)').bind(userId, otherUserId),
    env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind('history-test-session'),
    env.DB.prepare('DELETE FROM users WHERE id IN (?, ?)').bind(userId, otherUserId),
    env.DB.prepare("DELETE FROM products WHERE id IN ('history-product-a', 'history-product-b', 'history-product-other')"),
    env.DB.prepare('INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)').bind(userId, 'History test', 'history@example.com'),
    env.DB.prepare('INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)').bind(otherUserId, 'Other user', 'other@example.com'),
    env.DB.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind('history-test-session', userId, await sha256Hex(sessionToken), now),
    env.DB.prepare('INSERT INTO products (id, sku, upc, name, brand, image_url) VALUES (?, ?, ?, ?, ?, ?)').bind('history-product-a', '8851959129012', '8851959129012', 'นมตัวอย่าง', 'Smart Brand', null),
    env.DB.prepare('INSERT INTO products (id, sku, upc, name, brand, image_url) VALUES (?, ?, ?, ?, ?, ?)').bind('history-product-b', 'BIGC-123456', null, 'น้ำตัวอย่าง', 'Smart Brand', null),
    env.DB.prepare('INSERT INTO products (id, sku, upc, name, brand, image_url) VALUES (?, ?, ?, ?, ?, ?)').bind('history-product-other', '8851959129014', '8851959129014', 'สินค้าของคนอื่น', 'Other', null),
    env.DB.prepare('INSERT INTO purchases (id, user_id, product_id, store_id, unit_price_minor, quantity, total_minor, purchased_at, note) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)').bind('history-purchase-a', userId, 'history-product-a', 2500, 2, 5000, '2026-09-01T10:00:00.000Z'),
    env.DB.prepare('INSERT INTO purchases (id, user_id, product_id, store_id, unit_price_minor, quantity, total_minor, purchased_at, note) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)').bind('history-purchase-b', userId, 'history-product-b', 1500, 1, 1500, '2026-09-01T09:00:00.000Z'),
    env.DB.prepare('INSERT INTO purchases (id, user_id, product_id, store_id, unit_price_minor, quantity, total_minor, purchased_at, note) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)').bind('history-purchase-other', otherUserId, 'history-product-other', 9900, 1, 9900, '2026-09-01T11:00:00.000Z'),
  ])
})

describe('history and my products routes', () => {
  const requestHeaders = { Cookie: `smartcart_session=${sessionToken}` }

  it('returns only the signed-in account purchase history and supports search', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/purchases?q=%E0%B8%99%E0%B8%A1', { headers: requestHeaders })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ id: 'history-purchase-a', productName: 'นมตัวอย่าง', totalMinor: 5000 }], nextCursor: null },
    })
  })

  it('aggregates the signed-in account products without exposing another account', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/products/mine', { headers: requestHeaders })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        items: [
          { id: 'history-product-a', purchaseCount: 1, totalSpentMinor: 5000 },
          { id: 'history-product-b', sku: 'BIGC-123456', upc: null, purchaseCount: 1, totalSpentMinor: 1500 },
        ],
      },
    })
  })

  it('searches SKU-only imports and preserves their absent UPC in history', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/purchases?q=BIGC-123456', { headers: requestHeaders })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [{ productId: 'history-product-b', productSku: 'BIGC-123456', productUpc: null }] },
    })
  })
})

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}


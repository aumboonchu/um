import { SELF, applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const userId = 'sync-test-user'
const productId = 'sync-test-product'
const sessionToken = 'sync-test-session-token'
const operationId = 'f1a1c431-d393-4f4f-8bc7-99a154fc7c9a'

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))

beforeEach(async () => {
  const tokenHash = await sha256Hex(sessionToken)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sync_operations'),
    env.DB.prepare('DELETE FROM sync_batches'),
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM stores'),
    env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind('sync-test-session'),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId),
    env.DB.prepare('INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)').bind(userId, 'Sync test', 'sync@example.com'),
    env.DB.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind('sync-test-session', userId, tokenHash, new Date(Date.now() + 60_000).toISOString()),
    env.DB.prepare('INSERT INTO products (id, sku, upc, name) VALUES (?, ?, ?, ?)').bind(productId, 'BIGC-123456', null, 'สินค้าทดสอบ'),
  ])

})

describe('offline sync route', () => {
  it('records a queued purchase once when the same operation is retried', async () => {
    const request = () => SELF.fetch('https://example.com/api/v1/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `smartcart_session=${sessionToken}` },
      body: JSON.stringify({
        clientId: 'iphone-test-client',
        operations: [{
          operationId,
          operationType: 'create_purchase',
          payload: {
            productId,
            unitPriceMinor: 1250,
            quantity: 2,
            purchasedAt: '2026-09-01T00:00:00.000Z',
            storeName: 'Big C',
            note: null,
          },
        }],
      }),
    })

    const first = await request()
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({ data: { operations: [{ operationId, status: 'synced' }] } })

    const retry = await request()
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toMatchObject({ data: { operations: [{ operationId, status: 'synced' }] } })

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM purchases WHERE id = ?').bind(operationId).first<{ count: number }>()
    expect(count?.count).toBe(1)
  })
})

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}


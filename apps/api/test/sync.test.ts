import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

const userId = 'sync-test-user'
const productId = 'sync-test-product'
const sessionToken = 'sync-test-session-token'
const operationId = 'f1a1c431-d393-4f4f-8bc7-99a154fc7c9a'

beforeEach(async () => {
  const tokenHash = await sha256Hex(sessionToken)
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT, primary_email TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, upc TEXT NOT NULL UNIQUE, name TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, store_id TEXT, unit_price_minor INTEGER NOT NULL, quantity REAL NOT NULL, total_minor INTEGER NOT NULL, purchased_at TEXT NOT NULL, note TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sync_batches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sync_operations (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, operation_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT)'),
    env.DB.prepare('DELETE FROM sync_operations'),
    env.DB.prepare('DELETE FROM sync_batches'),
    env.DB.prepare('DELETE FROM purchases'),
    env.DB.prepare('DELETE FROM stores'),
    env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind('sync-test-session'),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId),
    env.DB.prepare('INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)').bind(userId, 'Sync test', 'sync@example.com'),
    env.DB.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind('sync-test-session', userId, tokenHash, new Date(Date.now() + 60_000).toISOString()),
    env.DB.prepare('INSERT INTO products (id, upc, name) VALUES (?, ?, ?)').bind(productId, '8851959129012', 'สินค้าทดสอบ'),
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


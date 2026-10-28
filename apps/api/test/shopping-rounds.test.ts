import { applyD1Migrations, env, SELF, fetchMock } from 'cloudflare:test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseCheckout } from '../src/shopping-rounds'

const user = 'round-user', other = 'round-other', token = 'r'.repeat(43), otherToken = 's'.repeat(43)
const headers = { Authorization: `Bearer ${token}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }
const otherHeaders = { ...headers, Authorization: `Bearer ${otherToken}` }
const hash = async (v: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))].map(v => v.toString(16).padStart(2, '0')).join('')
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); fetchMock.activate(); fetchMock.disableNetConnect() })
afterAll(() => fetchMock.deactivate())
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(user), env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(other),
    env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)').bind('round-session', user, await hash(token), '2099-01-01T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)').bind('round-other-session', other, await hash(otherToken), '2099-01-01T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO products(id,sku,upc,name,package_size) VALUES (?,?,?,?,?)').bind('round-oreo', 'IMG-OREO', null, 'OREO', '24.6 g x 12'),
    env.DB.prepare('INSERT INTO products(id,sku,upc,name) VALUES (?,?,?,?)').bind('round-milk', 'UPC-MILK', '8851959129012', 'Milk'),
    env.DB.prepare('INSERT INTO purchases(id,user_id,product_id,unit_price_minor,quantity,total_minor,purchased_at) VALUES (?,?,?,?,?,?,?)').bind('round-legacy', user, 'round-milk', 2500, 1, 2500, '2026-10-01T01:00:00.000Z'),
  ])
})
function payload() { return { operationId: crypto.randomUUID(), accountId: user, checkedOutAt: '2026-10-28T10:00:00.000Z', storeName: 'Makro Pro', paymentMethod: 'cash', note: 'ซื้อรอบเย็น',
  lines: [{ id: crypto.randomUUID(), productId: 'round-oreo', unitPriceMinor: 4500, quantity: 2, note: null }, { id: crypto.randomUUID(), productId: 'round-milk', unitPriceMinor: 2500, quantity: 1, note: 'นม' }] } }
function post(value: unknown = payload(), auth: HeadersInit = headers) { return SELF.fetch('https://example.test/api/v1/rounds/checkout', { method: 'POST', headers: auth, body: JSON.stringify(value) }) }
function get(path: string, auth: HeadersInit = headers) { return SELF.fetch(`https://example.test/api/v1/${path}`, { headers: auth }) }
async function data<T>(response: Response) { return (await response.json<{ data: T }>()).data }
async function counts() { return Promise.all(['shopping_rounds', 'shopping_round_lines', 'stores'].map(table => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'))) }

describe('atomic checkout', () => {
  it('creates one paid round with all items and totals, retaining unassigned history', async () => {
    const input = payload(), response = await post(input)
    expect(response.status).toBe(200)
    expect(await data(response)).toMatchObject({ id: input.operationId, operationId: input.operationId, lineCount: 2, totalMinor: 11500, status: 'synced', paymentMethod: 'cash' })
    expect(await counts()).toEqual([1, 2, 1])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases').first('n')).toBe(3)
    expect(await env.DB.prepare("SELECT shopping_round_id FROM purchases WHERE id = 'round-legacy'").first('shopping_round_id')).toBeNull()
    const detail = await data<{ lines: unknown[]; totalMinor: number }>(await get(`rounds/${input.operationId}`))
    expect(detail.totalMinor).toBe(11500)
    expect(detail.lines).toMatchObject([{ productName: 'OREO', packageSize: '24.6 g x 12', quantity: 2, unitPriceMinor: 4500, totalMinor: 9000, productUpc: null }, { productName: 'Milk', totalMinor: 2500 }])
  })
  it('returns exactly the same receipt for an immutable retry', async () => {
    const p = payload(), first = await data(await post(p)), retry = await data(await post(p))
    expect(retry).toEqual(first); expect(await counts()).toEqual([1, 2, 1])
  })
  it('concurrent retries produce one complete round', async () => {
    const p = payload(), responses = await Promise.all([post(p), post(p)])
    expect(responses.map(r => r.status)).toEqual([200, 200]); expect(await counts()).toEqual([1, 2, 1])
  })
  it('rejects altered payloads under the same checkout UUID', async () => {
    const p = payload(); await post(p)
    expect((await post({ ...p, storeName: 'altered' })).status).toBe(409)
    expect(await counts()).toEqual([1, 2, 1])
  })
  it('never reassigns a line UUID already used in another round', async () => {
    const p = payload(); await post(p)
    expect((await post({ ...p, operationId: crypto.randomUUID(), storeName: 'must roll back' })).status).toBe(409)
    expect(await counts()).toEqual([1, 2, 1])
  })
  it('rolls back store, receipt and every purchase if the final snapshot write fails', async () => {
    await env.DB.prepare("CREATE TRIGGER round_fail BEFORE INSERT ON shopping_round_lines BEGIN SELECT RAISE(ABORT, 'QA round snapshot failure'); END").run()
    expect((await post()).status).toBe(500)
    expect(await counts()).toEqual([0, 0, 0]); expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases').first('n')).toBe(1)
  })
  it('rejects missing products before writing a store or any items', async () => {
    const p = payload(); p.lines[1].productId = 'missing'
    expect((await post(p)).status).toBe(404); expect(await counts()).toEqual([0, 0, 0])
  })
  it('preserves checkout snapshot if catalog data later changes', async () => {
    const p = payload(); await post(p)
    await env.DB.prepare("UPDATE products SET name = 'changed later', package_size = 'different' WHERE id = 'round-oreo'").run()
    expect((await data<{ lines: unknown[] }>(await get(`rounds/${p.operationId}`))).lines).toMatchObject([{ productName: 'OREO', packageSize: '24.6 g x 12' }, { productName: 'Milk' }])
  })
  it.each(['PATCH', 'DELETE'])('does not allow %s of one item to break paid-round totals', async method => {
    const p = payload(); await post(p)
    const response = await SELF.fetch(`https://example.test/api/v1/purchases/${p.lines[0].id}`, { method, headers,
      body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: 1, ...(method === 'PATCH' ? { unitPriceMinor: 100, quantity: 1, purchasedAt: p.checkedOutAt } : {}) }) })
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'ROUND_LOCKED' } })
    expect((await data<{ totalMinor: number }>(await get(`rounds/${p.operationId}`))).totalMinor).toBe(11500)
  })
  it('handles 100 lines within a small fixed number of batch statements', async () => {
    const p = payload(); p.lines = Array.from({ length: 100 }, () => ({ ...p.lines[0], id: crypto.randomUUID(), quantity: .5 }))
    expect((await post(p)).status).toBe(200); expect(await counts()).toEqual([1, 100, 1])
  })
})

describe('auth and validation', () => {
  it.each(['rounds', 'rounds/11111111-1111-4111-8111-111111111111'])('requires authentication for %s', async path => { expect((await get(path, {})).status).toBe(401) })
  it('rejects anonymous and hostile-origin checkout before any writes', async () => {
    expect((await post(payload(), { 'Content-Type': 'application/json' })).status).toBe(401)
    expect((await post(payload(), { ...headers, Origin: 'https://hostile.test' })).status).toBe(403)
    expect(await counts()).toEqual([0, 0, 0])
  })
  it('will not submit an offline round under a different signed-in account', async () => {
    expect((await post(payload(), otherHeaders)).status).toBe(403); expect(await counts()).toEqual([0, 0, 0])
  })
  it.each(['operationId', 'accountId', 'checkedOutAt', 'paymentMethod', 'lines'])('rejects missing %s', async key => {
    const p: Record<string, unknown> = payload(); delete p[key]; expect((await post(p)).status).toBe(400)
  })
  it.each([0, -1, .5, 100_000_001, '4500', null])('rejects invalid unit prices %s', async price => {
    const p = payload(); const value = { ...p, lines: [{ ...p.lines[0], unitPriceMinor: price }] }
    expect((await post(value)).status).toBe(400); expect(await counts()).toEqual([0, 0, 0])
  })
  it.each([0, -1, 10001, '2', null])('rejects invalid quantities %s', async quantity => {
    const p = payload(); expect((await post({ ...p, lines: [{ ...p.lines[0], quantity }] })).status).toBe(400)
  })
  it('rejects duplicate IDs, empty/oversized rounds and client-supplied totals', async () => {
    const p = payload()
    for (const bad of [{ ...p, lines: [] }, { ...p, lines: [p.lines[0], p.lines[0]] }, { ...p, lines: Array(101).fill(p.lines[0]) }, { ...p, totalMinor: 1 }, { ...p, lines: [{ ...p.lines[0], productName: 'forged' }] }]) expect((await post(bad)).status).toBe(400)
  })
  it('rejects oversized streamed bodies and date without timezone', async () => {
    expect((await post({ ...payload(), note: 'x'.repeat(130 * 1024) })).status).toBe(400)
    expect((await post({ ...payload(), checkedOutAt: '2026-10-28T10:00:00' })).status).toBe(400)
  })
  it('normalizes dates, UUID case and text deterministically', () => {
    const p = payload(), normalized = parseCheckout({ ...p, operationId: p.operationId.toUpperCase(), checkedOutAt: '2026-10-28T17:00:00+07:00', storeName: ' Makro Pro ' })
    expect(normalized).toMatchObject({ operationId: p.operationId, checkedOutAt: p.checkedOutAt, storeName: p.storeName })
  })
})

describe('reports and database-first scanning', () => {
  it('keeps reports and summary isolated from another account and legacy purchases', async () => {
    const p = payload(); await post(p)
    const otherPayload = payload(); await post({ ...otherPayload, accountId: other }, otherHeaders)
    const page = await data<{ items: unknown[]; summary: unknown; legacy: unknown }>(await get('rounds?month=2026-10'))
    expect(page.items).toHaveLength(1); expect(page.summary).toEqual({ roundCount: 1, totalPaidMinor: 11500 }); expect(page.legacy).toEqual({ count: 1, totalMinor: 2500 })
    expect((await get(`rounds/${p.operationId}`, otherHeaders)).status).toBe(404)
    expect((await post({ ...p, accountId: other }, otherHeaders)).status).toBe(409)
  })
  it('uses Bangkok month boundaries', async () => {
    const p = payload(); await post({ ...p, checkedOutAt: '2026-09-30T17:00:00.000Z' })
    expect((await data<{ summary: { roundCount: number } }>(await get('rounds?month=2026-10'))).summary.roundCount).toBe(1)
    expect((await data<{ summary: { roundCount: number } }>(await get('rounds?month=2026-09'))).summary.roundCount).toBe(0)
  })
  it('paginates deterministically without duplicates at equal timestamps', async () => {
    for (let i = 0; i < 21; i++) await post(payload())
    const first = await data<{ items: { id: string }[]; nextCursor: string }>(await get('rounds?month=2026-10'))
    const next = await data<{ items: { id: string }[]; nextCursor: null }>(await get(`rounds?month=2026-10&cursor=${encodeURIComponent(first.nextCursor)}`))
    expect(first.items).toHaveLength(20); expect(next.items).toHaveLength(1); expect(next.nextCursor).toBeNull()
    expect(new Set([...first.items, ...next.items].map(v => v.id)).size).toBe(21)
  })
  it.each(['month=2026-13', 'cursor=not-json'])('rejects invalid report query %s', async q => { expect((await get(`rounds?${q}`)).status).toBe(400) })
  it('returns a 404 immediately for unknown catalog barcode without any retailer requests', async () => {
    expect((await get('products/upc/3017620422003?databaseOnly=1')).status).toBe(404)
    const found = await data<{ id: string }>(await get('products/upc/8851959129012?databaseOnly=1'))
    expect(found.id).toBe('round-milk')
  })
  it('registers scanned products with pack size, then finds them directly in the catalog', async () => {
    const response = await SELF.fetch('https://example.test/api/v1/products', { method: 'POST', headers,
      body: JSON.stringify({ upc: '3017620422003', name: 'New scanned item', brand: 'Test', packageSize: '24.6 g x 12' }) })
    expect(response.status).toBe(201)
    expect(await data(await get('products/upc/3017620422003?databaseOnly=1'))).toMatchObject({ name: 'New scanned item', packageSize: '24.6 g x 12' })
  })
  it.each(['x'.repeat(101), 123])('rejects invalid manual package size %#', async packageSize => {
    const response = await SELF.fetch('https://example.test/api/v1/products', { method: 'POST', headers,
      body: JSON.stringify({ upc: '3017620422003', name: 'New scanned item', packageSize }) })
    expect(response.status).toBe(400)
  })
  it('separates legacy history while totals still include all completed purchases exactly once', async () => {
    await post(payload())
    expect((await data<{ items: { id: string }[] }>(await get('purchases?legacyOnly=1'))).items.map(v => v.id)).toEqual(['round-legacy'])
    expect((await data<{ totalSpentMinor: number }>(await get('dashboard?month=2026-10'))).totalSpentMinor).toBe(14000)
  })
})

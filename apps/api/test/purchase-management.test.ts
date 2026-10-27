import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { monthRange } from '../src/purchase-management'

const user = 'management-user', other = 'management-other', token = 'm'.repeat(43), otherToken = 'o'.repeat(43)
const product = 'management-product', purchase = 'management-purchase'
const headers = { Authorization: `Bearer ${token}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }
async function hash(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('') }
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS) })
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(user), env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(other),
    env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)').bind('management-session', user, await hash(token), '2099-01-01T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)').bind('management-other-session', other, await hash(otherToken), '2099-01-01T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO products(id,sku,upc,name,brand,package_size) VALUES (?,?,?,?,?,?)').bind(product, 'SC-MANAGEMENT', null, 'สินค้าทดสอบ', 'แบรนด์', '600 มล.'),
    env.DB.prepare('INSERT INTO purchases(id,user_id,product_id,unit_price_minor,quantity,total_minor,purchased_at,note) VALUES (?,?,?,?,?,?,?,?)').bind(purchase, user, product, 3700, 2, 7400, '2026-09-30T17:00:00.000Z', 'บันทึกเดิม'),
    env.DB.prepare('INSERT INTO purchases(id,user_id,product_id,unit_price_minor,quantity,total_minor,purchased_at) VALUES (?,?,?,?,?,?,?)').bind('management-other-purchase', other, product, 9900, 3, 29700, '2026-10-01T01:00:00.000Z'),
  ])
})
function get(path: string, requestHeaders: HeadersInit = headers) { return SELF.fetch(`https://example.com/api/v1/${path}`, { headers: requestHeaders }) }
function edit(overrides: Record<string, unknown> = {}) { return { operationId: crypto.randomUUID(), expectedRevision: 1, unitPriceMinor: 4000, quantity: 1.5, purchasedAt: '2026-10-02T10:00:00.000Z', note: 'แก้ไขแล้ว', storeName: 'ร้านทดสอบ', ...overrides } }
function mutate(body: unknown, method = 'PATCH', id = purchase, requestHeaders: HeadersInit = headers) { return SELF.fetch(`https://example.com/api/v1/purchases/${id}`, { method, headers: requestHeaders, body: JSON.stringify(body) }) }
async function body(response: Response) { return response.json<{ data: Record<string, unknown>; error?: { code: string } }>() }

describe('dashboard and owned details', () => {
  it('uses Bangkok month boundaries, counts only this user and includes recent receipts', async () => {
    const response = await get('dashboard?month=2026-10')
    expect(response.status).toBe(200)
    expect((await body(response)).data).toMatchObject({ totalSpentMinor: 7400, purchaseCount: 1, productCount: 1, averageMinor: 7400,
      start: '2026-09-30T17:00:00.000Z', end: '2026-10-31T17:00:00.000Z', recentPurchases: [{ id: purchase }] })
    expect((await body(await get('dashboard?month=2026-09'))).data).toMatchObject({ totalSpentMinor: 0, purchaseCount: 0, averageMinor: 0 })
  })
  it('loads complete receipt and personal product statistics without another user prices', async () => {
    expect((await body(await get(`purchases/${purchase}`))).data).toMatchObject({ id: purchase, revision: 1, productSku: 'SC-MANAGEMENT', note: 'บันทึกเดิม', packageSize: '600 มล.' })
    expect((await body(await get(`products/${product}/detail`))).data).toMatchObject({ purchaseCount: 1, totalSpentMinor: 7400, totalQuantity: 2, minimumPriceMinor: 3700, maximumPriceMinor: 3700, recentPurchases: [{ id: purchase }] })
  })
  it('hides receipts and products unrelated to this account', async () => {
    expect((await get('purchases/management-other-purchase')).status).toBe(404)
    await env.DB.prepare('INSERT INTO products(id,sku,name) VALUES (?,?,?)').bind('unrelated-product', 'UNRELATED', 'ของคนอื่น').run()
    expect((await get('products/unrelated-product/detail')).status).toBe(404)
  })
  it.each(['dashboard', `purchases/${purchase}`, `products/${product}/detail`])('requires login for %s', async (path) => { expect((await get(path, {})).status).toBe(401) })
  it.each(['2026-00', '2026-13', '2026-1', '2026-10 OR 1=1'])('rejects invalid months %s', async month => { expect((await get(`dashboard?month=${encodeURIComponent(month)}`)).status).toBe(400) })
  it('handles leap years and the UTC/Bangkok date boundary', () => {
    expect(monthRange('2024-02').end).toBe('2024-02-29T17:00:00.000Z')
    expect(monthRange(null, new Date('2026-09-30T17:01:00.000Z')).month).toBe('2026-10')
  })
})

describe('safe edit / delete', () => {
  it('edits price, quantity, store, date and note atomically and recalculates totals', async () => {
    const response = await mutate(edit())
    expect(response.status).toBe(200)
    expect((await body(response)).data).toMatchObject({ purchaseId: purchase, action: 'edit', revision: 2 })
    expect((await body(await get(`purchases/${purchase}`))).data).toMatchObject({ unitPriceMinor: 4000, quantity: 1.5, totalMinor: 6000, storeName: 'ร้านทดสอบ', note: 'แก้ไขแล้ว', revision: 2 })
    expect((await body(await get('dashboard?month=2026-10'))).data.totalSpentMinor).toBe(6000)
  })
  it('retries the same operation without duplicate mutations or increasing revision', async () => {
    const payload = edit(); const first = await body(await mutate(payload)); const second = await body(await mutate(payload))
    expect(second).toEqual(first)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM purchase_mutations').first('count')).toBe(1)
    expect((await body(await get(`purchases/${purchase}`))).data.revision).toBe(2)
  })
  it('rejects operation UUID reuse with altered fields or an altered action', async () => {
    const payload = edit(); expect((await mutate(payload)).status).toBe(200)
    expect((await mutate({ ...payload, quantity: 8 })).status).toBe(409)
    expect((await mutate({ operationId: payload.operationId, expectedRevision: 1 }, 'DELETE')).status).toBe(409)
    expect((await body(await get(`purchases/${purchase}`))).data.quantity).toBe(1.5)
  })
  it('prevents stale tabs overwriting data and does not create their store', async () => {
    await mutate(edit())
    expect((await mutate(edit({ storeName: 'ร้านจากแท็บเก่า' }))).status).toBe(409)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM stores WHERE name = ?').bind('ร้านจากแท็บเก่า').first('count')).toBe(0)
  })
  it('makes concurrent distinct operations contend on revision; exactly one wins', async () => {
    const responses = await Promise.all([mutate(edit({ unitPriceMinor: 1200 })), mutate(edit({ unitPriceMinor: 2500 }))])
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM purchase_mutations').first('count')).toBe(1)
  })
  it('concurrent retries of a single UUID return the same receipt once', async () => {
    const payload = edit()
    const responses = await Promise.all([mutate(payload), mutate(payload)])
    expect(responses.map(r => r.status)).toEqual([200, 200])
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM purchase_mutations').first('count')).toBe(1)
  })
  it('soft deletes, updates all lists/totals, preserves replay protection and the original row', async () => {
    const payload = { operationId: crypto.randomUUID(), expectedRevision: 1 }
    expect((await mutate(payload, 'DELETE')).status).toBe(200)
    expect((await mutate(payload, 'DELETE')).status).toBe(200)
    expect((await get(`purchases/${purchase}`)).status).toBe(404)
    expect((await body(await get('purchases'))).data).toMatchObject({ items: [] })
    expect((await body(await get('products/mine'))).data).toMatchObject({ items: [] })
    expect((await body(await get('dashboard?month=2026-10'))).data).toMatchObject({ totalSpentMinor: 0, purchaseCount: 0 })
    expect((await body(await get(`products/${product}/detail`))).data).toMatchObject({ purchaseCount: 0, totalSpentMinor: 0, recentPurchases: [] })
    expect(await env.DB.prepare('SELECT deleted_at FROM purchases WHERE id = ?').bind(purchase).first('deleted_at')).toBeTypeOf('string')
    expect((await mutate(edit({ expectedRevision: 2 }))).status).toBe(409)
  })
  it('does not change another account purchase even with a known id and revision', async () => {
    for (const method of ['PATCH', 'DELETE']) expect((await mutate(method === 'PATCH' ? edit() : { operationId: crypto.randomUUID(), expectedRevision: 1 }, method, 'management-other-purchase')).status).toBe(404)
    expect(await env.DB.prepare('SELECT revision FROM purchases WHERE id = ?').bind('management-other-purchase').first('revision')).toBe(1)
  })
  it('requires an exact trusted origin for changes, including cookie-authenticated requests', async () => {
    expect((await mutate(edit(), 'PATCH', purchase, { ...headers, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await mutate(edit(), 'PATCH', purchase, { Authorization: headers.Authorization, 'Content-Type': 'application/json' })).status).toBe(403)
    expect((await mutate(edit(), 'PATCH', purchase, { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' })).status).toBe(401)
  })
  it.each([{ unitPriceMinor: -1 }, { unitPriceMinor: 1.5 }, { quantity: 0 }, { quantity: 10_001 }, { quantity: .00000001, unitPriceMinor: 1 }, { purchasedAt: 'invalid' }, { purchasedAt: '2026-10-01T10:00' }, { note: 'x'.repeat(501) }, { storeName: 123 }, { productId: 'another-product' }, { userId: other }, { expectedRevision: 0 }, { operationId: 'bad' }])('rejects invalid edit %# without changes', async fields => {
    expect((await mutate(edit(fields))).status).toBe(400)
    expect(await env.DB.prepare('SELECT revision FROM purchases WHERE id = ?').bind(purchase).first('revision')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM purchase_mutations').first('count')).toBe(0)
  })
  it('bounds JSON size and refuses unrelated fields in delete requests', async () => {
    expect((await mutate(edit({ note: 'x'.repeat(11_000) }))).status).toBe(400)
    expect((await mutate({ operationId: crypto.randomUUID(), expectedRevision: 1, productId: product }, 'DELETE')).status).toBe(400)
  })
  it('rolls back the purchase and store together if receipt insertion fails', async () => {
    await env.DB.exec("CREATE TRIGGER qa_reject_mutation BEFORE INSERT ON purchase_mutations BEGIN SELECT RAISE(ABORT, 'QA receipt failure'); END;")
    expect((await mutate(edit())).status).toBe(500)
    expect(await env.DB.prepare('SELECT revision FROM purchases WHERE id = ?').bind(purchase).first('revision')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM stores').first('count')).toBe(0)
  })
  it('a delayed offline-create retry cannot resurrect a soft-deleted purchase', async () => {
    const operationId = crypto.randomUUID()
    const payload = { clientId: 'qa-device', operations: [{ operationId, operationType: 'create_purchase', payload: { productId: product, unitPriceMinor: 2500, quantity: 1, purchasedAt: new Date().toISOString(), note: null, storeName: null } }] }
    const sync = () => SELF.fetch('https://example.com/api/v1/sync', { method: 'POST', headers, body: JSON.stringify(payload) })
    expect((await sync()).status).toBe(200)
    expect((await mutate({ operationId: crypto.randomUUID(), expectedRevision: 1 }, 'DELETE', operationId)).status).toBe(200)
    expect((await sync()).status).toBe(200)
    expect((await get(`purchases/${operationId}`)).status).toBe(404)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM purchases WHERE id = ? AND deleted_at IS NOT NULL').bind(operationId).first('count')).toBe(1)
  })
})

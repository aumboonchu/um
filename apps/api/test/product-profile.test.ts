import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

const user = 'profile-user', other = 'profile-other', outsider = 'profile-outsider', product = 'profile-product'
const token = 'p'.repeat(43), otherToken = 'q'.repeat(43), outsiderToken = 'z'.repeat(43)
const headers = { Authorization: `Bearer ${token}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'X-SmartCart-Profile': '1' }
const otherHeaders = { ...headers, Authorization: `Bearer ${otherToken}` }
const barcode = '8851959129012'
const sha = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('')
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(async () => {
  for (const [id, sessionToken] of [[user, token], [other, otherToken], [outsider, outsiderToken]]) {
    await env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(id).run()
    await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .bind(`${id}-session`, id, await sha(sessionToken), '2099-01-01T00:00:00.000Z').run()
  }
  await env.DB.prepare('INSERT INTO products(id,sku,upc,name,brand,package_size) VALUES (?,?,?,?,?,?)')
    .bind(product, 'IMG-PROFILE', barcode, 'ชื่อกลาง', 'แบรนด์กลาง', '1 ล.').run()
  for (const id of [user, other]) await env.DB.prepare('INSERT INTO purchases(id,user_id,product_id,unit_price_minor,quantity,total_minor,purchased_at) VALUES (?,?,?,?,?,?,?)')
    .bind(`${id}-purchase`, id, product, 5000, 1, 5000, '2026-10-01T00:00:00.000Z').run()
})
const payload = (overrides: Record<string, unknown> = {}) => ({ accountId: user, operationId: crypto.randomUUID(), expectedRevision: 0,
  name: 'ชื่อที่ฉันแก้', brand: 'แบรนด์ฉัน', packageSize: '1 ลิตร', unit: 'ขวด', category: 'อาหาร', ...overrides })
const get = (path: string, requestHeaders: HeadersInit = headers) => SELF.fetch(`https://example.test/api/v1/${path}`, { headers: requestHeaders })
const patch = (value: unknown, requestHeaders: HeadersInit = headers, id = product) => SELF.fetch(`https://example.test/api/v1/products/${id}/detail`, { method: 'PATCH', headers: requestHeaders, body: JSON.stringify(value) })
const data = async (response: Response) => (await response.json<{ data: Record<string, unknown>; error?: { code: string } }>())
const count = (table: 'product_profiles' | 'product_profile_mutations') => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')

describe('account-specific product details', () => {
  it('edits display fields without changing shared SKU, barcode, purchase amounts, or another account', async () => {
    const initial = await data(await get(`products/${product}/detail`))
    expect(initial.data).toMatchObject({ name: 'ชื่อกลาง', profileRevision: 0, totalSpentMinor: 5000 })
    const request = payload()
    expect((await patch(request)).status).toBe(200)
    expect((await data(await get(`products/${product}/detail`))).data).toMatchObject({ name: request.name, brand: request.brand,
      packageSize: request.packageSize, unit: 'ขวด', category: 'อาหาร', profileRevision: 1, sku: 'IMG-PROFILE', upc: barcode, totalSpentMinor: 5000 })
    expect((await data(await get(`products/upc/${barcode}?databaseOnly=1`))).data).toMatchObject({ name: request.name, profileRevision: 1 })
    expect((await data(await get(`products/upc/${barcode}?databaseOnly=1`, {}))).data.name).toBe('ชื่อกลาง')
    expect((await data(await get(`products/${product}/detail`, otherHeaders))).data).toMatchObject({ name: 'ชื่อกลาง', brand: 'แบรนด์กลาง', profileRevision: 0 })
    expect(await env.DB.prepare('SELECT name, upc, sku FROM products WHERE id = ?').bind(product).first()).toEqual({ name: 'ชื่อกลาง', upc: barcode, sku: 'IMG-PROFILE' })
    expect(await env.DB.prepare('SELECT SUM(total_minor) AS n FROM purchases').first('n')).toBe(10000)
  })
  it('shows edited names in own product search and legacy history without joining another account details', async () => {
    await patch(payload())
    const mine = await data(await get(`products/mine?q=${encodeURIComponent('ชื่อที่ฉันแก้')}`))
    expect(mine.data).toMatchObject({ items: [{ id: product, name: 'ชื่อที่ฉันแก้', packageSize: '1 ลิตร', totalSpentMinor: 5000 }] })
    expect((await data(await get(`products/mine?q=${encodeURIComponent('ชื่อที่ฉันแก้')}`, otherHeaders))).data).toMatchObject({ items: [] })
    expect((await data(await get(`purchases?q=${encodeURIComponent('ชื่อที่ฉันแก้')}`))).data).toMatchObject({ items: [{ productName: 'ชื่อที่ฉันแก้', totalMinor: 5000 }] })
    expect((await data(await get(`purchases/${user}-purchase`))).data).toMatchObject({ productName: 'ชื่อที่ฉันแก้', packageSize: '1 ลิตร', totalMinor: 5000 })
  })
  it('keeps old clients on canonical product fields so they cannot put personal names into their shared cache', async () => {
    await patch(payload())
    const legacy = new Headers(headers); legacy.delete('X-SmartCart-Profile')
    expect((await data(await get(`products/upc/${barcode}?databaseOnly=1`, legacy))).data.name).toBe('ชื่อกลาง')
    expect((await data(await get(`products/${product}/detail`, legacy))).data).toMatchObject({ name: 'ชื่อกลาง', profileRevision: 0 })
  })
  it('allows the capability header in preflight only from the app origin', async () => {
    for (const origin of [env.APP_ORIGIN, 'https://evil.example']) {
      const response = await SELF.fetch(`https://example.test/api/v1/products/${product}/detail`, { method: 'OPTIONS', headers: {
        Origin: origin, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,x-smartcart-profile,content-type',
      } })
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin === env.APP_ORIGIN ? origin : null)
      expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-smartcart-profile')
    }
  })
  it('can deliberately clear optional fields instead of falling back to shared values', async () => {
    await patch(payload({ brand: null, packageSize: null, unit: null, category: null }))
    expect((await data(await get(`products/${product}/detail`))).data).toMatchObject({ brand: null, packageSize: null, unit: null, category: null })
    expect((await data(await get('products/mine'))).data).toMatchObject({ items: [{ brand: null, packageSize: null }] })
  })
  it('allows an owned image-import SKU before its first purchase without granting access to another account', async () => {
    const imported = 'profile-image-only'
    await env.DB.prepare('INSERT INTO products(id,sku,name) VALUES (?,?,?)').bind(imported, 'IMG-ONLY', 'จากรูป').run()
    await env.DB.prepare('INSERT INTO product_image_imports(user_id,operation_id,payload_hash,product_id,created_at) VALUES (?,?,?,?,?)')
      .bind(user, crypto.randomUUID(), 'a'.repeat(64), imported, new Date().toISOString()).run()
    expect((await patch(payload(), headers, imported)).status).toBe(200)
    expect((await data(await get(`products/${imported}/detail`))).data).toMatchObject({ name: 'ชื่อที่ฉันแก้', purchaseCount: 0, totalSpentMinor: 0, upc: null })
    expect((await patch(payload({ accountId: other }), otherHeaders, imported)).status).toBe(404)
  })
  it('replays one UUID safely, even after a newer revision has been saved', async () => {
    const first = payload(), response = await data(await patch(first))
    expect(await data(await patch({ ...first, operationId: first.operationId.toUpperCase() }))).toEqual(response)
    await patch(payload({ expectedRevision: 1, name: 'แก้ครั้งสอง' }))
    expect(await data(await patch(first))).toEqual(response)
    expect((await data(await get(`products/${product}/detail`))).data).toMatchObject({ name: 'แก้ครั้งสอง', profileRevision: 2 })
    expect(await count('product_profile_mutations')).toBe(2)
  })
  it('rejects stale revisions and changed payloads under an already-used UUID', async () => {
    const first = payload(); await patch(first)
    expect((await data(await patch({ ...first, name: 'changed UUID payload' }))).error?.code).toBe('OPERATION_CONFLICT')
    expect((await data(await patch(payload()))).error?.code).toBe('PRODUCT_CONFLICT')
    expect(await count('product_profile_mutations')).toBe(1)
  })
  it('serializes concurrent first edits and deduplicates concurrent UUID retries', async () => {
    const first = payload()
    expect((await Promise.all([patch(first), patch(first)])).map(r => r.status)).toEqual([200, 200])
    const results = await Promise.all([patch(payload({ expectedRevision: 1, name: 'A' })), patch(payload({ expectedRevision: 1, name: 'B' }))])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(await count('product_profiles')).toBe(1)
    expect(await count('product_profile_mutations')).toBe(2)
  })
  it('authenticates before writing, requires the app Origin, and binds the request to its account', async () => {
    expect((await patch(payload(), {})).status).toBe(401)
    for (const origin of [undefined, 'https://evil.example']) {
      const h = new Headers(headers); h.delete('Origin'); if (origin) h.set('Origin', origin)
      expect((await patch(payload(), h)).status).toBe(403)
    }
    expect((await data(await patch(payload(), otherHeaders))).error?.code).toBe('PRODUCT_ACCOUNT_MISMATCH')
    expect((await patch(payload({ accountId: outsider }), { ...headers, Authorization: `Bearer ${outsiderToken}` })).status).toBe(404)
    expect((await patch(payload(), headers, 'unknown-product')).status).toBe(404)
    expect(await count('product_profiles')).toBe(0)
  })
  it.each([{ name: '' }, { name: 'x'.repeat(201) }, { brand: 'x'.repeat(101) }, { name: 'bad\u0000name' }, { expectedRevision: -1 },
    { expectedRevision: 0.5 }, { operationId: 'not-a-uuid' }, { upc: '8851959129012' }, { sku: 'changed' }, { sourcePriceMinor: 1 },
    { imageUrl: 'https://evil.example/' }, { userId: other }])('rejects invalid or immutable fields %#', async changes => {
    expect((await patch(payload(changes))).status).toBe(400)
    expect(await count('product_profiles')).toBe(0)
  })
  it('bounds the body and rejects non-JSON input without changing anything', async () => {
    expect((await patch(payload({ name: 'x'.repeat(11000) }))).status).toBe(400)
    expect((await patch(payload(), { ...headers, 'Content-Type': 'text/plain' })).status).toBe(400)
    expect(await count('product_profiles')).toBe(0)
  })
  it('snapshots edited details into new paid rounds while leaving old round names and totals immutable', async () => {
    await patch(payload())
    const roundId = crypto.randomUUID()
    const response = await SELF.fetch('https://example.test/api/v1/rounds/checkout', { method: 'POST', headers, body: JSON.stringify({
      accountId: user, operationId: roundId, checkedOutAt: '2026-10-02T00:00:00.000Z', storeName: 'ร้าน', paymentMethod: 'cash', note: null,
      lines: [{ id: crypto.randomUUID(), productId: product, unitPriceMinor: 5000, quantity: 1, note: null }],
    }) })
    expect(response.status).toBe(200)
    await patch(payload({ expectedRevision: 1, name: 'ชื่อใหม่ภายหลัง', packageSize: '2 ลิตร' }))
    expect((await data(await get(`rounds/${roundId}`))).data).toMatchObject({ totalMinor: 5000, lines: [{ productName: 'ชื่อที่ฉันแก้', packageSize: '1 ลิตร', totalMinor: 5000 }] })
  })
})

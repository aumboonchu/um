import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminPasswordHash, ADMIN_PASSWORD_ITERATIONS, adminSha } from '../src/admin'

const owner = 'admin-owner', member = 'admin-member', product = 'admin-product'
const googleToken = 'a'.repeat(43), memberToken = 'b'.repeat(43), secondGoogleToken = 'c'.repeat(43)
const salt = '12'.repeat(32), password = 'SmartCart-new-2026!'
const baseHeaders = { Authorization: `Bearer ${googleToken}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }
type Session = { token: string; expiresAt: string; mustChangePassword: boolean }
type Receipt = { operationId: string; productId: string; revision: number }
type Product = { id: string; sku: string; upc: string | null; name: string; brand: string | null; packageSize: string | null; unit: string | null; category: string | null; revision: number }
type Page = { items: Product[]; nextCursor: string | null; total: number }
type Envelope<T> = { data: T; error?: { code: string } }
const json = <T>(response: Response) => response.json<Envelope<T>>()
const call = (path: string, method = 'GET', body?: unknown, token?: string, headers: HeadersInit = baseHeaders) => {
  const h = new Headers(headers)
  if (token) h.set('X-SmartCart-Admin', token)
  return SELF.fetch(`https://example.test/api/v1/admin/${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const login = (value = '1234', headers: HeadersInit = baseHeaders, accountId = owner) => call('login', 'POST', { accountId, password: value }, undefined, headers)
const changePassword = (token: string, value = password, accountId = owner) => call('password', 'POST', { accountId, password: value }, token)
const editBody = (overrides: Record<string, unknown> = {}) => ({ accountId: owner, operationId: crypto.randomUUID(), expectedRevision: 0,
  name: 'ชื่อกลางที่แก้แล้ว', brand: 'แบรนด์ใหม่', packageSize: '1 ลิตร', unit: 'ขวด', category: 'อาหาร', ...overrides })
const edit = (token: string, body: unknown = editBody(), id = product, headers: HeadersInit = baseHeaders) => call(`products/${id}`, 'PATCH', body, token, headers)
async function unlock(): Promise<Session> {
  const initial = await login(); expect(initial.status).toBe(200)
  const bootstrap = (await json<Session>(initial)).data
  const changed = await changePassword(bootstrap.token); expect(changed.status).toBe(200)
  return (await json<Session>(changed)).data
}
let initialHash = ''
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  initialHash = await adminPasswordHash('1234', salt)
})
beforeEach(async () => {
  for (const [id, token] of [[owner, googleToken], [member, memberToken]]) {
    await env.DB.prepare('INSERT INTO users(id,primary_email) VALUES (?,?)').bind(id, `${id}@example.test`).run()
    await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .bind(`${id}-session`, id, await adminSha(token), '2099-01-01T00:00:00.000Z').run()
  }
  await env.DB.prepare(`INSERT INTO admin_accounts(user_id,password_hash,password_salt,password_iterations,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).bind(owner, initialHash, salt, ADMIN_PASSWORD_ITERATIONS, '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z').run()
  await env.DB.prepare('INSERT INTO products(id,sku,upc,name,brand,package_size,unit,category) VALUES (?,?,?,?,?,?,?,?)')
    .bind(product, 'IMG-ADMIN', '8851959129012', 'ชื่อกลางเดิม', 'แบรนด์เดิม', '1 ล.', 'ชิ้น', 'ของใช้').run()
})

describe('owner-only administrator authentication', () => {
  it('requires Google sign-in and exposes only eligibility to signed-in accounts', async () => {
    expect((await call('status', 'GET', undefined, undefined, {})).status).toBe(401)
    expect((await json<{ eligible: boolean }>(await call('status'))).data).toEqual({ eligible: true })
    expect((await json<{ eligible: boolean }>(await call('status', 'GET', undefined, undefined, { ...baseHeaders, Authorization: `Bearer ${memberToken}` }))).data).toEqual({ eligible: false })
    expect((await login('1234', {}, owner)).status).toBe(401)
    const denied = await login('1234', { ...baseHeaders, Authorization: `Bearer ${memberToken}` }, member)
    expect(denied.status).toBe(403)
    expect((await json<never>(denied)).error?.code).toBe('ADMIN_FORBIDDEN')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_accounts').first('n')).toBe(1)
  })
  it('does not accept an owner accountId supplied with a different Google account', async () => {
    const response = await login('1234', { ...baseHeaders, Authorization: `Bearer ${memberToken}` })
    expect(response.status).toBe(403)
    expect((await json<never>(response)).error?.code).toBe('ADMIN_ACCOUNT_MISMATCH')
    expect(await env.DB.prepare('SELECT login_attempts FROM admin_accounts WHERE user_id = ?').bind(owner).first('login_attempts')).toBe(0)
  })
  it('rejects missing and foreign Origin before starting an admin login', async () => {
    for (const origin of [null, 'https://evil.example']) {
      const headers = new Headers(baseHeaders); headers.delete('Origin'); if (origin) headers.set('Origin', origin)
      expect((await login('1234', headers)).status).toBe(403)
    }
    expect(await env.DB.prepare('SELECT login_attempts FROM admin_accounts WHERE user_id = ?').bind(owner).first('login_attempts')).toBe(0)
  })
  it('requires changing the bootstrap password before every catalog route', async () => {
    const response = await login(), raw = await response.text(), session = (JSON.parse(raw) as Envelope<Session>).data
    expect(response.status).toBe(200)
    expect(session.mustChangePassword).toBe(true)
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(session.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000)
    for (const [path, method, body] of [['products', 'GET', undefined], [`products/${product}`, 'GET', undefined], [`products/${product}`, 'PATCH', editBody()]] as const) {
      const denied = await call(path, method, body, session.token)
      expect(denied.status).toBe(403)
      expect((await json<never>(denied)).error?.code).toBe('ADMIN_PASSWORD_CHANGE_REQUIRED')
    }
    expect(raw).not.toContain(initialHash); expect(raw).not.toContain(salt); expect(raw).not.toContain('password_hash')
    expect(await env.DB.prepare('SELECT token_hash FROM admin_sessions').first('token_hash')).toBe(await adminSha(session.token))
  })
  it('rejects weak, malformed, too-long and mismatched password-change bodies', async () => {
    const session = (await json<Session>(await login())).data
    for (const value of ['1234', '       x', 'aaaaaaaa', 'x'.repeat(129), 'abcd\nefgh']) {
      const denied = await changePassword(session.token, value)
      expect(denied.status).toBe(400)
    }
    expect((await changePassword(session.token, password, member)).status).toBe(403)
    expect((await call('password', 'POST', { accountId: owner, password, mustChangePassword: false }, session.token)).status).toBe(400)
    expect(await env.DB.prepare('SELECT must_change_password FROM admin_accounts').first('must_change_password')).toBe(1)
  })
  it('rotates the hash and every old admin token without changing ordinary Google sessions', async () => {
    const first = (await json<Session>(await login())).data, second = (await json<Session>(await login())).data
    const changed = (await json<Session>(await changePassword(first.token))).data
    expect(changed.mustChangePassword).toBe(false); expect(changed.token).not.toBe(first.token)
    expect(Date.parse(changed.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000)
    for (const token of [first.token, second.token]) expect((await call('products', 'GET', undefined, token)).status).toBe(403)
    expect((await call('products', 'GET', undefined, changed.token)).status).toBe(200)
    expect((await login('1234')).status).toBe(401)
    expect((await login(password)).status).toBe(200)
    const row = await env.DB.prepare('SELECT password_hash,password_salt,must_change_password,credential_revision FROM admin_accounts').first()
    expect(row).toMatchObject({ must_change_password: 0, credential_revision: 2 })
    expect(row?.password_hash).not.toBe(initialHash); expect(row?.password_salt).not.toBe(salt)
    expect(await env.DB.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').bind(`${owner}-session`).first('revoked_at')).toBeNull()
    expect((await changePassword(changed.token, password)).status).toBe(400)
  })
  it('atomically allows at most five concurrent attempts per fifteen-minute window', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => login('wrong-password')))
    expect(responses.filter(r => r.status === 401)).toHaveLength(5)
    expect(responses.filter(r => r.status === 429)).toHaveLength(3)
    expect(await env.DB.prepare('SELECT login_attempts FROM admin_accounts').first('login_attempts')).toBe(5)
    expect((await login()).status).toBe(429)
    await env.DB.prepare('UPDATE admin_accounts SET login_window_start = ? WHERE user_id = ?').bind(Date.now() - 16 * 60_000, owner).run()
    expect((await login()).status).toBe(200)
    expect(await env.DB.prepare('SELECT login_attempts FROM admin_accounts').first('login_attempts')).toBe(1)
  })
  it('also counts successful logins rather than resetting the attempt budget', async () => {
    expect((await login()).status).toBe(200)
    for (let index = 0; index < 4; index += 1) expect((await login('wrong-password')).status).toBe(401)
    expect((await login()).status).toBe(429)
  })
  it('binds the admin token to the same underlying Google session', async () => {
    const session = await unlock()
    await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .bind('second-owner-session', owner, await adminSha(secondGoogleToken), '2099-01-01T00:00:00.000Z').run()
    expect((await call('products', 'GET', undefined, session.token, { ...baseHeaders, Authorization: `Bearer ${secondGoogleToken}` })).status).toBe(403)
    expect((await call('products', 'GET', undefined, session.token, { ...baseHeaders, Authorization: `Bearer ${memberToken}` })).status).toBe(403)
    expect((await call('products', 'GET', undefined, session.token)).status).toBe(200)
  })
  it('rejects expired admin sessions and revoked Google sessions', async () => {
    const session = await unlock()
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?').bind('2000-01-01T00:00:00.000Z', await adminSha(session.token)).run()
    expect((await call('products', 'GET', undefined, session.token)).status).toBe(403)
    const next = (await json<Session>(await login(password))).data
    const logout = await SELF.fetch('https://example.test/auth/logout', { method: 'POST', headers: baseHeaders })
    expect(logout.status).toBe(200)
    expect((await call('products', 'GET', undefined, next.token)).status).toBe(401)
  })
  it('revokes only admin access on admin logout', async () => {
    const session = await unlock()
    expect((await call('logout', 'POST', undefined, session.token)).status).toBe(200)
    expect((await call('products', 'GET', undefined, session.token)).status).toBe(403)
    expect((await call('status')).status).toBe(200)
    expect(await env.DB.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').bind(`${owner}-session`).first('revoked_at')).toBeNull()
  })
  it('rejects forged tokens and bounds JSON input without persisting a session', async () => {
    for (const token of ['x'.repeat(64), 'f'.repeat(43), 'f'.repeat(1000)]) expect((await call('products', 'GET', undefined, token)).status).toBe(403)
    for (const body of [null, [], { accountId: owner, password: 'x'.repeat(11_000) }, { accountId: owner, password: '1234', role: 'admin' }]) expect((await call('login', 'POST', body)).status).toBe(400)
    const malformed = await SELF.fetch('https://example.test/api/v1/admin/login', { method: 'POST', headers: baseHeaders, body: '{' })
    expect(malformed.status).toBe(400)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first('n')).toBe(0)
  })
})

describe('system-wide admin catalog', () => {
  it('includes products never purchased and returns metadata without account or credential records', async () => {
    const session = await unlock(), response = await call('products', 'GET', undefined, session.token), raw = await response.text()
    const page = (JSON.parse(raw) as Envelope<Page>).data
    expect(response.status).toBe(200)
    expect(page.total).toBe(1); expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ id: product, sku: 'IMG-ADMIN', upc: '8851959129012', name: 'ชื่อกลางเดิม', revision: 0 })
    for (const hidden of ['password_hash', 'password_salt', initialHash, 'token_hash', `${owner}@example.test`, 'auth_session_id']) expect(raw).not.toContain(hidden)
    const detail = await json<Product>(await call(`products/${product}`, 'GET', undefined, session.token))
    expect(detail.data).toMatchObject({ id: product, name: 'ชื่อกลางเดิม', revision: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases').first('n')).toBe(0)
  })
  it('pages through all products without repeating IDs and supports metadata and barcode search', async () => {
    const session = await unlock()
    await env.DB.batch(Array.from({ length: 35 }, (_, index) => env.DB.prepare('INSERT INTO products(id,sku,name,brand) VALUES (?,?,?,?)')
      .bind(`admin-extra-${String(index).padStart(2, '0')}`, `EXTRA-${index}`, `สินค้าทดสอบ ${index}`, 'ยี่ห้อค้นหา')))
    let cursor: string | null = null
    const ids: string[] = []
    do {
      const page: Page = (await json<Page>(await call(`products${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, session.token))).data
      expect(page.total).toBe(36); expect(page.items.length).toBeLessThanOrEqual(30)
      ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor
      expect(ids.length).toBeLessThanOrEqual(36)
    } while (cursor)
    expect(new Set(ids).size).toBe(36); expect(ids).toContain(product)
    for (const q of ['IMG-ADMIN', '8851959129012', 'ชื่อกลางเดิม']) {
      const page = (await json<Page>(await call(`products?q=${encodeURIComponent(q)}`, 'GET', undefined, session.token))).data
      expect(page.items.map(item => item.id)).toContain(product)
    }
    const brand = (await json<Page>(await call(`products?q=${encodeURIComponent('ยี่ห้อค้นหา')}`, 'GET', undefined, session.token))).data
    expect(brand.total).toBe(35)
  })
  it('rejects oversized or malformed queries and cursors', async () => {
    const session = await unlock()
    for (const query of [`q=${'x'.repeat(81)}`, 'cursor=not-a-valid-cursor', `cursor=${'a'.repeat(1000)}`, 'limit=1000', 'q=one&q=two', 'cursor=']) {
      expect((await call(`products?${query}`, 'GET', undefined, session.token)).status).toBe(400)
    }
  })
  it('changes canonical metadata for every user, with a UUID receipt and before/after audit', async () => {
    const session = await unlock(), payload = editBody(), response = await edit(session.token, payload)
    expect(response.status).toBe(200)
    expect((await json<Receipt>(response)).data).toEqual({ operationId: payload.operationId, productId: product, revision: 1 })
    const detail = (await json<Product>(await call(`products/${product}`, 'GET', undefined, session.token))).data
    expect(detail).toMatchObject({ name: payload.name, brand: payload.brand, packageSize: payload.packageSize, unit: payload.unit, category: payload.category, revision: 1 })
    const publicProduct = await SELF.fetch('https://example.test/api/v1/products/upc/8851959129012?databaseOnly=1')
    expect((await json<Product>(publicProduct)).data.name).toBe(payload.name)
    const audit = await env.DB.prepare('SELECT user_id,before_json,after_json,result_revision FROM admin_catalog_mutations').first<{ user_id: string; before_json: string; after_json: string; result_revision: number }>()
    expect(audit?.user_id).toBe(owner); expect(audit?.result_revision).toBe(1)
    expect(JSON.parse(audit!.before_json)).toMatchObject({ name: 'ชื่อกลางเดิม' })
    expect(JSON.parse(audit!.after_json)).toMatchObject({ name: payload.name })
  })
  it('can deliberately clear optional fields and normalizes whitespace', async () => {
    const session = await unlock()
    expect((await edit(session.token, editBody({ name: '  ชื่อใหม่  ', brand: null, packageSize: '', unit: null, category: null }))).status).toBe(200)
    expect((await json<Product>(await call(`products/${product}`, 'GET', undefined, session.token))).data)
      .toMatchObject({ name: 'ชื่อใหม่', brand: null, packageSize: null, unit: null, category: null })
  })
  it('replays the same operation even after a newer edit without reverting the newer metadata', async () => {
    const session = await unlock(), first = editBody()
    const original = (await json<Receipt>(await edit(session.token, first))).data
    expect((await json<Receipt>(await edit(session.token, { ...first, operationId: first.operationId.toUpperCase() }))).data).toEqual(original)
    expect((await edit(session.token, editBody({ expectedRevision: 1, name: 'ล่าสุด' }))).status).toBe(200)
    expect((await json<Receipt>(await edit(session.token, first))).data).toEqual(original)
    expect((await json<Product>(await call(`products/${product}`, 'GET', undefined, session.token))).data).toMatchObject({ name: 'ล่าสุด', revision: 2 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(2)
  })
  it('rejects a changed payload under the same UUID and stale revisions', async () => {
    const session = await unlock(), first = editBody(); await edit(session.token, first)
    const changed = await edit(session.token, { ...first, name: 'ขอเปลี่ยน UUID เดิม' })
    expect(changed.status).toBe(409); expect((await json<never>(changed)).error?.code).toBe('OPERATION_CONFLICT')
    const stale = await edit(session.token, editBody())
    expect(stale.status).toBe(409); expect((await json<never>(stale)).error?.code).toBe('PRODUCT_CONFLICT')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(1)
  })
  it('serializes simultaneous edits and deduplicates simultaneous retries', async () => {
    const session = await unlock(), first = editBody()
    expect((await Promise.all([edit(session.token, first), edit(session.token, first)])).map(r => r.status)).toEqual([200, 200])
    const results = await Promise.all([edit(session.token, editBody({ expectedRevision: 1, name: 'A' })), edit(session.token, editBody({ expectedRevision: 1, name: 'B' }))])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(2)
    expect(await env.DB.prepare('SELECT catalog_revision FROM products WHERE id = ?').bind(product).first('catalog_revision')).toBe(2)
  })
  it('keeps product identity and other users personal profiles unchanged', async () => {
    const session = await unlock()
    await env.DB.prepare(`INSERT INTO product_profiles(user_id,product_id,name,brand,package_size,unit,category,revision,last_operation_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(member, product, 'ชื่อส่วนตัว', 'ส่วนตัว', 'ขนาดส่วนตัว', 'หน่วยส่วนตัว', 'หมวดส่วนตัว', 1, crypto.randomUUID(), new Date().toISOString()).run()
    const before = await env.DB.prepare('SELECT * FROM product_profiles').first()
    await edit(session.token)
    expect(await env.DB.prepare('SELECT * FROM product_profiles').first()).toEqual(before)
    expect(await env.DB.prepare('SELECT sku,upc FROM products WHERE id = ?').bind(product).first()).toEqual({ sku: 'IMG-ADMIN', upc: '8851959129012' })
  })
  it('does not rewrite purchase totals or immutable paid-round snapshots', async () => {
    const session = await unlock(), roundId = crypto.randomUUID(), purchaseId = crypto.randomUUID()
    await env.DB.prepare(`INSERT INTO shopping_rounds(id,user_id,payload_hash,checked_out_at,payment_method,total_minor,line_count,created_at)
      VALUES (?,?,? ,?,'cash',5000,1,?)`).bind(roundId, member, 'f'.repeat(64), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z').run()
    await env.DB.prepare(`INSERT INTO purchases(id,user_id,product_id,unit_price_minor,quantity,total_minor,purchased_at,shopping_round_id)
      VALUES (?,?,?,5000,1,5000,?,?)`).bind(purchaseId, member, product, '2026-10-01T00:00:00.000Z', roundId).run()
    await env.DB.prepare(`INSERT INTO shopping_round_lines(round_id,position,purchase_id,product_id,product_name,product_sku,product_upc,package_size,unit_price_minor,quantity,total_minor)
      VALUES (?,0,?,?,?,'IMG-ADMIN','8851959129012','1 ล.',5000,1,5000)`).bind(roundId, purchaseId, product, 'ชื่อเก็บ ณ วันที่ซื้อ').run()
    const purchaseBefore = await env.DB.prepare('SELECT * FROM purchases').first(), roundBefore = await env.DB.prepare('SELECT * FROM shopping_rounds').first(), lineBefore = await env.DB.prepare('SELECT * FROM shopping_round_lines').first()
    expect((await edit(session.token)).status).toBe(200)
    expect(await env.DB.prepare('SELECT * FROM purchases').first()).toEqual(purchaseBefore)
    expect(await env.DB.prepare('SELECT * FROM shopping_rounds').first()).toEqual(roundBefore)
    expect(await env.DB.prepare('SELECT * FROM shopping_round_lines').first()).toEqual(lineBefore)
  })
  it('rejects immutable keys, invalid field types, oversized data and wrong account ownership', async () => {
    const session = await unlock()
    for (const changed of [{ sku: 'REPLACED' }, { upc: '8851959129013' }, { imageUrl: 'https://evil.example/x' }, { name: '' }, { name: 'x'.repeat(201) }, { brand: 12 }, { unit: 'x'.repeat(41) }, { category: 'bad\u0000value' }, { expectedRevision: -1 }, { operationId: 'not-a-uuid' }]) {
      expect((await edit(session.token, editBody(changed))).status).toBe(400)
    }
    expect((await edit(session.token, editBody({ accountId: member }))).status).toBe(403)
    expect((await edit(session.token, editBody(), 'not-found')).status).toBe(404)
    expect(await env.DB.prepare('SELECT catalog_revision FROM products').first('catalog_revision')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(0)
  })
  it('requires the app Origin for password changes, catalog edits and admin logout', async () => {
    const session = await unlock()
    for (const origin of [null, 'https://evil.example']) {
      const headers = new Headers(baseHeaders); headers.delete('Origin'); if (origin) headers.set('Origin', origin)
      expect((await edit(session.token, editBody(), product, headers)).status).toBe(403)
      expect((await call('password', 'POST', { accountId: owner, password: 'Another-password!' }, session.token, headers)).status).toBe(403)
      expect((await call('logout', 'POST', undefined, session.token, headers)).status).toBe(403)
    }
    expect((await call('products', 'GET', undefined, session.token)).status).toBe(200)
    expect(await env.DB.prepare('SELECT catalog_revision FROM products').first('catalog_revision')).toBe(0)
  })
})

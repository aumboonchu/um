import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminProduct } from '../src/admin-client'
const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/auth-client', () => ({ apiFetch: transport.send }))
const account = 'admin-unit-owner', token = 't'.repeat(43)
const product: AdminProduct = { id: 'unit-product', sku: 'IMG-UNIT', upc: null, name: 'สินค้า', brand: null, packageSize: null, unit: null,
  category: null, imageUrl: null, source: 'manual', sourceProductId: null, sourceUrl: null, createdAt: '2026-10-01', updatedAt: '2026-10-01', revision: 2 }
let data: Map<string, string>, local: Storage
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  vi.resetModules(); transport.send.mockReset(); data = new Map()
  local = { get length() { return data.size }, key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) }, clear: () => data.clear() }
  vi.stubGlobal('localStorage', local)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('admin request and mutation safeguards', () => {
  it.each(['INVALID_JPEG', 'HASH_MISMATCH', 'JPEG_METADATA', 'IMAGE_TOO_LARGE'])('retains only safe image rejection diagnostics: %s', async reason => {
    const { adminRequest, adminMessage } = await import('../src/admin-client')
    const code = reason === 'IMAGE_TOO_LARGE' ? 'PRODUCT_IMAGE_TOO_LARGE' : 'PRODUCT_IMAGE_INVALID'
    const status = reason === 'IMAGE_TOO_LARGE' ? 413 : 400
    transport.send.mockResolvedValue(new Response(JSON.stringify({ error: { code, reason, message: 'RAW IMAGE secret /9j/should-not-render' } }), { status }))
    const error = await adminRequest('', '/products/unit-product/image', token, { method: 'PATCH', body: '{}' }).catch(e => e)
    expect(error).toMatchObject({ code, status, reason })
    expect(adminMessage(error)).toContain(`${code} / ${reason}`)
    expect(adminMessage(error)).not.toContain('secret')
    expect(adminMessage(error)).not.toContain('/9j/')
  })
  it.each(['UNKNOWN_NEW_REASON', { original: 'secret' }, 'INVALID_JPEG\n/9j/secret', null])('treats a supplied unrecognized image reason as an unconfirmed response: %j', async reason => {
    const { adminRequest, adminMessage, AdminError } = await import('../src/admin-client')
    transport.send.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'PRODUCT_IMAGE_INVALID', reason, message: 'secret' } }), { status: 400 }))
    const error = await adminRequest('', '/products/unit-product/image', token, { method: 'PATCH', body: '{}' }).catch(e => e)
    if (!(error instanceof AdminError)) throw new Error('Expected a sanitized admin error')
    expect(error).toMatchObject({ code: 'ADMIN_RESPONSE_INVALID', status: 400 })
    expect(error.reason).toBeUndefined()
    expect(adminMessage(error)).not.toContain('secret')
  })
  it('keeps legacy image errors without a reason compatible, and ignores unsafe error codes', async () => {
    const { adminRequest, adminMessage, AdminError } = await import('../src/admin-client')
    transport.send.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'PRODUCT_IMAGE_INVALID' } }), { status: 400 }))
    const old = await adminRequest('', '/products/unit-product/image').catch(e => e)
    expect(old).toMatchObject({ code: 'PRODUCT_IMAGE_INVALID', status: 400 })
    expect(adminMessage(old)).toContain('ระบบตรวจไฟล์รูปไม่ผ่าน')
    transport.send.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'secret /9j/bytes', reason: 'secret' } }), { status: 400 }))
    const malformed = await adminRequest('', '/products/unit-product/image').catch(e => e)
    if (!(malformed instanceof AdminError)) throw new Error('Expected a sanitized admin error')
    expect(malformed.code).toBe('ADMIN_REQUEST_FAILED')
    expect(malformed.reason).toBeUndefined()
  })
  it('times out a stalled request after 20 seconds and aborts its network signal', async () => {
    vi.useFakeTimers(); transport.send.mockImplementation(() => new Promise(() => {}))
    const { adminRequest } = await import('../src/admin-client')
    const request = adminRequest('', '/products', token)
    const rejection = expect(request).rejects.toMatchObject({ code: 'ADMIN_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(20_000); await rejection
    expect(transport.send.mock.calls[0][2].signal.aborted).toBe(true)
    expect(new Headers(transport.send.mock.calls[0][2].headers).get('X-SmartCart-Admin')).toBe(token)
  })
  it('persists the owner-bound UUID before writing, keeps it until confirmed cleanup, and never stores the admin token', async () => {
    const client = await import('../src/admin-client'), attempt = client.createAdminEdit(account, product, client.adminFields(product))
    transport.send.mockImplementation(async () => {
      expect(client.readAdminEdit(account)).toEqual(attempt)
      return json({ data: { operationId: attempt.payload.operationId, productId: product.id, revision: 3 } })
    })
    await client.sendAdminEdit('', token, account, attempt)
    expect(client.readAdminEdit(account)).toEqual(attempt)
    expect(client.readAdminEdit('another-account')).toBeNull()
    expect([...data.values()].join()).not.toContain(token)
    client.clearAdminEdit(account, attempt); expect(data.size).toBe(0)
  })
  it('refuses a new UUID while a different frozen mutation is awaiting confirmation', async () => {
    const client = await import('../src/admin-client'), fields = client.adminFields(product)
    const first = client.createAdminEdit(account, product, fields), second = client.createAdminEdit(account, product, { ...fields, name: 'changed' })
    client.persistAdminEdit(account, first)
    await expect(client.sendAdminEdit('', token, account, second)).rejects.toMatchObject({ code: 'ADMIN_STORAGE_BLOCKED' })
    expect(transport.send).not.toHaveBeenCalled(); expect(client.readAdminEdit(account)).toEqual(first)
  })
  it('sends no mutation if durable pending storage cannot be verified', async () => {
    const client = await import('../src/admin-client'), attempt = client.createAdminEdit(account, product, client.adminFields(product))
    local.setItem = () => {}
    await expect(client.sendAdminEdit('', token, account, attempt)).rejects.toMatchObject({ code: 'ADMIN_STORAGE_BLOCKED' })
    expect(transport.send).not.toHaveBeenCalled()
  })
  it.each(['get', 'set'])('classifies native storage %s denials before any server mutation', async operation => {
    const client = await import('../src/admin-client'), attempt = client.createAdminEdit(account, product, client.adminFields(product))
    if (operation === 'get') local.getItem = () => { throw new DOMException('denied', 'SecurityError') }
    else local.setItem = () => { throw new DOMException('denied', 'QuotaExceededError') }
    await expect(client.sendAdminEdit('', token, account, attempt)).rejects.toMatchObject({ code: 'ADMIN_STORAGE_BLOCKED' })
    expect(transport.send).not.toHaveBeenCalled()
  })
  it('does not treat mismatched acknowledgement as a successful save or discard the pending UUID', async () => {
    const client = await import('../src/admin-client'), attempt = client.createAdminEdit(account, product, client.adminFields(product))
    transport.send.mockResolvedValue(json({ data: { operationId: crypto.randomUUID(), productId: product.id, revision: 3 } }))
    await expect(client.sendAdminEdit('', token, account, attempt)).rejects.toMatchObject({ code: 'ADMIN_RESPONSE_INVALID' })
    expect(client.readAdminEdit(account)).toEqual(attempt)
  })
  it('keeps unrecognized replies and operation conflicts uncertain instead of permitting a replacement write', async () => {
    const client = await import('../src/admin-client')
    expect(client.definiteAdminEditError(new client.AdminError('OPERATION_CONFLICT', 409))).toBe(false)
    expect(client.definiteAdminEditError(new client.AdminError('ADMIN_RESPONSE_INVALID', 400))).toBe(false)
    expect(client.definiteAdminEditError(new client.AdminError('PRODUCT_CONFLICT', 409))).toBe(true)
  })
  it('queries only the documented search/cursor keys and accepts validated catalog details', async () => {
    const { adminList } = await import('../src/admin-client')
    transport.send.mockResolvedValue(json({ data: { items: [product], nextCursor: 'opaque+/', total: 1 } }))
    const result = await adminList('', token, 'น้ำ', 'cursor+/')
    const destination = new URL(transport.send.mock.calls[0][1], 'https://example.test')
    expect([...destination.searchParams.keys()].sort()).toEqual(['cursor', 'q'])
    expect(destination.searchParams.get('cursor')).toBe('cursor+/'); expect(result.items[0].sku).toBe('IMG-UNIT')
  })
})

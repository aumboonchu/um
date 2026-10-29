import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createProductEdit, loadProductEdit, productFields, sendProductEdit } from '../src/product-edit'

const account = 'edit-account', id = 'edit-product'
const fields = { name: 'ชื่อแก้ไข', brand: 'แบรนด์', packageSize: '1 ลิตร', unit: 'ขวด', category: 'อาหาร' }
function store() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, values }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const success = (a: ReturnType<typeof createProductEdit>) => json({ data: { productId: a.productId, operationId: a.payload.operationId, profileRevision: a.payload.expectedRevision + 1 } })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('safe product detail changes', () => {
  it('opts in to personalized product responses only from the account-cache-aware client', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ data: {} }))
    vi.stubGlobal('fetch', fetcher)
    const { apiFetch } = await import('../src/auth-client')
    await apiFetch('https://api.example.test', '/api/v1/products/edit-product/detail')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-SmartCart-Profile')).toBe('1')
    await apiFetch('https://api.example.test', '/api/v1/health')
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('X-SmartCart-Profile')).toBe(false)
  })
  it('normalizes nullable fields and freezes the owner-bound identity without permitting SKU/UPC edits', () => {
    const attempt = createProductEdit(account, id, 0, { ...fields, name: '  ชื่อแก้ไข  ', unit: '' })
    expect(attempt.payload).toMatchObject({ accountId: account, expectedRevision: 0, name: 'ชื่อแก้ไข', unit: null })
    expect(Object.isFrozen(attempt.payload)).toBe(true)
    expect(Object.isFrozen(attempt)).toBe(true)
    expect(attempt.payload).not.toHaveProperty('sku')
    expect(attempt.payload).not.toHaveProperty('upc')
    expect(productFields(attempt.payload).unit).toBe('')
  })
  it.each([{ ...fields, name: '' }, { ...fields, name: 'x'.repeat(201) }, { ...fields, brand: 'x'.repeat(101) }, { ...fields, unit: 'x'.repeat(41) }, { ...fields, name: 'bad\u0000text' }])('validates fields before creating a request %#', value => {
    expect(() => createProductEdit(account, id, 0, value)).toThrow('INVALID_PRODUCT_CHANGE')
  })
  it('persists before sending and removes only the matching receipt after a valid acknowledgement', async () => {
    const storage = store(), attempt = createProductEdit(account, id, 0, fields)
    const send = vi.fn(async (init: RequestInit) => {
      expect(loadProductEdit(account, id, storage)).toEqual(attempt)
      expect(init.method).toBe('PATCH')
      return success(attempt)
    })
    expect(await sendProductEdit(account, attempt, send, { storage })).toEqual({ status: 'success', cleanupPending: false })
    expect(loadProductEdit(account, id, storage)).toBeNull()
  })
  it('keeps exactly the same UUID and payload across a lost response and remount', async () => {
    const storage = store(), attempt = createProductEdit(account, id, 3, fields), sent: string[] = []
    const send = vi.fn(async (init: RequestInit) => { sent.push(String(init.body)); if (sent.length === 1) throw new TypeError('lost'); return success(attempt) })
    expect(await sendProductEdit(account, attempt, send, { storage })).toMatchObject({ status: 'uncertain' })
    const restored = loadProductEdit(account, id, storage)!
    expect(await sendProductEdit(account, restored, send, { storage })).toMatchObject({ status: 'success' })
    expect(sent[1]).toBe(sent[0])
  })
  it('does not send when storage is blocked or a pending UUID would be replaced', async () => {
    const storage = store(), first = createProductEdit(account, id, 0, fields), send = vi.fn(async () => { throw new TypeError('lost') })
    await sendProductEdit(account, first, send, { storage })
    send.mockClear()
    expect(await sendProductEdit(account, createProductEdit(account, id, 0, fields), send, { storage })).toMatchObject({ status: 'blocked' })
    expect(loadProductEdit(account, id, storage)).toEqual(first)
    storage.setItem = () => { throw new Error('quota') }
    expect(await sendProductEdit(account, first, send, { storage })).toMatchObject({ status: 'blocked' })
    expect(send).not.toHaveBeenCalled()
  })
  it('rejects cross-account sends and never opens another account pending request', async () => {
    const storage = store(), attempt = createProductEdit(account, id, 0, fields), send = vi.fn()
    expect(await sendProductEdit('other', attempt, send, { storage })).toMatchObject({ status: 'blocked' })
    expect(send).not.toHaveBeenCalled()
    await sendProductEdit(account, attempt, async () => { throw new Error('lost') }, { storage })
    expect(loadProductEdit('other', id, storage)).toBeNull()
  })
  it.each([[401, 'UNAUTHENTICATED'], [403, 'PRODUCT_ACCOUNT_MISMATCH'], [409, 'OPERATION_CONFLICT'], [400, 'UNRECOGNIZED_ERROR'], [503, 'UNAVAILABLE']])('retains uncertain results for status %s / %s', async (status, code) => {
    const storage = store(), attempt = createProductEdit(account, id, 0, fields)
    expect(await sendProductEdit(account, attempt, async () => json({ error: { code } }, Number(status)), { storage })).toMatchObject({ status: 'uncertain' })
    expect(loadProductEdit(account, id, storage)).toEqual(attempt)
  })
  it('clears a definite version conflict, so latest data can be reviewed before a new edit', async () => {
    const storage = store(), attempt = createProductEdit(account, id, 0, fields)
    expect(await sendProductEdit(account, attempt, async () => json({ error: { code: 'PRODUCT_CONFLICT' } }, 409), { storage })).toMatchObject({ status: 'error', code: 'PRODUCT_CONFLICT' })
    expect(loadProductEdit(account, id, storage)).toBeNull()
  })
  it('does not interpret malformed success as confirmation', async () => {
    const storage = store(), attempt = createProductEdit(account, id, 0, fields)
    expect(await sendProductEdit(account, attempt, async () => json({ data: { productId: id, profileRevision: 1 } }), { storage })).toMatchObject({ status: 'uncertain' })
    expect(loadProductEdit(account, id, storage)).toEqual(attempt)
  })
  it('reports a confirmed write even if local receipt cleanup is blocked', async () => {
    const storage = store(), attempt = createProductEdit(account, id, 0, fields)
    storage.removeItem = () => {}
    expect(await sendProductEdit(account, attempt, async () => success(attempt), { storage })).toEqual({ status: 'success', cleanupPending: true })
    expect(loadProductEdit(account, id, storage)).toEqual(attempt)
  })
  it('settles a timeout even if transport ignores abort, retaining the same UUID', async () => {
    vi.useFakeTimers()
    const storage = store(), attempt = createProductEdit(account, id, 0, fields)
    const pending = sendProductEdit(account, attempt, () => new Promise(() => {}), { storage, timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toMatchObject({ status: 'uncertain' })
    expect(loadProductEdit(account, id, storage)).toEqual(attempt)
  })
})

describe('account-scoped product cache', () => {
  beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()) })
  const base = { id, upc: '8851959129012', name: 'ชื่อกลาง', brand: null, packageSize: null, imageUrl: null, source: 'smartcart' as const, sourcePriceMinor: 5000, regularPriceMinor: null, fetchedAt: null }
  it('keeps each account edited details separate and preserves canonical cache fallback', async () => {
    const cache = await import('../src/offline')
    await cache.cacheProduct(base)
    await cache.cacheProduct({ ...base, name: 'ชื่อ A', profileRevision: 1 }, 'A')
    await cache.cacheProduct({ ...base, name: 'ชื่อ B', profileRevision: 2 }, 'B')
    expect((await cache.findCachedProduct(base.upc, 'A'))?.name).toBe('ชื่อ A')
    expect((await cache.findCachedProduct(base.upc, 'B'))?.name).toBe('ชื่อ B')
    expect((await cache.findCachedProduct(base.upc, 'C'))?.name).toBe('ชื่อกลาง')
    expect((await cache.findCachedProduct(base.upc))?.name).toBe('ชื่อกลาง')
  })
  it('refuses to place private details in the shared store and does not modify queued purchases', async () => {
    const cache = await import('../src/offline')
    const operation = await cache.queuePurchase({ productId: id, unitPriceMinor: 5000, quantity: 1, purchasedAt: new Date().toISOString(), storeName: null, note: null })
    await expect(cache.cacheProduct({ ...base, profileRevision: 1 })).rejects.toThrow('PERSONAL_PRODUCT_ACCOUNT_REQUIRED')
    await cache.cacheProduct({ ...base, name: 'ส่วนตัว', profileRevision: 1 }, account)
    expect(await cache.findCachedProduct(base.upc)).toBeNull()
    expect(await cache.getPendingOperationCount()).toBe(1)
    expect(operation.payload.unitPriceMinor).toBe(5000)
  })
})

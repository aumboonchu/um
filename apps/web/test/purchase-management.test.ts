import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HomeSummary, PurchaseFieldInputs } from '../src/AccountViews'
import { createChangeAttempt, fieldsForPurchase, listPendingChanges, loadPendingChange, localDateTime, persistChange, purchaseFieldsPayload, sendChange, type PurchaseDetail, type PurchaseFields } from '../src/purchase-management'

const operationId = '12345678-1234-4123-8123-123456789abc'
const fields: PurchaseFields = { price: '37.00', quantity: '2', purchasedAt: '2026-10-27T10:30:00', storeName: ' ร้านทดสอบ ', note: ' หมายเหตุ ' }
const detail: PurchaseDetail = { id: 'purchase-a', productId: 'product-a', productName: 'สินค้าตัวอย่าง', productSku: 'SC-A', productUpc: null, productBrand: null, imageUrl: null, storeName: 'ร้าน', unitPriceMinor: 3700, quantity: 2, totalMinor: 7400, purchasedAt: '2026-10-27T01:00:00.000Z', note: 'เดิม', revision: 1, updatedAt: '2026-10-27T01:00:00.000Z', packageSize: null }
function storage() { const map = new Map<string, string>(); return { map, get length() { return map.size }, key: (index: number) => [...map.keys()][index] ?? null, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } } }
let store: ReturnType<typeof storage>
beforeEach(() => { store = storage(); vi.stubGlobal('localStorage', store) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const success = (attempt: ReturnType<typeof createChangeAttempt>) => response({ data: { purchaseId: attempt.purchaseId, action: attempt.action, operationId: attempt.payload.operationId, revision: attempt.payload.expectedRevision + 1 } })

describe('shared purchase form', () => {
  it('converts baht to integer satang, keeps fractional quantity, optional text, and local time', () => {
    expect(purchaseFieldsPayload(fields)).toEqual({ unitPriceMinor: 3700, quantity: 2, purchasedAt: new Date(fields.purchasedAt).toISOString(), storeName: 'ร้านทดสอบ', note: 'หมายเหตุ' })
    expect(purchaseFieldsPayload({ ...fields, price: '1,234.50', quantity: '1.5', storeName: '', note: '' })).toMatchObject({ unitPriceMinor: 123450, quantity: 1.5, storeName: null, note: null })
  })
  it('pre-fills every editable field and round-trips the local timestamp', () => {
    const prepared = fieldsForPurchase(detail)
    expect(prepared).toMatchObject({ price: '37.00', quantity: '2', storeName: 'ร้าน', note: 'เดิม' })
    expect(purchaseFieldsPayload(prepared).purchasedAt).toBe(detail.purchasedAt)
    expect(localDateTime(detail.purchasedAt)).toBe(prepared.purchasedAt)
  })
  it.each([{ price: '-1' }, { price: '12.345' }, { price: '1,2' }, { price: '1e3' }, { quantity: '0' }, { quantity: 'Infinity' }, { quantity: '10001' }, { quantity: '.00000001', price: '.01' }, { purchasedAt: 'invalid' }, { storeName: 'x'.repeat(81) }, { note: 'x'.repeat(501) }])('rejects invalid input %#', (changes) => { expect(() => purchaseFieldsPayload({ ...fields, ...changes })).toThrow() })
  it('uses the shared fields for price, quantity, date, store, and note with accessible labels', () => {
    const html = renderToStaticMarkup(createElement(PurchaseFieldInputs, { fields, onChange: vi.fn(), disabled: true }))
    expect(html).toContain('datetime-local'); expect(html).toContain('หมายเหตุ'); expect(html).toContain('disabled=""')
    expect(html).not.toContain('ยืนยันลบ')
  })
})

describe('durable edit/delete operations', () => {
  it('freezes the operation UUID, expected revision, and user-confirmed fields', () => {
    const attempt = createChangeAttempt('purchase-a', 3, fields, operationId)
    expect(attempt.action).toBe('edit'); expect(attempt.payload.expectedRevision).toBe(3)
    expect(Object.isFrozen(attempt.payload)).toBe(true)
    expect(() => { (attempt.payload as { quantity: number }).quantity = 9 }).toThrow()
  })
  it('restores across refresh and isolates accounts and purchase ids', () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    persistChange('account-a', attempt)
    expect(loadPendingChange('account-a', 'purchase-a')).toEqual(attempt)
    expect(loadPendingChange('account-b', 'purchase-a')).toBeNull()
    expect(listPendingChanges('account-a')).toEqual([attempt]); expect(listPendingChanges('account-b')).toEqual([])
  })
  it('does not replace a pending operation with a new UUID or changed fields', () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId); persistChange('account-a', attempt)
    expect(() => persistChange('account-a', createChangeAttempt('purchase-a', 1, fields))).toThrow()
    expect(() => persistChange('account-a', createChangeAttempt('purchase-a', 1, { ...fields, quantity: '9' }, operationId))).toThrow()
  })
  it('never sends a request if its UUID cannot be stored/read back', async () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    vi.stubGlobal('localStorage', { ...store, setItem() { throw new Error('quota') } })
    const send = vi.fn()
    expect(await sendChange('account-a', attempt, send)).toMatchObject({ status: 'blocked' })
    expect(send).not.toHaveBeenCalled()
  })
  it('keeps exactly the same request after an uncertain save then clears only its confirmed receipt', async () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(success(attempt))
    expect((await sendChange('account-a', attempt, send)).status).toBe('uncertain')
    expect(loadPendingChange('account-a', 'purchase-a')).toEqual(attempt)
    expect(await sendChange('account-a', loadPendingChange('account-a', 'purchase-a')!, send)).toEqual({ status: 'success', cleanupPending: false })
    expect(send.mock.calls[0][0].body).toBe(send.mock.calls[1][0].body)
    expect(loadPendingChange('account-a', 'purchase-a')).toBeNull()
  })
  it('DELETE submits only operation UUID/revision and accepts a matching receipt', async () => {
    const attempt = createChangeAttempt('purchase-a', 1, null, operationId)
    const send = vi.fn<(init: RequestInit) => Promise<Response>>(async () => success(attempt))
    expect((await sendChange('account-a', attempt, send)).status).toBe('success')
    expect(send.mock.calls[0][0].method).toBe('DELETE')
    expect(JSON.parse(String(send.mock.calls[0][0].body))).toEqual({ operationId, expectedRevision: 1 })
  })
  it.each([401, 403, 409, 500])('does not declare rollback or erase a pending UUID after uncertain HTTP %s', async status => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    expect((await sendChange('account-a', attempt, async () => response({ error: { code: status === 409 ? 'OPERATION_CONFLICT' : 'UNKNOWN_ERROR' } }, status))).status).toBe('uncertain')
    expect(loadPendingChange('account-a', 'purchase-a')).toEqual(attempt)
  })
  it('reports stale revision without overwriting and lets the user reload current data', async () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    expect(await sendChange('account-a', attempt, async () => response({ error: { code: 'PURCHASE_CONFLICT' } }, 409))).toMatchObject({ status: 'error', code: 'PURCHASE_CONFLICT' })
    expect(loadPendingChange('account-a', 'purchase-a')).toBeNull()
  })
  it('requires the exact operation, action, purchase id, and resulting revision on a success response', async () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    expect((await sendChange('account-a', attempt, async () => response({ data: { operationId, purchaseId: 'another-purchase', action: 'edit', revision: 2 } }))).status).toBe('uncertain')
    expect(loadPendingChange('account-a', 'purchase-a')).toEqual(attempt)
  })
  it('confirmed D1 success is not called failure if local cleanup cannot complete', async () => {
    const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    vi.stubGlobal('localStorage', { ...store, removeItem() {} })
    expect(await sendChange('account-a', attempt, async () => success(attempt))).toEqual({ status: 'success', cleanupPending: true })
    expect(loadPendingChange('account-a', 'purchase-a')).toEqual(attempt)
  })
  it('bounds waiting even if transport ignores abort and keeps the pending operation', async () => {
    vi.useFakeTimers(); const attempt = createChangeAttempt('purchase-a', 1, fields, operationId)
    const request = sendChange('account-a', attempt, () => new Promise(() => {}), 50)
    await vi.advanceTimersByTimeAsync(50)
    expect((await request).status).toBe('uncertain')
    expect(loadPendingChange('account-a', 'purchase-a')).toEqual(attempt)
  })
  it('refuses corrupt stored requests instead of silently replacing them', async () => {
    persistChange('account-a', createChangeAttempt('purchase-a', 1, fields, operationId))
    store.map.set([...store.map.keys()][0], '{bad')
    const send = vi.fn()
    expect((await sendChange('account-a', createChangeAttempt('purchase-a', 1, fields, operationId), send)).status).toBe('blocked')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('Home initial state', () => {
  it('shows the purpose and sign-in prompt without fabricating totals for a guest', () => {
    const html = renderToStaticMarkup(createElement(HomeSummary, { apiOrigin: 'https://api.example.test', accountId: null, online: true, version: 0, pendingCount: 0, onAdd: vi.fn(), onHistory: vi.fn(), onPurchase: vi.fn() }))
    expect(html).toContain('สรุปค่าใช้จ่าย'); expect(html).toContain('เข้าสู่ระบบด้วย Google'); expect(html).not.toContain('฿0.00')
  })
})

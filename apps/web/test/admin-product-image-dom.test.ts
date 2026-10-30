// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AdminProduct } from '../src/admin-client'
import type { CroppedProductImage } from '../src/product-image-crop'

const transport = vi.hoisted(() => ({ send: vi.fn() }))
const cropped = vi.hoisted(() => ({ data: '/9j/2Q==', sha256: 'f'.repeat(64), width: 64, height: 64 }))
vi.mock('../src/auth-client', () => ({ apiFetch: transport.send }))
vi.mock('../src/ProductImageCropper', () => ({ ProductImageCropper: ({ onConfirm, onCancel, disabled }: { onConfirm: (v: CroppedProductImage) => void; onCancel: () => void; disabled?: boolean }) =>
  createElement('div', null, createElement('button', { disabled, onClick: () => onConfirm(cropped) }, 'ใช้รูปที่ครอป'), createElement('button', { onClick: onCancel }, 'ยกเลิกครอป')) }))
const product: AdminProduct = { id: 'image-product', sku: 'IMG-TEST', name: 'สินค้า', upc: null, brand: null, packageSize: null,
  unit: null, category: null, imageUrl: null, source: 'smartcart', sourceProductId: null, sourceUrl: null, revision: 2, createdAt: '2026-10-30', updatedAt: '2026-10-30' }
const accountId = 'image-owner', token = 'a'.repeat(43)
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
let requests: string[], writes: number, mode: 'ok' | 'lost' | 'conflict' | 'expired' | 'invalid_jpeg' | 'too_large' | 'metadata' | 'malformed_reason' | 'bad_status'
beforeEach(() => {
  vi.resetModules(); localStorage.clear(); requests = []; writes = 0; mode = 'ok'
  const receipts = new Map<string, unknown>()
  transport.send.mockReset().mockImplementation(async (_origin: string, path: string, init: RequestInit) => {
    expect(path).toBe(`/api/v1/admin/products/${product.id}/image`)
    expect(init.method).toBe('PATCH'); expect(new Headers(init.headers).get('X-SmartCart-Admin')).toBe(token)
    const raw = String(init.body), body = JSON.parse(raw); requests.push(raw)
    expect(localStorage.getItem(`smartcart-admin-image-v1:${accountId}`)).toContain(body.operationId)
    if (mode === 'conflict') return json({ error: { code: 'PRODUCT_CONFLICT' } }, 409)
    if (mode === 'expired') return json({ error: { code: 'ADMIN_SESSION_REQUIRED' } }, 403)
    if (mode === 'invalid_jpeg') return json({ error: { code: 'PRODUCT_IMAGE_INVALID', reason: 'INVALID_JPEG', message: '/9j/PRIVATE BYTES' } }, 400)
    if (mode === 'too_large') return json({ error: { code: 'PRODUCT_IMAGE_TOO_LARGE', reason: 'IMAGE_TOO_LARGE' } }, 413)
    if (mode === 'metadata') return json({ error: { code: 'PRODUCT_IMAGE_INVALID', reason: 'JPEG_METADATA' } }, 400)
    if (mode === 'malformed_reason') return json({ error: { code: 'PRODUCT_IMAGE_INVALID', reason: '/9j/PRIVATE BYTES' } }, 400)
    if (mode === 'bad_status') return json({ error: { code: 'PRODUCT_IMAGE_INVALID', reason: 'INVALID_JPEG' } }, 500)
    const old = receipts.get(body.operationId)
    if (old) return json({ data: old })
    const receipt = { operationId: body.operationId, productId: product.id, revision: 3, imageUrl: `https://example.test/api/v1/product-images/${product.id}/${cropped.sha256}.jpg` }
    receipts.set(body.operationId, receipt); writes += 1
    if (mode === 'lost') { mode = 'ok'; throw new Error('reply lost') }
    return json({ data: receipt })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function mount(overrides = {}) {
  const { AdminProductImage } = await import('../src/AdminProductImage')
  const props = { apiOrigin: '', accountId, token, product, online: true, disabled: false, onStateChange: vi.fn(), onSaved: vi.fn(async () => {}), onConflict: vi.fn(), onSessionError: vi.fn(), ...overrides }
  const view = render(createElement(AdminProductImage, props))
  return { props, view, AdminProductImage }
}
function choose() {
  const original = new File(['ORIGINAL SCREENSHOT MUST NOT PERSIST'], 'screenshot.jpg', { type: 'image/jpeg' })
  fireEvent.change(screen.getByLabelText('เลือกรูปสินค้า'), { target: { files: [original] } })
}
describe('admin cropped image upload', () => {
  it.each(['invalid_jpeg', 'too_large', 'metadata'] as const)('shows a safe specific reason and retains the draft for %s', async nextMode => {
    mode = nextMode; const { props } = await mount(); choose(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ยังบันทึกรูปไม่ได้:')
    expect(alert.textContent).toContain(nextMode === 'too_large' ? 'PRODUCT_IMAGE_TOO_LARGE / IMAGE_TOO_LARGE' : nextMode === 'metadata' ? 'PRODUCT_IMAGE_INVALID / JPEG_METADATA' : 'PRODUCT_IMAGE_INVALID / INVALID_JPEG')
    expect(alert.textContent).not.toContain('ครอปใหม่')
    expect(alert.textContent).not.toContain('PRIVATE BYTES')
    await screen.findByRole('button', { name: 'บันทึกรูปสินค้า' })
    expect(screen.getByRole('button', { name: 'ดูรูปสินค้า' })).toBeTruthy()
    expect(localStorage.length).toBe(0)
    expect(writes).toBe(0); expect(props.onSaved).not.toHaveBeenCalled()
  })
  it.each(['malformed_reason', 'bad_status'] as const)('keeps the frozen UUID when the rejection cannot be trusted: %s', async nextMode => {
    mode = nextMode; const { props } = await mount(); choose(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    const retry = await screen.findByRole('button', { name: 'ตรวจสอบรูปด้วยรหัสเดิม' })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    expect(localStorage.getItem(`smartcart-admin-image-v1:${accountId}`)).toContain(cropped.sha256)
    expect(screen.getByRole('alert').textContent).not.toContain('PRIVATE BYTES')
    expect(screen.queryByRole('button', { name: 'บันทึกรูปสินค้า' })).toBeNull()
    expect(writes).toBe(0); expect(props.onSaved).not.toHaveBeenCalled()
    mode = 'ok'; fireEvent.click(retry)
    await screen.findByText('บันทึกรูปสินค้าแล้ว')
    expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0])
  })
  it('only unlocks exact known validation status/code pairs', async () => {
    const { AdminError } = await import('../src/admin-client'), { definiteAdminImageError } = await import('../src/admin-product-image')
    expect(definiteAdminImageError(new AdminError('PRODUCT_IMAGE_INVALID', 400))).toBe(true)
    expect(definiteAdminImageError(new AdminError('PRODUCT_IMAGE_TOO_LARGE', 413))).toBe(true)
    for (const [code, status] of [['PRODUCT_IMAGE_INVALID', 413], ['PRODUCT_IMAGE_TOO_LARGE', 400], ['PRODUCT_CONFLICT', 400], ['PRODUCT_IMAGE_INVALID', 500], ['UNKNOWN', 400]] as const)
      expect(definiteAdminImageError(new AdminError(code, status))).toBe(false)
  })
  it('persists only a confirmed crop and UUID before upload, then refreshes on a validated receipt', async () => {
    const { props } = await mount(); choose()
    expect(transport.send).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    await screen.findByText('บันทึกรูปสินค้าแล้ว')
    expect(JSON.parse(requests[0])).toMatchObject({ accountId, expectedRevision: 2, productImage: cropped })
    expect(requests[0]).not.toContain('ORIGINAL SCREENSHOT')
    expect(localStorage.length).toBe(0); expect(writes).toBe(1); expect(props.onSaved).toHaveBeenCalledOnce()
  })
  it('restores exactly the cropped image and UUID after a lost reply and does not duplicate the write', async () => {
    mode = 'lost'; const first = await mount(); choose(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    const retry = await screen.findByRole('button', { name: 'ตรวจสอบรูปด้วยรหัสเดิม' })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    expect(first.props.onSaved).not.toHaveBeenCalled(); expect(localStorage.getItem(`smartcart-admin-image-v1:${accountId}`)).not.toContain('ORIGINAL SCREENSHOT')
    first.view.unmount(); await mount()
    const restored = await screen.findByRole('button', { name: 'ตรวจสอบรูปด้วยรหัสเดิม' }); fireEvent.click(restored)
    await screen.findByText('บันทึกรูปสินค้าแล้ว')
    expect(requests).toHaveLength(2); expect(requests[1]).toBe(requests[0]); expect(writes).toBe(1)
  })
  it('retains a frozen crop on expired elevation and disables offline upload', async () => {
    mode = 'expired'; const { view, props, AdminProductImage } = await mount(); choose(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    await waitFor(() => expect(props.onSessionError).toHaveBeenCalledOnce())
    expect(localStorage.getItem(`smartcart-admin-image-v1:${accountId}`)).toContain(cropped.sha256)
    view.rerender(createElement(AdminProductImage, { ...props, online: false }))
    expect((screen.getByRole('button', { name: 'ตรวจสอบรูปด้วยรหัสเดิม' }) as HTMLButtonElement).disabled).toBe(true)
    expect(requests).toHaveLength(1)
  })
  it('clears only a definitive conflict while retaining the crop for an explicit review', async () => {
    mode = 'conflict'; const { props } = await mount(); choose(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    await waitFor(() => expect(props.onConflict).toHaveBeenCalledOnce())
    expect(localStorage.length).toBe(0)
    expect(screen.getByRole('button', { name: 'บันทึกรูปสินค้า' })).toBeTruthy()
    expect(writes).toBe(0); expect(props.onSaved).not.toHaveBeenCalled()
  })
  it('sends nothing if pending storage is blocked and preserves its original in-memory UUID', async () => {
    const store = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    await mount(); choose(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    await screen.findByText('ยังเก็บคำขอรูปบนเครื่องไม่ได้ จึงยังไม่ส่งคำขอใหม่')
    expect(transport.send).not.toHaveBeenCalled(); store.mockRestore()
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบรูปด้วยรหัสเดิม' }))
    await screen.findByText('บันทึกรูปสินค้าแล้ว'); expect(writes).toBe(1)
  })
})

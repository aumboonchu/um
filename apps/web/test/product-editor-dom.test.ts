// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProductDetail } from '../src/purchase-management'

const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/auth-client', async actual => ({ ...await actual<typeof import('../src/auth-client')>(), apiFetch: transport.send }))
const account = 'editor-owner', id = 'editor-product', upc = '8851959129012'
const original: ProductDetail = { id, upc, sku: 'IMG-EDITOR', name: 'น้ำมันถั่วเหลือง 1 ล.', brand: 'แบรนด์เดิม', packageSize: '1 ล.',
  unit: null, category: null, imageUrl: null, profileRevision: 0, purchaseCount: 1, totalSpentMinor: 5000, totalQuantity: 1,
  minimumPriceMinor: 5000, maximumPriceMinor: 5000, lastPurchasedAt: '2026-10-01T00:00:00.000Z', recentPurchases: [] }
let current: ProductDetail, mode: 'ok' | 'lost' | 'conflict', patches: string[], writes: number
let receipts: Map<string, { operationId: string; productId: string; profileRevision: number }>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, 'confirm').mockReturnValue(true)
  current = { ...original }; mode = 'ok'; patches = []; writes = 0; receipts = new Map()
  transport.send.mockReset().mockImplementation(async (_origin: string, path: string, init?: RequestInit) => {
    if (path !== `/api/v1/products/${id}/detail`) throw new Error(`Unexpected test request ${path}`)
    if (init?.method !== 'PATCH') return json({ data: current })
    const raw = String(init.body); patches.push(raw)
    const p = JSON.parse(raw)
    if (mode === 'conflict') return json({ error: { code: 'PRODUCT_CONFLICT' } }, 409)
    if (p.accountId !== account) return json({ error: { code: 'PRODUCT_ACCOUNT_MISMATCH' } }, 403)
    const receipt = receipts.get(p.operationId)
    if (receipt) return json({ data: receipt })
    if (p.expectedRevision !== current.profileRevision) return json({ error: { code: 'PRODUCT_CONFLICT' } }, 409)
    const next = { productId: id, operationId: String(p.operationId), profileRevision: Number(p.expectedRevision) + 1 }
    receipts.set(p.operationId, next); writes += 1
    current = { ...current, name: p.name, brand: p.brand, packageSize: p.packageSize, unit: p.unit, category: p.category, profileRevision: next.profileRevision }
    if (mode === 'lost') { mode = 'ok'; throw new TypeError('lost response after a committed test write') }
    return json({ data: next })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function mount(pending = false, online = true) {
  const { ProductDetailView } = await import('../src/AccountViews')
  const callbacks = { onBack: vi.fn(), onPurchase: vi.fn(), onBuy: vi.fn(), onChanged: vi.fn(), onDirtyChange: vi.fn() }
  const view = render(createElement(ProductDetailView, { apiOrigin: '', accountId: account, id, online, ...callbacks }))
  if (online) {
    await screen.findByRole('button', { name: pending ? 'ตรวจสอบผลด้วยรหัสเดิม' : 'แก้ไขสินค้า' })
    if (!pending) await waitFor(() => expect((screen.getByRole('button', { name: 'แก้ไขสินค้า' }) as HTMLButtonElement).disabled).toBe(false))
  }
  return { view, callbacks }
}
async function edit() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'แก้ไขสินค้า' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'แก้ไขสินค้า' }))
  await screen.findByRole('heading', { name: 'แก้ไขรายละเอียดสินค้า' })
}
describe('product details editing DOM integration', () => {
  it('edits text details, refreshes the original SKU, and updates only the owner cache without changing spending', async () => {
    const { callbacks } = await mount(); await edit()
    expect(screen.queryByRole('button', { name: 'บันทึกซื้อสินค้านี้อีก' })).toBeNull()
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'น้ำมันชื่อที่แก้แล้ว' } })
    fireEvent.change(screen.getByLabelText('แบรนด์'), { target: { value: 'แบรนด์ใหม่' } })
    fireEvent.change(screen.getByLabelText('ขนาด / บรรจุ'), { target: { value: '1 ลิตร' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการแก้ไข' }))
    await screen.findByText('บันทึกสินค้าแล้ว')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'บันทึกการแก้ไข' })).toBeNull())
    expect(screen.getByText('น้ำมันชื่อที่แก้แล้ว')).toBeTruthy()
    expect(screen.getByText('SKU: IMG-EDITOR')).toBeTruthy()
    expect(screen.getByText(`UPC / EAN: ${upc}`)).toBeTruthy()
    expect((await screen.findByText('ยอดสะสม')).parentElement?.textContent).toContain('50.00')
    expect(JSON.parse(patches[0])).toMatchObject({ accountId: account, expectedRevision: 0, name: 'น้ำมันชื่อที่แก้แล้ว', brand: 'แบรนด์ใหม่', packageSize: '1 ลิตร' })
    expect(callbacks.onChanged).toHaveBeenCalledOnce()
    const offline = await import('../src/offline')
    expect((await offline.findCachedProduct(upc, account))?.name).toBe('น้ำมันชื่อที่แก้แล้ว')
    expect(await offline.findCachedProduct(upc, 'other-account')).toBeNull()
    expect(writes).toBe(1)
  })
  it('cancels an unsent edit without writing and leaves no pending operation', async () => {
    const { callbacks } = await mount(); await edit()
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'ยังไม่บันทึก' } })
    await waitFor(() => expect(callbacks.onDirtyChange).toHaveBeenLastCalledWith(true))
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }))
    await screen.findByRole('button', { name: 'แก้ไขสินค้า' })
    expect(screen.getByText(original.name)).toBeTruthy()
    expect(patches).toHaveLength(0)
    const { loadProductEdit } = await import('../src/product-edit')
    expect(loadProductEdit(account, id)).toBeNull()
  })
  it('restores a lost-response operation after remount and retries the exact payload without another write', async () => {
    const { view, callbacks } = await mount(); await edit(); mode = 'lost'
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'ชื่อที่ส่งแล้ว' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการแก้ไข' }))
    const retry = await screen.findByRole('button', { name: 'ตรวจสอบผลด้วยรหัสเดิม' })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    expect(callbacks.onChanged).not.toHaveBeenCalled()
    expect((screen.getByLabelText('ชื่อสินค้า').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    view.unmount()
    await mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบผลด้วยรหัสเดิม' }))
    await screen.findByText('บันทึกสินค้าแล้ว')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'ตรวจสอบผลด้วยรหัสเดิม' })).toBeNull())
    expect(patches).toHaveLength(2); expect(patches[1]).toBe(patches[0]); expect(writes).toBe(1)
  })
  it('requires loading the latest version after a conflict and sends a new UUID only after a fresh review', async () => {
    await mount(); await edit()
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'แบบฟอร์มเดิม' } })
    current = { ...current, name: 'อีกแท็บแก้แล้ว', profileRevision: 1 }; mode = 'conflict'
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการแก้ไข' }))
    await screen.findByRole('button', { name: 'โหลดข้อมูลสินค้าล่าสุด' })
    expect((screen.getByRole('button', { name: 'บันทึกการแก้ไข' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe('แบบฟอร์มเดิม')
    fireEvent.click(screen.getByRole('button', { name: 'โหลดข้อมูลสินค้าล่าสุด' }))
    await screen.findByRole('button', { name: 'แก้ไขสินค้า' })
    mode = 'ok'; await edit()
    expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe('อีกแท็บแก้แล้ว')
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'ทบทวนแล้ว' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการแก้ไข' }))
    await screen.findByText('บันทึกสินค้าแล้ว')
    expect(JSON.parse(patches[1]).expectedRevision).toBe(1)
    expect(JSON.parse(patches[1]).operationId).not.toBe(JSON.parse(patches[0]).operationId)
  })
  it('disables an existing form when connectivity is lost without discarding its text', async () => {
    const { view, callbacks } = await mount(); await edit()
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'ยังแก้อยู่' } })
    const { ProductDetailView } = await import('../src/AccountViews')
    view.rerender(createElement(ProductDetailView, { apiOrigin: '', accountId: account, id, online: false, ...callbacks }))
    expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe('ยังแก้อยู่')
    expect((screen.getByRole('button', { name: 'บันทึกการแก้ไข' }) as HTMLButtonElement).disabled).toBe(true)
    expect(patches).toHaveLength(0)
  })
})

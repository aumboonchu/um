// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RoundPayload, RoundReport } from '../src/shopping-rounds'

const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/auth-client', async importActual => ({ ...await importActual<typeof import('../src/auth-client')>(), apiFetch: transport.send }))
vi.mock('../src/BarcodeScanner', () => ({ default: ({ disabled, onDetected }: { disabled: boolean; onDetected: (v: string) => void }) => createElement('button', { disabled, onClick: () => onDetected('8851959129012') }, 'กล้องทดสอบสแกนสินค้า') }))
vi.mock('../src/image-import', async importActual => ({ ...await importActual<typeof import('../src/image-import')>(), prepareImageUpload: async () => new Blob(['prepared'], { type: 'image/jpeg' }), imageFingerprint: async () => 'ab'.repeat(32) }))
let reports: RoundReport[], failCheckout: boolean, added: boolean, checkoutBodies: string[], currentUser: string, imageUpc: string | null
const known = { id: 'dom-milk', sku: 'UPC-MILK', name: 'นมทดสอบ', upc: '8851959129012', brand: null, packageSize: '1 แพ็ก', imageUrl: null, source: 'smartcart', sourcePriceMinor: 2500, regularPriceMinor: null, fetchedAt: null }
const unknown = { ...known, id: 'dom-oreo', sku: 'UPC-OREO', upc: '3017620422003', name: 'OREO เพิ่มใหม่', packageSize: null, sourcePriceMinor: null }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('BroadcastChannel', undefined)
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { persisted: async () => false, persist: async () => false } })
  Element.prototype.scrollIntoView = vi.fn(); localStorage.clear(); sessionStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:dom-test'); URL.revokeObjectURL = vi.fn()
  reports = []; failCheckout = false; added = false; checkoutBodies = []; currentUser = 'dom-user'; imageUpc = null
  transport.send.mockReset().mockImplementation(async (_origin: string, path: string, init?: RequestInit) => {
    if (path === '/auth/config') return json({ data: { googleEnabled: true } })
    if (path === '/auth/me') return json({ data: { authenticated: true, account: { id: currentUser, displayName: currentUser, primaryEmail: null } } })
    if (path.startsWith('/api/v1/products/upc/8851959129012')) return json({ data: known })
    if (path.startsWith('/api/v1/products/upc/3017620422003')) return added ? json({ data: unknown }) : json({ error: { code: 'PRODUCT_NOT_FOUND' } }, 404)
    if (path === '/api/v1/products') { added = true; return json({ data: unknown }, 201) }
    if (path === '/api/v1/products/extract-image') return json({ data: { draft: { name: unknown.name, brand: 'OREO', packageSize: '24.6 g x 12', sourcePriceMinor: 4500, upc: imageUpc, retailerCode: '197584' }, imageSha256: 'ab'.repeat(32), warnings: [] } })
    if (path === '/api/v1/products/import-image') { added = true; return json({ data: { ...unknown, sourcePriceMinor: 4500 } }, 201) }
    if (path.startsWith('/api/v1/purchases?')) return json({ data: { items: [], nextCursor: null } })
    if (path === '/api/v1/rounds/checkout') {
      checkoutBodies.push(String(init?.body)); if (failCheckout) throw new TypeError('offline test')
      const p = JSON.parse(String(init?.body)) as RoundPayload
      if (!reports.some(v => v.id === p.operationId)) reports.push({ id: p.operationId, checkedOutAt: p.checkedOutAt, storeName: p.storeName, paymentMethod: p.paymentMethod, note: p.note, createdAt: p.checkedOutAt, lineCount: p.lines.length,
        totalMinor: p.lines.reduce((sum, line) => sum + Math.round(line.unitPriceMinor * line.quantity), 0), lines: p.lines.map(line => ({ ...line, productName: line.productId === known.id ? known.name : unknown.name, productSku: 'DOM-SKU', productUpc: null, packageSize: null, totalMinor: Math.round(line.unitPriceMinor * line.quantity) })) })
      return json({ data: { ...reports.find(v => v.id === p.operationId), operationId: p.operationId, status: 'synced' } })
    }
    if (path.startsWith('/api/v1/rounds?')) { const params = new URLSearchParams(path.split('?')[1]); return json({ data: { month: params.get('month'), items: reports.map(({ lines: _, ...summary }) => summary), nextCursor: null, summary: { roundCount: reports.length, totalPaidMinor: reports.reduce((sum, r) => sum + r.totalMinor, 0) }, legacy: { count: 0, totalMinor: 0 } } }) }
    if (path.startsWith('/api/v1/rounds/')) return json({ data: reports.find(r => path.endsWith(r.id)) })
    throw new Error(`Unexpected DOM QA request ${path}`)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function app() {
  const App = (await import('../src/App')).default; const result = render(createElement(App))
  await waitFor(() => expect((screen.getByRole('button', { name: 'กล้องทดสอบสแกนสินค้า' }) as HTMLButtonElement).disabled).toBe(false))
  return result
}
async function scanKnown() {
  fireEvent.click(screen.getByRole('button', { name: 'กล้องทดสอบสแกนสินค้า' }))
  await screen.findByRole('heading', { name: 'จำนวนและราคาสินค้า' })
  await waitFor(() => expect((screen.getByRole('button', { name: 'เพิ่มเข้ารอบนี้ → สแกนต่อ' }) as HTMLButtonElement).disabled).toBe(false))
}
async function addCurrent() {
  await waitFor(() => expect((screen.getByRole('button', { name: 'เพิ่มเข้ารอบนี้ → สแกนต่อ' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'เพิ่มเข้ารอบนี้ → สแกนต่อ' }))
  await screen.findByRole('heading', { name: 'เริ่มสแกนสินค้า' })
  await waitFor(() => expect((screen.getByRole('button', { name: 'ชำระเงิน / จบรอบนี้' }) as HTMLButtonElement).disabled).toBe(false))
}
async function closeRound() {
  fireEvent.click(screen.getByRole('button', { name: 'ชำระเงิน / จบรอบนี้' }))
  await screen.findByRole('heading', { name: 'ตรวจยอดและจบรอบ' })
  expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้วและบันทึกรอบ' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('ร้านค้า'), { target: { value: 'Makro Pro' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจจำนวนและราคาแล้ว/ }))
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันชำระแล้วและบันทึกรอบ' }))
  await screen.findByRole('heading', { name: 'เริ่มสแกนสินค้า' })
}
describe('scan-first shopping journey DOM integration', () => {
  it('opens at scan, finds product, adds multiple lines, confirms one whole-round payment and opens its report', async () => {
    await app(); await scanKnown()
    fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: '2' } }); await addCurrent()
    expect(reports).toHaveLength(0); expect(checkoutBodies).toHaveLength(0)
    await scanKnown(); fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย / แพ็ก (บาท)'), { target: { value: '30' } }); await addCurrent()
    await closeRound()
    await waitFor(() => expect(reports).toHaveLength(1)); await screen.findByText(/บันทึกเข้า D1 แล้ว เก็บสำเนาบนอุปกรณ์เป็น cache/)
    expect(reports[0]).toMatchObject({ totalMinor: 8000, lineCount: 2, storeName: 'Makro Pro', lines: [{ quantity: 2, unitPriceMinor: 2500 }, { quantity: 1, unitPriceMinor: 3000 }] })
    fireEvent.click(screen.getByRole('button', { name: 'รายงานรายรอบ' }))
    const report = await screen.findByRole('region', { name: 'รายงานรายรอบ' })
    await within(report).findByText('ยอดชำระรวม (D1)')
    fireEvent.click(within(report).getByRole('button', { name: /รอบ .* Makro Pro.*บันทึกเข้า D1 แล้ว/ }))
    await within(report).findByRole('heading', { name: /รายละเอียดรอบ/ })
    expect(within(report).getByRole('button', { name: 'ดาวน์โหลดรายงานรอบนี้ (CSV)' })).toBeTruthy()
  })
  it('automatically shows add-product on catalog miss, preserves scanned UPC and returns to price/quantity', async () => {
    await app()
    fireEvent.change(screen.getByLabelText('UPC / EAN'), { target: { value: '3017620422003' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหาในฐานข้อมูล' }))
    await screen.findByRole('heading', { name: 'เพิ่มข้อมูลสินค้าใหม่' })
    expect(screen.getByText('3017620422003')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'OREO เพิ่มใหม่' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสินค้า → ใส่จำนวนและราคา' }))
    await screen.findByRole('heading', { name: 'จำนวนและราคาสินค้า' })
    const call = transport.send.mock.calls.find(([, path]) => path === '/api/v1/products')
    expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ upc: '3017620422003', name: 'OREO เพิ่มใหม่' })
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย / แพ็ก (บาท)'), { target: { value: '45' } }); await addCurrent()
    expect(reports).toHaveLength(0)
  })
  it('keeps draft across report navigation, allows edit/removal, and rejects zero price', async () => {
    await app(); await scanKnown()
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย / แพ็ก (บาท)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มเข้ารอบนี้ → สแกนต่อ' }))
    await screen.findByRole('alert'); expect(checkoutBodies).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย / แพ็ก (บาท)'), { target: { value: '25' } }); await addCurrent()
    fireEvent.click(screen.getByRole('button', { name: 'รายงานรายรอบ' })); await screen.findByRole('region', { name: 'รายงานรายรอบ' })
    fireEvent.click(screen.getByRole('button', { name: 'สแกน / รอบนี้' }))
    fireEvent.click(screen.getByRole('button', { name: 'แก้ไข' }))
    fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: '3' } }); fireEvent.click(screen.getByRole('button', { name: 'บันทึกแก้ไขในรอบ' }))
    await screen.findByRole('heading', { name: 'เริ่มสแกนสินค้า' })
    await screen.findByText(/3 × ฿25.00/)
    fireEvent.click(screen.getByRole('button', { name: 'เอาออกจากรอบ' }))
    await screen.findByText('ยังไม่มีสินค้า เริ่มจากสแกนชิ้นแรก')
    expect((screen.getByRole('button', { name: 'ชำระเงิน / จบรอบนี้' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('retains a completed offline round and syncs exactly that UUID when connectivity returns', async () => {
    await app(); await scanKnown(); await addCurrent()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); act(() => { window.dispatchEvent(new Event('offline')) })
    await closeRound(); await screen.findByText('จบรอบแล้ว รอซิงก์ 1 รอบ')
    expect(checkoutBodies).toHaveLength(0)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); act(() => { window.dispatchEvent(new Event('online')) })
    await screen.findByText(/บันทึกเข้า D1 แล้ว เก็บสำเนาบนอุปกรณ์เป็น cache/)
    expect(reports).toHaveLength(1); expect(JSON.parse(checkoutBodies[0]).operationId).toBe(reports[0].id)
  })
  it('keeps the exact pending round after a network failure and retries without duplicated reports', async () => {
    await app(); await scanKnown(); await addCurrent(); failCheckout = true; await closeRound()
    await screen.findByText('จบรอบแล้ว รอซิงก์ 1 รอบ'); await waitFor(() => expect(checkoutBodies.length).toBe(1))
    failCheckout = false
    const button = screen.getByRole('button', { name: 'ซิงก์รอบที่ค้างด้วยรหัสเดิม' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button)
    await screen.findByText(/บันทึกเข้า D1 แล้ว เก็บสำเนาบนอุปกรณ์เป็น cache/)
    expect(checkoutBodies).toHaveLength(2); expect(checkoutBodies[1]).toBe(checkoutBodies[0]); expect(reports).toHaveLength(1)
  })
  it('reopens the saved draft after app remount without turning it into a paid purchase', async () => {
    const view = await app(); await scanKnown(); await addCurrent(); view.unmount()
    await app(); await screen.findByText(/1\. นมทดสอบ/)
    expect(reports).toHaveLength(0); expect(checkoutBodies).toHaveLength(0)
  })
  it('restores and reconciles a previously pending checkout on next app open', async () => {
    const view = await app(); await scanKnown(); await addCurrent(); failCheckout = true; await closeRound()
    await waitFor(() => expect(checkoutBodies).toHaveLength(1)); view.unmount(); failCheckout = false
    await app(); await screen.findByText(/บันทึกเข้า D1 แล้ว เก็บสำเนาบนอุปกรณ์เป็น cache/)
    expect(reports).toHaveLength(1); expect(checkoutBodies[1]).toBe(checkoutBodies[0])
  })
  it('hides the previous account cart on a storage-triggered account switch and restores only its owner', async () => {
    await app(); await scanKnown(); await addCurrent()
    currentUser = 'dom-other'
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })) })
    await screen.findByText(/เข้าสู่ระบบแล้ว · dom-other/)
    await screen.findByText('ยังไม่มีสินค้า เริ่มจากสแกนชิ้นแรก')
    expect(screen.queryByText(/1\. นมทดสอบ/)).toBeNull()
    currentUser = 'dom-user'; act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })) })
    await screen.findByText(/1\. นมทดสอบ/); expect(checkoutBodies).toHaveLength(0)
  })
  it('prefills the scanned UPC when using a Makro screenshot to register an unknown product', async () => {
    await app(); fireEvent.change(screen.getByLabelText('UPC / EAN'), { target: { value: '3017620422003' } }); fireEvent.click(screen.getByRole('button', { name: 'ค้นหาในฐานข้อมูล' }))
    await screen.findByRole('heading', { name: 'เพิ่มข้อมูลสินค้าใหม่' }); fireEvent.click(screen.getByRole('button', { name: 'ใช้ภาพ Big C / Makro Pro ช่วยเพิ่มข้อมูล' }))
    fireEvent.change(screen.getByLabelText(/เลือกภาพหน้าจอหรือรูปสินค้า/), { target: { files: [new File(['jpeg'], 'makro.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(await screen.findByRole('button', { name: 'อ่านข้อมูลจากภาพ' }))
    const upcInput = await screen.findByLabelText('UPC / EAN บาร์โค้ด (ไม่บังคับ)'); expect((upcInput as HTMLInputElement).value).toBe('3017620422003')
    fireEvent.click(screen.getByRole('checkbox', { name: 'ฉันตรวจสอบชื่อ ราคา และรหัสแล้ว ยืนยันบันทึกข้อมูลนี้เป็นสินค้า' }))
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกสินค้าเป็น SKU' }))
    await screen.findByRole('heading', { name: 'จำนวนและราคาสินค้า' })
    const call = transport.send.mock.calls.find(([, path]) => path === '/api/v1/products/import-image')
    expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ upc: '3017620422003', retailerCode: '197584', sourcePriceMinor: 4500 })
    expect((screen.getByLabelText('ราคาต่อหน่วย / แพ็ก (บาท)') as HTMLInputElement).value).toBe('45.00')
  })
  it('requires a fresh checkout confirmation if another tab changes the cart revision', async () => {
    const { ShoppingJourney } = await import('../src/ShoppingJourney')
    const item = { id: crypto.randomUUID(), product: { ...known, source: 'smartcart' as const }, unitPriceMinor: 2500, quantity: 1, note: null }
    const draft = { key: 'dom-user:draft', accountId: 'dom-user', kind: 'draft' as const, id: crypto.randomUUID(), revision: 1, lines: [item] }
    const controller = { draft, closed: [], pending: [], error: '', busy: false, loading: false, syncing: false, save: vi.fn(), sync: vi.fn(), refresh: vi.fn() }
    const props = { accountId: 'dom-user', apiOrigin: '', online: true, rounds: controller, initialProduct: null, onConsumed: vi.fn() }
    const view = render(createElement(ShoppingJourney, props))
    fireEvent.click(screen.getByRole('button', { name: 'ชำระเงิน / จบรอบนี้' })); fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจจำนวนและราคาแล้ว/ }))
    expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้วและบันทึกรอบ' }) as HTMLButtonElement).disabled).toBe(false)
    view.rerender(createElement(ShoppingJourney, { ...props, rounds: { ...controller, draft: { ...draft, revision: 2, lines: [{ ...item, quantity: 3 }] } } }))
    expect((screen.getByRole('checkbox', { name: /ตรวจจำนวนและราคาแล้ว/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้วและบันทึกรอบ' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('does not overwrite another tab item edit with stale form values', async () => {
    const { ShoppingJourney } = await import('../src/ShoppingJourney')
    const item = { id: crypto.randomUUID(), product: { ...known, source: 'smartcart' as const }, unitPriceMinor: 2500, quantity: 1, note: null }
    const draft = { key: 'dom-user:draft', accountId: 'dom-user', kind: 'draft' as const, id: crypto.randomUUID(), revision: 1, lines: [item] }
    const controller = { draft, closed: [], pending: [], error: '', busy: false, loading: false, syncing: false, save: vi.fn(), sync: vi.fn(), refresh: vi.fn() }
    const props = { accountId: 'dom-user', apiOrigin: '', online: true, rounds: controller, initialProduct: null, onConsumed: vi.fn() }
    const view = render(createElement(ShoppingJourney, props)); fireEvent.click(screen.getByRole('button', { name: 'แก้ไข' }))
    view.rerender(createElement(ShoppingJourney, { ...props, rounds: { ...controller, draft: { ...draft, revision: 2, lines: [{ ...item, quantity: 2 }] } } }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกแก้ไขในรอบ' }))
    await screen.findByRole('alert'); expect(controller.save).not.toHaveBeenCalled()
  })
})

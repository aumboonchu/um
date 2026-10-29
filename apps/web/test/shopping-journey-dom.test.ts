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
let reports: RoundReport[], failCheckout: boolean, added: boolean, checkoutBodies: string[], currentUser: string, imageUpc: string | null, avatarUrl: string | null
const known = { id: 'dom-milk', sku: 'UPC-MILK', name: 'นมทดสอบ', upc: '8851959129012', brand: null, packageSize: '1 แพ็ก', imageUrl: null, source: 'smartcart', sourcePriceMinor: 2500, regularPriceMinor: null, fetchedAt: null }
const unknown = { ...known, id: 'dom-oreo', sku: 'UPC-OREO', upc: '3017620422003', name: 'OREO เพิ่มใหม่', packageSize: null, sourcePriceMinor: null }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('BroadcastChannel', undefined)
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { persisted: async () => false, persist: async () => false } })
  Element.prototype.scrollIntoView = vi.fn(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); sessionStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:dom-test'); URL.revokeObjectURL = vi.fn()
  reports = []; failCheckout = false; added = false; checkoutBodies = []; currentUser = 'dom-user'; imageUpc = null; avatarUrl = null
  transport.send.mockReset().mockImplementation(async (_origin: string, path: string, init?: RequestInit) => {
    if (path === '/auth/config') return json({ data: { googleEnabled: true } })
    if (path === '/auth/me') return json({ data: { authenticated: true, account: { id: currentUser, displayName: currentUser, primaryEmail: null, avatarUrl } } })
    if (path.startsWith('/api/v1/products/upc/8851959129012')) return json({ data: known })
    if (path.startsWith('/api/v1/products/upc/3017620422003')) return added ? json({ data: unknown }) : json({ error: { code: 'PRODUCT_NOT_FOUND' } }, 404)
    if (path === '/api/v1/products') { added = true; return json({ data: unknown }, 201) }
    if (path === '/api/v1/products/extract-image') return json({ data: { draft: { name: unknown.name, brand: 'OREO', packageSize: '24.6 g x 12', sourcePriceMinor: 4500, upc: imageUpc, retailerCode: '197584' }, imageSha256: 'ab'.repeat(32), warnings: [] } })
    if (path === '/api/v1/products/import-image') { added = true; return json({ data: { ...unknown, sourcePriceMinor: 4500 } }, 201) }
    if (path.startsWith('/api/v1/purchases?')) return json({ data: { items: [], nextCursor: null } })
    if (path.startsWith('/api/v1/products/mine?')) return json({ data: { items: [], nextCursor: null } })
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
  const App = (await import('../src/App')).default
  const result = render(createElement(App))
  await waitFor(() => expect((screen.getByRole('button', { name: 'กล้องทดสอบสแกนสินค้า' }) as HTMLButtonElement).disabled).toBe(false))
  return result
}
async function scanKnown() {
  fireEvent.click(screen.getByRole('button', { name: 'กล้องทดสอบสแกนสินค้า' }))
  await screen.findByRole('heading', { name: 'เพิ่มเข้ารอบ' })
  await waitFor(() => expect((screen.getByRole('button', { name: /^เพิ่มเข้ารอบ/ }) as HTMLButtonElement).disabled).toBe(false))
}
async function addCurrent() {
  fireEvent.click(screen.getByRole('button', { name: /^เพิ่มเข้ารอบ/ }))
  await screen.findByRole('heading', { name: 'รอบนี้' })
  await waitFor(() => expect((screen.getByRole('button', { name: /^ชำระเงิน ·/ }) as HTMLButtonElement).disabled).toBe(false))
}
async function manual(code: string) {
  fireEvent.click(screen.getByRole('button', { name: 'พิมพ์รหัส' }))
  fireEvent.change(screen.getByLabelText('UPC / EAN'), { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: 'ค้นหา' }))
}
async function closeRound() {
  fireEvent.click(screen.getByRole('button', { name: /^ชำระเงิน ·/ }))
  await screen.findByRole('heading', { name: 'จบรอบนี้' })
  fireEvent.change(screen.getByLabelText('ร้านค้า'), { target: { value: 'Makro Pro' } })
  expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้ว' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันชำระแล้ว' }))
  await screen.findByRole('heading', { name: /^(บันทึกรอบแล้ว|เก็บรอบบนเครื่องแล้ว)$/ })
}
async function savedDraft() {
  fireEvent.click(await screen.findByRole('button', { name: /ต่อรอบที่ค้างไว้/ }))
  await screen.findByRole('heading', { name: 'รอบนี้' })
}
describe('mobile scan-first journey DOM integration', () => {
  it('shows the authenticated Google photo across all primary tabs and account, without leaking it to a different account', async () => {
    avatarUrl = 'https://lh3.googleusercontent.com/a/dom-avatar'
    await app()
    function photo() { return screen.getByRole('button', { name: 'บัญชี' }).querySelector('.account-photo') }
    expect(photo()?.getAttribute('src')).toBe(avatarUrl)
    fireEvent.click(screen.getByRole('button', { name: 'รายงาน' }))
    await screen.findByRole('heading', { name: 'รายงาน' })
    expect(photo()?.getAttribute('src')).toBe(avatarUrl)
    fireEvent.click(screen.getByRole('button', { name: 'สินค้า' }))
    await screen.findByRole('heading', { name: 'สินค้า' })
    expect(photo()?.getAttribute('src')).toBe(avatarUrl)
    fireEvent.click(screen.getByRole('button', { name: 'บัญชี' }))
    await screen.findByRole('heading', { name: 'บัญชี' })
    expect(document.querySelector('.account-identity .account-photo')?.getAttribute('src')).toBe(avatarUrl)
    expect((screen.getByRole('button', { name: 'อัปเดตรูป Google', hidden: true }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'กลับ' }))
    currentUser = 'dom-other'; avatarUrl = null
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })))
    await waitFor(() => expect(photo()).toBeNull())
    expect(screen.getByRole('button', { name: 'บัญชี' }).querySelector('.sc-icon')).not.toBeNull()
  })

  it('keeps three primary tabs, puts account behind its icon, and hides tabs while entering price', async () => {
    await app()
    expect(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getAllByRole('button')).toHaveLength(3)
    expect(screen.queryByText('dom-user')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'บัญชี' }))
    await screen.findByText('dom-user')
    fireEvent.click(screen.getByRole('button', { name: 'กลับ' }))
    await scanKnown()
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'เมนูหลัก' })).toBeNull())
    expect(checkoutBodies).toHaveLength(0)
  })
  it('adds multiple lines, explicitly confirms one whole-round payment, and opens its immutable receipt', async () => {
    await app(); await scanKnown()
    fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: '2' } }); await addCurrent()
    expect(reports).toHaveLength(0); expect(checkoutBodies).toHaveLength(0)
    await scanKnown(); fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย (บาท)'), { target: { value: '30' } }); await addCurrent()
    await closeRound(); await screen.findByRole('heading', { name: 'บันทึกรอบแล้ว' })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ totalMinor: 8000, lineCount: 2, storeName: 'Makro Pro', lines: [{ quantity: 2, unitPriceMinor: 2500 }, { quantity: 1, unitPriceMinor: 3000 }] })
    fireEvent.click(screen.getByRole('button', { name: 'ดูสรุปรอบนี้' }))
    const receipt = await screen.findByRole('region', { name: 'สรุปรอบซื้อ' })
    expect(within(receipt).getByText('ยอดรวมรอบนี้')).toBeTruthy()
    expect(within(receipt).getAllByRole('button', { name: 'ส่งออก CSV' })).toHaveLength(2)
    fireEvent.click(within(receipt).getAllByRole('button', { name: 'ส่งออก CSV' })[1]); expect(URL.createObjectURL).toHaveBeenCalled()
    expect(within(receipt).queryByRole('button', { name: /แก้ไข/ })).toBeNull()
  })
  it('shows add-product on catalog miss, carries its UPC, and returns to price without making a purchase', async () => {
    await app(); await manual('3017620422003')
    await screen.findByRole('heading', { name: 'เพิ่มสินค้า' })
    expect(screen.getByText('3017620422003')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value: 'OREO เพิ่มใหม่' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกและใส่ราคา' }))
    await screen.findByRole('heading', { name: 'เพิ่มเข้ารอบ' })
    const call = transport.send.mock.calls.find(([, path]) => path === '/api/v1/products')
    expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ upc: '3017620422003', name: 'OREO เพิ่มใหม่' })
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย (บาท)'), { target: { value: '45' } }); await addCurrent()
    expect(reports).toHaveLength(0)
  })
  it('preserves draft across reports, edits/removes before payment, and rejects a zero price', async () => {
    await app(); await scanKnown()
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย (บาท)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /^เพิ่มเข้ารอบ/ }))
    await screen.findByRole('alert'); expect(checkoutBodies).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('ราคาต่อหน่วย (บาท)'), { target: { value: '25' } }); await addCurrent()
    fireEvent.click(screen.getByRole('button', { name: 'รายงาน' })); await screen.findByRole('region', { name: 'รายงาน' })
    fireEvent.click(screen.getByRole('button', { name: 'ซื้อสินค้า' }))
    fireEvent.click(screen.getByRole('button', { name: 'แก้ไข นมทดสอบ' }))
    fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: '3' } }); fireEvent.click(screen.getByRole('button', { name: /^บันทึกแก้ไข/ }))
    await screen.findByRole('heading', { name: 'รอบนี้' }); await screen.findByText(/3 × ฿25.00/)
    fireEvent.click(screen.getByRole('button', { name: 'แก้ไข นมทดสอบ' })); fireEvent.click(screen.getByRole('button', { name: 'เอาออกจากรอบ' }))
    await screen.findByText('สแกนชิ้นแรกได้เลย')
    expect(screen.queryByRole('button', { name: /^ชำระเงิน ·/ })).toBeNull()
  })
  it('retains an offline round and syncs exactly its UUID when connectivity returns', async () => {
    await app(); await scanKnown(); await addCurrent()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); act(() => window.dispatchEvent(new Event('offline')))
    await closeRound(); await screen.findByRole('heading', { name: 'เก็บรอบบนเครื่องแล้ว' })
    expect(screen.queryByText('ซิงก์แล้ว')).toBeNull(); expect(checkoutBodies).toHaveLength(0)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); act(() => window.dispatchEvent(new Event('online')))
    await screen.findByRole('heading', { name: 'บันทึกรอบแล้ว' })
    expect(reports).toHaveLength(1); expect(JSON.parse(checkoutBodies[0]).operationId).toBe(reports[0].id)
  })
  it('retries a failed checkout using the identical frozen payload without duplicate reports', async () => {
    await app(); await scanKnown(); await addCurrent(); failCheckout = true; await closeRound()
    await screen.findByRole('heading', { name: 'เก็บรอบบนเครื่องแล้ว' }); await waitFor(() => expect(checkoutBodies).toHaveLength(1))
    failCheckout = false
    const button = screen.getByRole('button', { name: 'ซิงก์อีกครั้ง' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button)
    await screen.findByRole('heading', { name: 'บันทึกรอบแล้ว' })
    expect(checkoutBodies).toHaveLength(2); expect(checkoutBodies[1]).toBe(checkoutBodies[0]); expect(reports).toHaveLength(1)
  })
  it('reopens a saved draft without turning it into paid spending', async () => {
    const view = await app(); await scanKnown(); await addCurrent(); view.unmount()
    await app(); await savedDraft(); expect(screen.getByText('นมทดสอบ')).toBeTruthy()
    expect(reports).toHaveLength(0); expect(checkoutBodies).toHaveLength(0)
  })
  it('reconciles a pending checkout after app remount without requiring the completion page', async () => {
    const view = await app(); await scanKnown(); await addCurrent(); failCheckout = true; await closeRound()
    await waitFor(() => expect(checkoutBodies).toHaveLength(1)); view.unmount(); failCheckout = false
    await app(); await waitFor(() => expect(reports).toHaveLength(1))
    const { readLocalRounds } = await import('../src/shopping-rounds')
    await waitFor(async () => expect((await readLocalRounds('dom-user')).closed[0].status).toBe('synced'))
    expect(checkoutBodies[1]).toBe(checkoutBodies[0])
  })
  it('hides another account cart on account switch and restores only its owner', async () => {
    await app(); await scanKnown(); await addCurrent(); currentUser = 'dom-other'
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })))
    await screen.findByText('สแกนชิ้นแรกได้เลย')
    fireEvent.click(screen.getByRole('button', { name: 'บัญชี' })); await screen.findByText('dom-other')
    expect(screen.queryByText('นมทดสอบ')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'กลับ' }))
    currentUser = 'dom-user'; act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })))
    await savedDraft(); expect(screen.getByText('นมทดสอบ')).toBeTruthy(); expect(checkoutBodies).toHaveLength(0)
  })
  it('prefills scanned UPC for a Makro screenshot without using retailer Code as barcode', async () => {
    await app(); await manual('3017620422003'); await screen.findByRole('heading', { name: 'เพิ่มสินค้า' })
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มข้อมูลจากรูป' }))
    fireEvent.change(screen.getByLabelText('เลือกรูปสินค้า'), { target: { files: [new File(['jpeg'], 'makro.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(await screen.findByRole('button', { name: 'อ่านข้อมูลจากภาพ' }))
    const upcInput = await screen.findByLabelText('UPC / EAN (ไม่บังคับ)'); expect((upcInput as HTMLInputElement).value).toBe('3017620422003')
    fireEvent.click(screen.getByRole('checkbox', { name: 'ตรวจชื่อ ราคา และบาร์โค้ดแล้ว' }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกและใส่ราคา' })); await screen.findByRole('heading', { name: 'เพิ่มเข้ารอบ' })
    const call = transport.send.mock.calls.find(([, path]) => path === '/api/v1/products/import-image')
    expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ upc: '3017620422003', retailerCode: '197584', sourcePriceMinor: 4500 })
    expect((screen.getByLabelText('ราคาต่อหน่วย (บาท)') as HTMLInputElement).value).toBe('45.00')
  })
  it('reviews a Big C app screenshot without a UPC, confirms its SKU, and adds bottles to the open round only', async () => {
    // Mocked OCR/HTTP responses test the journey, not live vision accuracy or a user's remote database.
    const bottle = { ...known, id: 'dom-water', sku: 'IMG-WATER', name: 'คริสตัล น้ำดื่ม 600 มล.',
      brand: 'คริสตัล', packageSize: '600 มล.', upc: null, sourcePriceMinor: 600 }
    const fallback = transport.send.getMockImplementation()
    if (!fallback) throw new Error('Missing test transport')
    transport.send.mockImplementation(async (origin: string, path: string, init?: RequestInit) => {
      if (path === '/api/v1/products/extract-image') return json({ data: { draft: {
        name: bottle.name, brand: bottle.brand, packageSize: bottle.packageSize,
        sourcePriceMinor: 600, upc: null, retailerCode: '13627',
      }, imageSha256: 'ab'.repeat(32), warnings: [] } })
      if (path === '/api/v1/products/import-image') return json({ data: bottle }, 201)
      return fallback(origin, path, init)
    })
    await app()
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มจากรูป' }))
    expect(screen.getByText(/ภาพจากแอป \/ เว็บ Big C/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('เลือกรูปสินค้า'), { target: { files: [new File(['jpeg'], 'bigc-app.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(await screen.findByRole('button', { name: 'อ่านข้อมูลจากภาพ' }))
    expect((await screen.findByLabelText('UPC / EAN (ไม่บังคับ)') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe(bottle.name)
    expect((screen.getByLabelText('ขนาด / บรรจุ') as HTMLInputElement).value).toBe('600 มล.')
    expect((screen.getByLabelText('ราคาในภาพ (อ้างอิง)') as HTMLInputElement).value).toBe('6.00')
    expect((screen.getByLabelText('รหัสร้าน (ไม่ใช่บาร์โค้ด)') as HTMLInputElement).value).toBe('13627')
    expect((screen.getByRole('button', { name: 'บันทึกและใส่ราคา' }) as HTMLButtonElement).disabled).toBe(true)
    expect(transport.send.mock.calls.filter(([, path]) => path === '/api/v1/products/import-image')).toHaveLength(0)
    fireEvent.click(screen.getByRole('checkbox', { name: 'ตรวจชื่อ ราคา และบาร์โค้ดแล้ว' }))
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกและใส่ราคา' }))
    await screen.findByRole('heading', { name: 'เพิ่มเข้ารอบ' })
    const call = transport.send.mock.calls.find(([, path]) => path === '/api/v1/products/import-image')
    expect(JSON.parse(String(call?.[2]?.body))).toMatchObject({ confirmed: true, name: bottle.name,
      packageSize: '600 มล.', sourcePriceMinor: 600, upc: null, retailerCode: '13627' })
    expect((screen.getByLabelText('ราคาต่อหน่วย (บาท)') as HTMLInputElement).value).toBe('6.00')
    fireEvent.change(screen.getByLabelText('จำนวน'), { target: { value: '2' } })
    await addCurrent()
    const { readLocalRounds } = await import('../src/shopping-rounds')
    expect((await readLocalRounds('dom-user')).draft?.lines[0]).toMatchObject({ product: { id: bottle.id, upc: null }, quantity: 2, unitPriceMinor: 600 })
    expect(reports).toHaveLength(0)
    expect(checkoutBodies).toHaveLength(0)
  })
  it('requires reviewing a changed cart revision before checkout confirmation becomes enabled again', async () => {
    const { ShoppingJourney } = await import('../src/ShoppingJourney')
    const item = { id: crypto.randomUUID(), product: { ...known, source: 'smartcart' as const }, unitPriceMinor: 2500, quantity: 1, note: null }
    const draft = { key: 'dom-user:draft', accountId: 'dom-user', kind: 'draft' as const, id: crypto.randomUUID(), revision: 1, lines: [item] }
    const controller = { draft, closed: [], pending: [], error: '', busy: false, loading: false, syncing: false, save: vi.fn(), sync: vi.fn(), refresh: vi.fn() }
    const props = { accountId: 'dom-user', apiOrigin: '', online: true, rounds: controller, initialProduct: null, onConsumed: vi.fn() }
    const view = render(createElement(ShoppingJourney, props)); await savedDraft()
    fireEvent.click(screen.getByRole('button', { name: /^ชำระเงิน ·/ }))
    expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้ว' }) as HTMLButtonElement).disabled).toBe(false)
    view.rerender(createElement(ShoppingJourney, { ...props, rounds: { ...controller, draft: { ...draft, revision: 2, lines: [{ ...item, quantity: 3 }] } } }))
    expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้ว' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันชำระแล้ว' })); expect(controller.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจยอดใหม่' }))
    expect((screen.getByRole('button', { name: 'ยืนยันชำระแล้ว' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('does not overwrite an item edited in another tab with stale values', async () => {
    const { ShoppingJourney } = await import('../src/ShoppingJourney')
    const item = { id: crypto.randomUUID(), product: { ...known, source: 'smartcart' as const }, unitPriceMinor: 2500, quantity: 1, note: null }
    const draft = { key: 'dom-user:draft', accountId: 'dom-user', kind: 'draft' as const, id: crypto.randomUUID(), revision: 1, lines: [item] }
    const controller = { draft, closed: [], pending: [], error: '', busy: false, loading: false, syncing: false, save: vi.fn(), sync: vi.fn(), refresh: vi.fn() }
    const props = { accountId: 'dom-user', apiOrigin: '', online: true, rounds: controller, initialProduct: null, onConsumed: vi.fn() }
    const view = render(createElement(ShoppingJourney, props)); await savedDraft(); fireEvent.click(screen.getByRole('button', { name: 'แก้ไข นมทดสอบ' }))
    view.rerender(createElement(ShoppingJourney, { ...props, rounds: { ...controller, draft: { ...draft, revision: 2, lines: [{ ...item, quantity: 2 }] } } }))
    fireEvent.click(screen.getByRole('button', { name: /^บันทึกแก้ไข/ }))
    await screen.findByRole('alert'); expect(controller.save).not.toHaveBeenCalled()
  })
  it('starts a truly empty round after payment and keeps pending-sync warnings visible', async () => {
    await app(); await scanKnown(); await addCurrent(); failCheckout = true; await closeRound()
    await waitFor(() => expect(checkoutBodies).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มรอบใหม่' })); await screen.findByText('สแกนชิ้นแรกได้เลย')
    expect(screen.getByText('อย่าล้างข้อมูลก่อนซิงก์')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^ชำระเงิน ·/ })).toBeNull()
    const { readLocalRounds } = await import('../src/shopping-rounds')
    expect((await readLocalRounds('dom-user')).closed[0].status).toBe('pending')
  })
  it('uses a new operation UUID for the next paid round', async () => {
    await app(); await scanKnown(); await addCurrent(); await closeRound(); await screen.findByRole('heading', { name: 'บันทึกรอบแล้ว' })
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มรอบใหม่' }))
    await scanKnown(); await addCurrent(); await closeRound(); await screen.findByRole('heading', { name: 'บันทึกรอบแล้ว' })
    expect(reports).toHaveLength(2); expect(reports[0].id).not.toBe(reports[1].id)
  })
  it('keeps a pending receipt open and updates its status when the same round syncs', async () => {
    await app(); await scanKnown(); await addCurrent(); failCheckout = true; await closeRound()
    await waitFor(() => expect(checkoutBodies).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'ดูสรุปรอบนี้' }))
    const receipt = await screen.findByRole('region', { name: 'สรุปรอบซื้อ' })
    expect(within(receipt).getByText('รอซิงก์')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: 'ซิงก์' }) as HTMLButtonElement).disabled).toBe(false))
    failCheckout = false; act(() => window.dispatchEvent(new Event('online')))
    await within(receipt).findByText('ซิงก์แล้ว')
    expect(screen.getByRole('region', { name: 'สรุปรอบซื้อ' })).toBe(receipt)
    expect(reports).toHaveLength(1); expect(checkoutBodies[1]).toBe(checkoutBodies[0])
  })
})

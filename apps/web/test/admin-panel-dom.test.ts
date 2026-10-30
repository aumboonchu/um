// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AdminProduct } from '../src/admin-client'

const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/auth-client', async actual => ({ ...await actual<typeof import('../src/auth-client')>(), apiFetch: transport.send }))
const account = 'admin-owner', id = 'admin-product', token = 'a'.repeat(43), replacement = 'b'.repeat(43)
const product: AdminProduct = { id, sku: 'IMG-ADMIN', upc: '8851959129012', name: 'สินค้ากลาง', brand: 'แบรนด์', packageSize: '1 ล.',
  unit: 'ขวด', category: null, imageUrl: null, source: 'image', sourceProductId: '13627', sourceUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', revision: 0 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let current: AdminProduct, mustChange: boolean, mode: 'ok' | 'lost' | 'conflict' | 'expired', writes: number, patches: string[], passwords: string[]
let receipts: Map<string, { productId: string; operationId: string; revision: number }>
beforeEach(() => {
  vi.resetModules(); localStorage.clear(); sessionStorage.clear(); window.scrollTo = vi.fn(); vi.spyOn(window, 'confirm').mockReturnValue(true)
  current = { ...product }; mustChange = true; mode = 'ok'; writes = 0; patches = []; passwords = []; receipts = new Map()
  transport.send.mockReset().mockImplementation(async (_origin: string, path: string, init?: RequestInit) => {
    if (path === '/api/v1/admin/status') return json({ data: { eligible: true } })
    if (path === '/api/v1/admin/login') {
      const input = JSON.parse(String(init?.body)); passwords.push(input.password)
      if (input.password === 'wrong') return json({ error: { code: 'ADMIN_LOGIN_FAILED' } }, 401)
      return json({ data: { token, mustChangePassword: mustChange, expiresAt: new Date(Date.now() + 900_000).toISOString() } })
    }
    if (path === '/api/v1/admin/password') {
      const input = JSON.parse(String(init?.body)); passwords.push(input.password); mustChange = false
      expect(new Headers(init?.headers).get('X-SmartCart-Admin')).toBe(token)
      return json({ data: { token: replacement, mustChangePassword: false, expiresAt: new Date(Date.now() + 900_000).toISOString() } })
    }
    if (path === '/api/v1/admin/logout') return json({ data: { signedOut: true } })
    if (path.startsWith('/api/v1/admin/products?')) {
      expect(mustChange).toBe(false)
      return json({ data: { items: [current], nextCursor: null, total: 1 } })
    }
    if (path === `/api/v1/admin/products/${id}`) {
      if (init?.method !== 'PATCH') return json({ data: current })
      const raw = String(init.body), p = JSON.parse(raw); patches.push(raw)
      if (mode === 'expired') return json({ error: { code: 'ADMIN_SESSION_REQUIRED' } }, 403)
      if (mode === 'conflict') return json({ error: { code: 'PRODUCT_CONFLICT' } }, 409)
      const existing = receipts.get(p.operationId)
      if (existing) return json({ data: existing })
      expect(localStorage.getItem(`smartcart-admin-edit-v1:${account}`)).toContain(p.operationId)
      expect(p.accountId).toBe(account)
      const receipt = { productId: id, operationId: p.operationId, revision: p.expectedRevision + 1 }
      receipts.set(p.operationId, receipt); writes += 1
      current = { ...current, name: p.name, brand: p.brand, packageSize: p.packageSize, unit: p.unit, category: p.category, revision: receipt.revision }
      if (mode === 'lost') { mode = 'ok'; throw new Error('lost response after a committed write') }
      return json({ data: receipt })
    }
    throw new Error(`Unexpected test request ${path}`)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function mount(online = true) {
  const { AdminPanel } = await import('../src/AdminPanel')
  const callbacks = { onBack: vi.fn(), onChanged: vi.fn(), onDirtyChange: vi.fn() }
  const props = { apiOrigin: '', accountId: account, online, ...callbacks }
  const view = render(createElement(AdminPanel, props))
  return { view, props, callbacks, AdminPanel }
}
async function login(password = '1234') {
  fireEvent.change(screen.getByLabelText('รหัสผ่านผู้ดูแล'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบผู้ดูแล' }))
}
async function enterCatalog() {
  await login()
  if (mustChange) {
    await screen.findByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })
    fireEvent.change(screen.getByLabelText('รหัสผ่านใหม่'), { target: { value: 'new-password-123' } })
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), { target: { value: 'new-password-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }))
  }
  await screen.findByRole('heading', { name: 'สินค้าทั้งระบบ' })
  await waitFor(() => expect((screen.getByRole('button', { name: `แก้ไข ${current.name}` }) as HTMLButtonElement).disabled).toBe(false))
}
async function editName(value: string) {
  fireEvent.click(screen.getByRole('button', { name: `แก้ไข ${current.name}` }))
  await screen.findByLabelText('ชื่อสินค้า')
  await waitFor(() => expect((screen.getByLabelText('ชื่อสินค้า').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false))
  fireEvent.change(screen.getByLabelText('ชื่อสินค้า'), { target: { value } })
}
describe('mobile admin journey', () => {
  it('forces a password change before reading any products and never persists admin credentials', async () => {
    await mount(); await login()
    await screen.findByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })
    expect(transport.send.mock.calls.some(call => call[1].startsWith('/api/v1/admin/products'))).toBe(false)
    fireEvent.change(screen.getByLabelText('รหัสผ่านใหม่'), { target: { value: 'new-password-123' } })
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), { target: { value: 'not-matching' } })
    fireEvent.click(screen.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }))
    await screen.findByText('รหัสผ่านทั้งสองช่องไม่ตรงกัน')
    expect(passwords).toEqual(['1234'])
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), { target: { value: 'new-password-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน' }))
    await screen.findByRole('heading', { name: 'สินค้าทั้งระบบ' })
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
    expect(passwords).toEqual(['1234', 'new-password-123'])
  })
  it('shows all-system SKU details, edits metadata, refreshes, and confirms only an acknowledged mutation', async () => {
    const { callbacks } = await mount(); await enterCatalog(); await editName('ข้อมูลกลางใหม่')
    expect(screen.getByText('SKU: IMG-ADMIN')).toBeTruthy()
    expect(screen.queryByLabelText('UPC / EAN')).toBeNull()
    expect(screen.getByText('แก้ข้อมูลกลางทั้งระบบ · ไม่เปลี่ยนยอดซื้อเดิม')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกข้อมูลกลาง' }))
    await screen.findByText('บันทึกข้อมูลกลางแล้ว')
    await waitFor(() => expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe('ข้อมูลกลางใหม่'))
    expect(JSON.parse(patches[0])).toMatchObject({ accountId: account, name: 'ข้อมูลกลางใหม่', expectedRevision: 0 })
    expect(writes).toBe(1); expect(callbacks.onChanged).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })
  it('restores and retries the identical UUID after a lost reply and another admin login without duplicating the write', async () => {
    const first = await mount(); await enterCatalog(); await editName('ชื่อที่ส่งแล้ว'); mode = 'lost'
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกข้อมูลกลาง' }))
    const retry = await screen.findByRole('button', { name: 'ตรวจสอบผลด้วยรหัสเดิม' })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    expect(first.callbacks.onChanged).not.toHaveBeenCalled()
    first.view.unmount()
    await mount(); await login('new-password-123')
    const restored = await screen.findByRole('button', { name: 'ตรวจสอบผลด้วยรหัสเดิม' })
    await waitFor(() => expect((restored as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByLabelText('ชื่อสินค้า').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    fireEvent.click(restored)
    await screen.findByText('บันทึกข้อมูลกลางแล้ว')
    expect(patches).toHaveLength(2); expect(patches[1]).toBe(patches[0]); expect(writes).toBe(1)
  })
  it('keeps the unsent form offline and requires a fresh review after a revision conflict', async () => {
    const { view, props, AdminPanel } = await mount(); await enterCatalog(); await editName('แบบฟอร์มเดิม')
    view.rerender(createElement(AdminPanel, { ...props, online: false }))
    expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe('แบบฟอร์มเดิม')
    expect((screen.getByRole('button', { name: 'บันทึกข้อมูลกลาง' }) as HTMLButtonElement).disabled).toBe(true)
    expect(patches).toHaveLength(0)
    view.rerender(createElement(AdminPanel, props)); mode = 'conflict'
    current = { ...current, name: 'อีกแท็บแก้แล้ว', revision: 1 }
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกข้อมูลกลาง' }))
    await screen.findByRole('button', { name: 'โหลดข้อมูลล่าสุด' })
    expect((screen.getByRole('button', { name: 'บันทึกข้อมูลกลาง' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'โหลดข้อมูลล่าสุด' }))
    await waitFor(() => expect((screen.getByLabelText('ชื่อสินค้า') as HTMLInputElement).value).toBe('อีกแท็บแก้แล้ว'))
    expect(localStorage.length).toBe(0)
  })
  it('returns to admin login when elevation expires while retaining the frozen mutation', async () => {
    await mount(); await enterCatalog(); await editName('รอยืนยัน'); mode = 'expired'
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกข้อมูลกลาง' }))
    await screen.findByLabelText('รหัสผ่านผู้ดูแล')
    expect(localStorage.getItem(`smartcart-admin-edit-v1:${account}`)).toContain('รอยืนยัน')
    mode = 'ok'; await login('new-password-123')
    const retry = await screen.findByRole('button', { name: 'ตรวจสอบผลด้วยรหัสเดิม' })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(retry); await screen.findByText('บันทึกข้อมูลกลางแล้ว')
    expect(patches[1]).toBe(patches[0]); expect(writes).toBe(1)
  })
  it('reports a wrong admin password without opening the catalog, and disables offline login', async () => {
    const { view, props, AdminPanel } = await mount(); await login('wrong')
    await screen.findByText('รหัสผ่านไม่ถูกต้อง')
    expect(screen.queryByRole('heading', { name: 'สินค้าทั้งระบบ' })).toBeNull()
    view.rerender(createElement(AdminPanel, { ...props, online: false }))
    expect((screen.getByRole('button', { name: 'เข้าสู่ระบบผู้ดูแล' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('shows the bottom entry only after server eligibility approval', async () => {
    const { AdminEntry } = await import('../src/AdminPanel')
    const onOpen = vi.fn(), view = render(createElement(AdminEntry, { apiOrigin: '', accountId: account, online: true, onOpen }))
    fireEvent.click(await screen.findByRole('button', { name: 'ผู้ดูแลระบบ' }))
    expect(onOpen).toHaveBeenCalledOnce()
    view.unmount(); transport.send.mockResolvedValue(json({ data: { eligible: false } }))
    render(createElement(AdminEntry, { apiOrigin: '', accountId: 'other', online: true, onOpen }))
    await waitFor(() => expect(transport.send).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'ผู้ดูแลระบบ' })).toBeNull()
  })
})

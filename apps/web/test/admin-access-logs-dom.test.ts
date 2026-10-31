// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/auth-client', () => ({ apiFetch: transport.send }))
const token = 't'.repeat(43), otherToken = 'r'.repeat(43)
const first = { id: 'first', occurredAt: '2026-10-31T00:00:00.000Z', event: 'login_succeeded', outcome: 'success', reason: null,
  userId: 'user-id', displayName: 'ผู้ใช้หนึ่ง', primaryEmail: 'one@example.test', provider: 'google',
  browser: 'Chrome iOS', os: 'iOS', deviceType: 'Mobile', country: 'TH' }
const second = { ...first, id: 'second', event: 'admin_login_failed', outcome: 'failure', reason: 'ADMIN_LOGIN_FAILED', displayName: 'ผู้ใช้สอง' }
const data = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor, retentionDays: 90, collectionStartedAt: '2026-10-31T00:00:00.000Z' })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data: value } : { error: value }), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { vi.resetModules(); localStorage.clear(); sessionStorage.clear(); transport.send.mockReset() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function mount() {
  const { AdminAccessLogs } = await import('../src/AdminAccessLogs'), onSessionError = vi.fn()
  const props = { apiOrigin: '', token, online: true, onSessionError }
  const view = render(createElement(AdminAccessLogs, props))
  return { view, props, onSessionError, AdminAccessLogs }
}

describe('admin access log mobile view', () => {
  it('shows concise account/device/time details with filters, paginates without duplicates and never caches logs', async () => {
    transport.send.mockResolvedValueOnce(json(data([first], 'page-two'))).mockResolvedValueOnce(json(data([first, second])))
      .mockResolvedValueOnce(json(data([second])))
    await mount()
    await screen.findByText('ผู้ใช้หนึ่ง')
    expect(screen.getByText(/ประเทศโดยประมาณ: TH/)).toBeTruthy()
    expect(screen.getByText(/แสดงย้อนหลัง 90 วัน · ลบตามรอบรายวัน · ไม่ใช้คุกกี้ติดตาม/)).toBeTruthy()
    expect(screen.getByText(/เริ่มเก็บหลังอัปเดตนี้ ไม่ใช่ประวัติย้อนหลังทั้งหมด/)).toBeTruthy()
    expect(screen.getByText('เบราว์เซอร์และอุปกรณ์เป็นข้อมูลโดยประมาณ ไม่ใช่รหัสเครื่อง')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ดูประวัติเพิ่มเติม' }))
    await screen.findByText('ผู้ใช้สอง')
    expect(screen.getAllByText('ผู้ใช้หนึ่ง')).toHaveLength(1)
    expect(new URL(transport.send.mock.calls[1][1], 'https://example.test').searchParams.get('cursor')).toBe('page-two')
    fireEvent.change(screen.getByLabelText('ผลลัพธ์'), { target: { value: 'failure' } })
    await waitFor(() => expect(screen.queryByText('ผู้ใช้หนึ่ง')).toBeNull())
    await screen.findByText('ผู้ใช้สอง')
    expect(new URL(transport.send.mock.calls[2][1], 'https://example.test').searchParams.get('outcome')).toBe('failure')
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0)
  })
  it('ignores an old filter response and prevents stale data from appearing', async () => {
    let resolveOld!: (value: Response) => void
    transport.send.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(json(data([second])))
    await mount()
    fireEvent.change(screen.getByLabelText('เหตุการณ์'), { target: { value: 'admin_login_failed' } })
    await screen.findByText('ผู้ใช้สอง')
    await act(async () => { resolveOld(json(data([first]))) })
    expect(screen.queryByText('ผู้ใช้หนึ่ง')).toBeNull()
    expect(screen.getByText('ผู้ใช้สอง')).toBeTruthy()
  })
  it('clears memory when offline and reloads after reconnecting', async () => {
    transport.send.mockResolvedValueOnce(json(data([first]))).mockResolvedValueOnce(json(data([second])))
    const { view, props, AdminAccessLogs } = await mount()
    await screen.findByText('ผู้ใช้หนึ่ง')
    view.rerender(createElement(AdminAccessLogs, { ...props, online: false }))
    expect(screen.queryByText('ผู้ใช้หนึ่ง')).toBeNull()
    expect((screen.getByRole('button', { name: 'รีเฟรช' }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(createElement(AdminAccessLogs, props))
    await screen.findByText('ผู้ใช้สอง')
  })
  it('clears protected data and requests admin sign-in when elevation expires', async () => {
    transport.send.mockResolvedValueOnce(json(data([first]))).mockResolvedValueOnce(json({ code: 'ADMIN_SESSION_REQUIRED' }, 403))
    const { onSessionError } = await mount()
    await screen.findByText('ผู้ใช้หนึ่ง')
    fireEvent.click(screen.getByRole('button', { name: 'รีเฟรช' }))
    await screen.findByRole('alert')
    expect(screen.queryByText('ผู้ใช้หนึ่ง')).toBeNull()
    expect(onSessionError).toHaveBeenCalledOnce()
  })
  it('discards requests after unmount or a changed elevation token', async () => {
    let resolveOld!: (value: Response) => void
    transport.send.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(json(data([second])))
    const { view, props, AdminAccessLogs, onSessionError } = await mount()
    view.rerender(createElement(AdminAccessLogs, { ...props, token: otherToken }))
    await screen.findByText('ผู้ใช้สอง')
    await act(async () => { resolveOld(json({ code: 'ADMIN_SESSION_REQUIRED' }, 403)) })
    expect(onSessionError).not.toHaveBeenCalled()
    expect(screen.getByText('ผู้ใช้สอง')).toBeTruthy()
    view.unmount()
  })
  it('shows empty/error states and recovers with retry without exposing server error text', async () => {
    transport.send.mockResolvedValueOnce(json({ code: 'INTERNAL_ERROR', message: 'SECRET raw request' }, 500))
      .mockResolvedValueOnce(json(data([])))
    await mount()
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('SECRET')
    fireEvent.click(screen.getByRole('button', { name: 'ลองอีกครั้ง' }))
    await screen.findByText('ยังไม่มีประวัติที่ตรงกับตัวกรอง')
  })
})

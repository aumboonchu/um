import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/auth-client', () => ({ apiFetch: transport.send }))
const token = 't'.repeat(43)
const item = { id: 'log-id', occurredAt: '2026-10-31T00:00:00.000Z', event: 'login_succeeded', outcome: 'success', reason: null,
  userId: 'user-id', displayName: 'ชื่อผู้ใช้', primaryEmail: 'user@example.test', provider: 'google',
  browser: 'Chrome iOS', os: 'iOS', deviceType: 'Mobile', country: 'TH' }
const page = { items: [item], nextCursor: 'opaque+/=', retentionDays: 90, collectionStartedAt: '2026-10-30T00:00:00.000Z' }
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { vi.resetModules(); transport.send.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

describe('admin access log client', () => {
  it('sends only documented filters, no-store, and admin elevation without saving logs on the device', async () => {
    const { adminAccessLogs } = await import('../src/admin-client')
    transport.send.mockResolvedValue(json(page))
    const result = await adminAccessLogs('', token, { event: 'login_succeeded', outcome: 'success', cursor: 'opaque+/=' })
    const [, path, init] = transport.send.mock.calls[0], url = new URL(path, 'https://example.test')
    expect(url.pathname).toBe('/api/v1/admin/access-logs')
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '30', event: 'login_succeeded', outcome: 'success', cursor: 'opaque+/=' })
    expect(init.cache).toBe('no-store')
    expect(new Headers(init.headers).get('X-SmartCart-Admin')).toBe(token)
    expect(result).toEqual(page)
  })
  it('accepts empty log history and anonymous failures without making up a user identity', async () => {
    const { adminAccessLogs } = await import('../src/admin-client')
    transport.send.mockResolvedValueOnce(json({ items: [], nextCursor: null, retentionDays: 90, collectionStartedAt: null }))
      .mockResolvedValueOnce(json({ ...page, items: [{ ...item, event: 'login_failed', outcome: 'failure', reason: 'INVALID_LOGIN_CODE',
        userId: null, displayName: null, primaryEmail: null, browser: null, os: null, deviceType: null, country: null }] }))
    expect((await adminAccessLogs('', token)).items).toEqual([])
    expect((await adminAccessLogs('', token)).items[0].userId).toBeNull()
  })
  it('copies only allowed fields instead of retaining raw server diagnostics in UI state', async () => {
    const { adminAccessLogs } = await import('../src/admin-client')
    transport.send.mockResolvedValue(json({ ...page, rawRequest: 'secret', items: [{ ...item, ip: '127.0.0.1', rawUserAgent: 'raw-secret', cookie: 'secret', sessionToken: 'secret' }] }))
    const result = await adminAccessLogs('', token)
    expect(result).toEqual(page)
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('127.0.0.1')
  })
  it.each([
    { event: 'unknown' }, { outcome: ['success'] }, { provider: 'apple' }, { browser: ['Chrome'] }, { browser: 'private raw user agent' },
    { os: 'Custom OS' }, { deviceType: 'fingerprint' }, { country: 'TH\n' }, { country: 'Thailand' },
    { reason: 'raw token secret' }, { reason: 'CODE\nSECRET' }, { id: '' }, { userId: 'x'.repeat(129) },
    { displayName: 'x'.repeat(201) }, { primaryEmail: 'x'.repeat(321) }, { occurredAt: '2026-02-30T00:00:00.000Z' },
    { occurredAt: '2026-10-31' }, { primaryEmail: 'foo\nbar' },
  ])('rejects malformed log item %j', async patch => {
    const { adminAccessLogs } = await import('../src/admin-client')
    transport.send.mockResolvedValue(json({ ...page, items: [{ ...item, ...patch }] }))
    await expect(adminAccessLogs('', token)).rejects.toMatchObject({ code: 'ADMIN_RESPONSE_INVALID' })
  })
  it.each([
    { retentionDays: 0 }, { retentionDays: 91 }, { nextCursor: 'x'.repeat(2049) }, { nextCursor: '' },
    { collectionStartedAt: 'not a date' }, { items: Array.from({ length: 31 }, (_, i) => ({ ...item, id: `log-${i}` })) },
    { items: [item, item] },
  ])('rejects malformed or unbounded pages %j', async patch => {
    const { adminAccessLogs } = await import('../src/admin-client')
    transport.send.mockResolvedValue(json({ ...page, ...patch }))
    await expect(adminAccessLogs('', token)).rejects.toMatchObject({ code: 'ADMIN_RESPONSE_INVALID' })
  })
})

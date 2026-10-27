import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = 'https://smartcart-api-staging.example.test'
const anotherApi = 'https://other-api.example.test'
const legacyKey = 'smartcart-session'
const key = `smartcart-session-v2:${encodeURIComponent(api)}`
const token = 'a'.repeat(43)
const newerToken = 'b'.repeat(43)
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

function storage() {
  const data = new Map<string, string>()
  return { data, get length() { return data.size }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }), clear: vi.fn(() => data.clear()),
  }
}
function record(value = token, storedAt = Date.now(), expiry = expiresAt) { return JSON.stringify({ token: value, expiresAt: expiry, apiOrigin: api, storedAt }) }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) }
let persistent: ReturnType<typeof storage>
let tab: ReturnType<typeof storage>
let location: { origin: string; pathname: string; search: string; hash: string; assign: ReturnType<typeof vi.fn> }
let replaceState: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetModules()
  persistent = storage(); tab = storage()
  vi.stubGlobal('localStorage', persistent); vi.stubGlobal('sessionStorage', tab)
  location = { origin: 'https://app.example.test', pathname: '/um/', search: '', hash: '', assign: vi.fn() }
  replaceState = vi.fn(() => { location.hash = '' })
  vi.stubGlobal('window', { location, history: { replaceState } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('remembered browser sessions', () => {
  it('survives closing a tab and reloading the application module', async () => {
    persistent.setItem(key, record())
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { authenticated: true } })))
    const first = await import('../src/auth-client')
    await first.apiFetch(api, '/auth/me')
    tab = storage(); vi.stubGlobal('sessionStorage', tab); vi.resetModules()
    const reopened = await import('../src/auth-client')
    await reopened.apiFetch(api, '/auth/me')
    expect(reopened.browserSessionInfo(api)).toEqual({ remembered: true, expiresAt })
    expect(new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(location.assign).not.toHaveBeenCalled()
  })

  it('upgrades the current tab without logging in again or extending server expiration', async () => {
    tab.setItem(legacyKey, JSON.stringify({ token, expiresAt }))
    const auth = await import('../src/auth-client')
    expect(auth.browserSessionInfo(api)).toEqual({ remembered: true, expiresAt })
    expect(JSON.parse(persistent.getItem(key)!)).toMatchObject({ token, expiresAt, apiOrigin: api })
    expect(tab.getItem(legacyKey)).toBeNull()
  })

  it('keeps a valid legacy session when migration storage writes are blocked', async () => {
    tab.setItem(legacyKey, JSON.stringify({ token, expiresAt }))
    persistent.setItem.mockImplementation(() => { throw new Error('quota') })
    tab.setItem.mockImplementation(() => { throw new Error('quota') })
    const auth = await import('../src/auth-client')
    expect(auth.browserSessionInfo(api)).toEqual({ remembered: false, expiresAt })
    expect(tab.getItem(legacyKey)).not.toBeNull()
  })

  it.each(['{bad', 'null', JSON.stringify({ token: 'bad' }), record(token, Date.now(), 'invalid'), record(token, Date.now(), new Date(0).toISOString())])('ignores and removes malformed/expired session %#', async (raw) => {
    persistent.setItem(key, raw)
    const auth = await import('../src/auth-client')
    expect(auth.browserSessionInfo(api)).toBeNull()
    expect(persistent.getItem(key)).toBeNull()
  })

  it('never sends remembered tokens to another API origin or an absolute URL outside the API', async () => {
    persistent.setItem(key, record())
    const send = vi.fn<typeof fetch>(async () => json({ data: {} })); vi.stubGlobal('fetch', send)
    const auth = await import('../src/auth-client')
    await auth.apiFetch(anotherApi, '/api/v1/health')
    expect(new Headers(send.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
    await expect(auth.apiFetch(api, 'https://evil.example.test/collect')).rejects.toThrow('INVALID_API_DESTINATION')
    expect(send).toHaveBeenCalledTimes(1)
    expect(persistent.getItem(key)).not.toBeNull()
  })

  it('rejects a record whose API origin does not match its storage key', async () => {
    persistent.setItem(key, JSON.stringify({ ...JSON.parse(record()), apiOrigin: anotherApi }))
    expect((await import('../src/auth-client')).browserSessionInfo(api)).toBeNull()
  })

  it('uses a newer tab-only account when persistent storage cannot replace an older account', async () => {
    persistent.setItem(key, record(token, 1))
    tab.setItem(key, record(newerToken, 2))
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: {} })))
    const auth = await import('../src/auth-client')
    await auth.apiFetch(api, '/api/v1/health')
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${newerToken}`)
    expect(auth.browserSessionInfo(api)?.remembered).toBe(false)
  })

  it('logout clears current-origin login stores, not pending purchases/images or other API sessions', async () => {
    persistent.setItem(key, record()); tab.setItem(key, record()); tab.setItem(legacyKey, JSON.stringify({ token, expiresAt }))
    persistent.setItem('smartcart-image-pending-v1:account:op', 'keep')
    persistent.setItem(`smartcart-session-v2:${encodeURIComponent(anotherApi)}`, 'keep-other')
    const auth = await import('../src/auth-client'); auth.clearBrowserSession(api)
    expect(auth.browserSessionInfo(api)).toBeNull()
    expect(tab.getItem(legacyKey)).toBeNull()
    expect(persistent.getItem('smartcart-image-pending-v1:account:op')).toBe('keep')
    expect(persistent.getItem(`smartcart-session-v2:${encodeURIComponent(anotherApi)}`)).toBe('keep-other')
    expect(persistent.clear).not.toHaveBeenCalled()
  })

  it('does not reuse a token in this page if browser removal unexpectedly fails after logout', async () => {
    persistent.setItem(key, record()); persistent.removeItem.mockImplementation(() => { throw new Error('blocked') })
    const auth = await import('../src/auth-client'); auth.clearBrowserSession(api)
    expect(auth.browserSessionInfo(api)).toBeNull()
  })

  it.each([401, 200])('clears revoked/invalid authentication on auth response %s', async (status) => {
    persistent.setItem(key, record())
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { authenticated: false } }, status)))
    const auth = await import('../src/auth-client')
    const response = await auth.apiFetch(api, '/auth/me')
    expect(auth.browserSessionInfo(api)).toBeNull()
    expect(await response.json()).toEqual({ data: { authenticated: false } })
  })

  it.each(['offline', '500', 'malformed'])('keeps the remembered session after a transient %s failure', async (failure) => {
    persistent.setItem(key, record())
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'offline') throw new TypeError('offline')
      return failure === '500' ? json({ error: {} }, 500) : new Response('invalid json')
    }))
    const auth = await import('../src/auth-client')
    await auth.apiFetch(api, '/auth/me').catch(() => {})
    expect(auth.browserSessionInfo(api)).toEqual({ remembered: true, expiresAt })
  })

  it.each([401, 200])('a late response %s for an old token does not clear a newer login', async (status) => {
    persistent.setItem(key, record(token, 1))
    let resolve!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done })))
    const auth = await import('../src/auth-client')
    const request = auth.apiFetch(api, '/auth/me')
    persistent.setItem(key, record(newerToken, 2))
    resolve(json({ data: { authenticated: false } }, status)); await request
    expect(JSON.parse(persistent.getItem(key)!).token).toBe(newerToken)
  })

  it('recognizes only localStorage events for this API session (or an origin-wide clear)', async () => {
    const auth = await import('../src/auth-client')
    expect(auth.isBrowserSessionChange({ key, storageArea: persistent }, api)).toBe(true)
    expect(auth.isBrowserSessionChange({ key: null, storageArea: persistent }, api)).toBe(true)
    expect(auth.isBrowserSessionChange({ key: 'smartcart-image-pending-v1:account', storageArea: persistent }, api)).toBe(false)
    expect(auth.isBrowserSessionChange({ key, storageArea: tab }, api)).toBe(false)
  })

  it('tolerates storage access restrictions for public API calls', async () => {
    persistent.getItem.mockImplementation(() => { throw new Error('blocked') }); tab.getItem.mockImplementation(() => { throw new Error('blocked') })
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: {} })))
    const auth = await import('../src/auth-client')
    expect((await auth.apiFetch(api, '/api/v1/health')).status).toBe(200)
    auth.clearBrowserSession(api)
  })
})

describe('Google login completion with persistent storage', () => {
  function prepareLogin() {
    location.hash = `#login_code=${'c'.repeat(43)}`
    tab.setItem('smartcart-login-verifier', 'v'.repeat(64))
    const send = vi.fn<typeof fetch>(async () => {
      expect(location.hash).toBe('')
      return json({ data: { sessionToken: token, expiresAt } })
    })
    vi.stubGlobal('fetch', send)
    return send
  }

  it('stores only the opaque app session, strips the handoff before exchange, and handles StrictMode once', async () => {
    const send = prepareLogin(); const auth = await import('../src/auth-client')
    expect(await Promise.all([auth.finishGoogleLogin(api), auth.finishGoogleLogin(api)])).toEqual([true, true])
    expect(send).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledBefore(send)
    expect(auth.browserSessionInfo(api)).toEqual({ remembered: true, expiresAt })
    expect(JSON.parse(persistent.getItem(key)!)).toEqual({ token, expiresAt, apiOrigin: api, storedAt: expect.any(Number) })
    expect(persistent.getItem('smartcart-login-verifier')).toBeNull()
    expect(tab.getItem('smartcart-login-verifier')).toBeNull()
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({ code: 'c'.repeat(43), codeVerifier: 'v'.repeat(64) })
  })

  it('falls back to this tab only if persistent storage is blocked', async () => {
    prepareLogin(); persistent.setItem.mockImplementation(() => { throw new Error('quota') })
    const auth = await import('../src/auth-client'); expect(await auth.finishGoogleLogin(api)).toBe(true)
    expect(auth.browserSessionInfo(api)).toEqual({ remembered: false, expiresAt })
    expect(persistent.getItem(key)).toBeNull()
    expect(tab.getItem(key)).not.toBeNull()
  })

  it('rejects a login that cannot be stored anywhere instead of claiming it is remembered', async () => {
    prepareLogin(); persistent.setItem.mockImplementation(() => {}); tab.setItem.mockImplementation(() => {})
    const auth = await import('../src/auth-client')
    await expect(auth.finishGoogleLogin(api)).rejects.toThrow('LOGIN_STORAGE_UNAVAILABLE')
    expect(auth.browserSessionInfo(api)).toBeNull()
  })

  it('rejects invalid or expired login responses', async () => {
    prepareLogin(); vi.stubGlobal('fetch', vi.fn(async () => json({ data: { sessionToken: token, expiresAt: new Date(0).toISOString() } })))
    const auth = await import('../src/auth-client')
    await expect(auth.finishGoogleLogin(api)).rejects.toThrow('LOGIN_RESPONSE_INVALID')
    expect(auth.browserSessionInfo(api)).toBeNull()
  })

  it('keeps PKCE verifier only in sessionStorage, never localStorage or a URL', async () => {
    const auth = await import('../src/auth-client'); await auth.startGoogleLogin(api)
    expect(tab.getItem('smartcart-login-verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(persistent.length).toBe(0)
    const url = new URL(location.assign.mock.calls[0][0])
    expect(url.searchParams.has('app_code_challenge')).toBe(true)
    expect(url.toString()).not.toContain(tab.getItem('smartcart-login-verifier')!)
  })
})

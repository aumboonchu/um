const SESSION_KEY = 'smartcart-session'
const VERIFIER_KEY = 'smartcart-login-verifier'
let loginCompletion: Promise<boolean> | undefined
type BrowserSession = { token: string; expiresAt: string; apiOrigin: string; storedAt: number }
type StoredSession = { session: BrowserSession; remembered: boolean }
const ignoredTokens = new Set<string>()

function sessionKey(apiOrigin: string): string { return `smartcart-session-v2:${encodeURIComponent(new URL(apiOrigin).origin)}` }
function browserStorage(remembered: boolean): Storage | null {
  try { return remembered ? localStorage : sessionStorage } catch { return null }
}
function removeStored(storage: Storage | null, key: string, expected?: string): void {
  try { if (expected === undefined || storage?.getItem(key) === expected) storage?.removeItem(key) } catch { /* Server revocation still takes precedence if browser storage is restricted. */ }
}
function readStored(apiOrigin: string, remembered: boolean): StoredSession | null {
  const storage = browserStorage(remembered)
  const key = sessionKey(apiOrigin)
  let raw: string | null = null
  try {
    raw = storage?.getItem(key) ?? null
    if (!raw) return null
    const session: unknown = raw.length <= 4096 ? JSON.parse(raw) : null
    if (validSession(session) && session.apiOrigin === new URL(apiOrigin).origin && !ignoredTokens.has(session.token)) return { session, remembered }
    removeStored(storage, key, raw)
  } catch { if (raw) removeStored(storage, key, raw) }
  return null
}

function validSession(session: unknown): session is BrowserSession {
  return typeof session === 'object' && session !== null && 'token' in session && 'expiresAt' in session && 'apiOrigin' in session && 'storedAt' in session
    && typeof session.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(session.token)
    && typeof session.expiresAt === 'string' && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > Date.now()
    && typeof session.apiOrigin === 'string' && typeof session.storedAt === 'number' && Number.isFinite(session.storedAt)
}

function saveSession(apiOrigin: string, token: string, expiresAt: string): StoredSession {
  const session = { token, expiresAt, apiOrigin: new URL(apiOrigin).origin, storedAt: Date.now() }
  const key = sessionKey(apiOrigin), raw = JSON.stringify(session)
  for (const remembered of [true, false]) {
    const storage = browserStorage(remembered)
    try {
      storage?.setItem(key, raw)
      if (storage?.getItem(key) !== raw) continue
      ignoredTokens.delete(token)
      if (remembered) removeStored(browserStorage(false), key)
      removeStored(browserStorage(false), SESSION_KEY)
      return { session, remembered }
    } catch { /* Fall back to this tab only, with a visible UI notice. */ }
  }
  throw new Error('LOGIN_STORAGE_UNAVAILABLE')
}

function storedSession(apiOrigin: string): StoredSession | null {
  const persistent = readStored(apiOrigin, true), tab = readStored(apiOrigin, false)
  if (persistent || tab) {
    // A newer tab-only login must not be shadowed by an older persistent account.
    return tab && (!persistent || tab.session.storedAt >= persistent.session.storedAt) ? tab : persistent
  }
  // Upgrade an existing open tab without asking the user to log in again.
  const storage = browserStorage(false)
  let raw: string | null = null
  try {
    raw = storage?.getItem(SESSION_KEY) ?? null
    if (!raw) return null
    const legacy = JSON.parse(raw)
    if (typeof legacy?.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(legacy.token)
      && typeof legacy.expiresAt === 'string' && Number.isFinite(Date.parse(legacy.expiresAt)) && Date.parse(legacy.expiresAt) > Date.now()
      && !ignoredTokens.has(legacy.token)) {
      try { return saveSession(apiOrigin, legacy.token, legacy.expiresAt) }
      catch { return { session: { token: legacy.token, expiresAt: legacy.expiresAt, apiOrigin: new URL(apiOrigin).origin, storedAt: 0 }, remembered: false } }
    }
  } catch { /* An unavailable store must not make public API requests fail. */ }
  if (raw) removeStored(storage, SESSION_KEY, raw)
  return null
}

export function browserSessionInfo(apiOrigin: string): { remembered: boolean; expiresAt: string } | null {
  const stored = storedSession(apiOrigin)
  return stored ? { remembered: stored.remembered, expiresAt: stored.session.expiresAt } : null
}

export function isBrowserSessionChange(event: Pick<StorageEvent, 'key' | 'storageArea'>, apiOrigin: string): boolean {
  const storage = browserStorage(true)
  return storage !== null && event.storageArea === storage && (event.key === sessionKey(apiOrigin) || event.key === null)
}

export function clearBrowserSession(apiOrigin: string, expectedToken?: string): void {
  for (const remembered of [true, false]) {
    const storage = browserStorage(remembered)
    for (const key of remembered ? [sessionKey(apiOrigin)] : [sessionKey(apiOrigin), SESSION_KEY]) {
      try {
        const raw = storage?.getItem(key)
        if (!raw) continue
        let token: unknown
        try { token = JSON.parse(raw).token } catch { /* Remove corrupt data only on an explicit logout. */ }
        if (expectedToken !== undefined && token !== expectedToken) continue
        if (typeof token === 'string') ignoredTokens.add(token)
        removeStored(storage, key, raw)
      } catch { /* Do not erase offline purchases or pending image confirmations. */ }
    }
  }
}

export async function apiFetch(apiOrigin: string, path: string, init: RequestInit = {}): Promise<Response> {
  const destination = new URL(path, apiOrigin)
  if (destination.origin !== new URL(apiOrigin).origin) throw new Error('INVALID_API_DESTINATION')
  const headers = new Headers(init.headers)
  // Only this client stores personalized product responses in account-scoped caches.
  if (destination.pathname.startsWith('/api/v1/products')) headers.set('X-SmartCart-Profile', '1')
  const token = storedSession(apiOrigin)?.session.token
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(destination, { ...init, headers, credentials: 'omit', cache: 'no-store' })
  if (response.status === 401 && token) clearBrowserSession(apiOrigin, token)
  if (response.ok && destination.pathname === '/auth/me' && token) {
    try {
      const payload = await response.clone().json() as { data?: { authenticated?: boolean } }
      if (payload.data?.authenticated === false) clearBrowserSession(apiOrigin, token)
    } catch { /* Keep the session on malformed / transient responses; never invent an authenticated account. */ }
  }
  return response
}

export async function startGoogleLogin(apiOrigin: string): Promise<void> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
  // Check storage before leaving the app; it must survive the Google redirect.
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const destination = new URL('/auth/google/start', apiOrigin)
  destination.search = new URLSearchParams({
    return_to: `${window.location.origin}${window.location.pathname}`,
    app_code_challenge: challenge,
  }).toString()
  window.location.assign(destination.toString())
}

export function finishGoogleLogin(apiOrigin: string): Promise<boolean> {
  // React StrictMode may initialize twice: a one-use code must be exchanged only once.
  loginCompletion ??= completeLogin(apiOrigin)
  return loginCompletion
}

async function completeLogin(apiOrigin: string): Promise<boolean> {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const code = fragment.get('login_code')
  if (!code) return false
  // Remove the handoff code before any network request or other UI work.
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
  const codeVerifier = sessionStorage.getItem(VERIFIER_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  if (!codeVerifier) throw new Error('LOGIN_BROWSER_MISMATCH')
  const response = await fetch(new URL('/auth/exchange', apiOrigin), {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier }),
  })
  if (!response.ok) throw new Error('LOGIN_EXCHANGE_FAILED')
  const payload: unknown = await response.json()
  if (typeof payload !== 'object' || !payload || !('data' in payload)) throw new Error('LOGIN_RESPONSE_INVALID')
  const data = payload.data
  if (typeof data !== 'object' || !data || !('sessionToken' in data) || !('expiresAt' in data)
    || typeof data.sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.sessionToken)
    || typeof data.expiresAt !== 'string' || Date.parse(data.expiresAt) <= Date.now()
    || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error('LOGIN_RESPONSE_INVALID')
  saveSession(apiOrigin, data.sessionToken, data.expiresAt)
  return true
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

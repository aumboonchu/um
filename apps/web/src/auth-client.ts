const SESSION_KEY = 'smartcart-session'
const VERIFIER_KEY = 'smartcart-login-verifier'
let loginCompletion: Promise<boolean> | undefined

function sessionToken(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const session: unknown = JSON.parse(raw)
    if (typeof session === 'object' && session && 'token' in session && 'expiresAt' in session
      && typeof session.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(session.token)
      && typeof session.expiresAt === 'string' && Date.parse(session.expiresAt) > Date.now()) return session.token
    clearBrowserSession()
  } catch { /* Storage can be unavailable in restricted browsing contexts. */ }
  return null
}

export function clearBrowserSession(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

export async function apiFetch(apiOrigin: string, path: string, init: RequestInit = {}): Promise<Response> {
  const destination = new URL(path, apiOrigin)
  if (destination.origin !== new URL(apiOrigin).origin) throw new Error('INVALID_API_DESTINATION')
  const headers = new Headers(init.headers)
  const token = sessionToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(destination, { ...init, headers, credentials: 'omit', cache: 'no-store' })
  if (response.status === 401) clearBrowserSession()
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
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: data.sessionToken, expiresAt: data.expiresAt }))
  return true
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}


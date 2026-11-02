import { applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import app from '../src/index'
import { appUrls, isAppOrigin, safeAppReturnTo } from '../src/app-origins'
import { isTrustedOrigin, type AuthEnv } from '../src/auth'

const oldUrl = 'https://aumboonchu.github.io/um/', oldOrigin = 'https://aumboonchu.github.io'
const buyUrl = 'https://aumboonchu.com/buy/', buyOrigin = 'https://aumboonchu.com'
const multiEnv: AuthEnv = { ...env, APP_URL: oldUrl, APP_ORIGIN: oldOrigin,
  ADDITIONAL_APP_URLS: '["https://aumboonchu.com/buy/"]',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' }
const verifier = 'v'.repeat(64), loginCode = 'c'.repeat(43), userId = 'frontend-origin-user'
async function digest(value: string, encoding: 'hex' | 'url' = 'hex') {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return encoding === 'hex' ? [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
    : btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').bind(userId, 'Frontend test').run()
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterAll(() => fetchMock.deactivate())
function call(path: string, method = 'GET', origin: string | null = null, body?: unknown) {
  const headers = new Headers()
  if (origin !== null) headers.set('Origin', origin)
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return app.fetch(new Request(`https://api.test${path}`, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), multiEnv)
}
async function start(returnTo: string) {
  const params = new URLSearchParams({ return_to: returnTo, app_code_challenge: await digest(verifier, 'url') })
  const response = await call(`/auth/google/start?${params}`)
  const google = new URL(response.headers.get('Location')!)
  return { response, google, state: google.searchParams.get('state')! }
}
async function seedLogin() {
  await env.DB.prepare('INSERT INTO auth_login_codes(code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)')
    .bind(await digest(loginCode), userId, await digest(verifier, 'url'), new Date(Date.now() + 60_000).toISOString()).run()
}

describe('exact frontend URL and origin configuration', () => {
  it('adds only the exact new origin and keeps the original origin', () => {
    expect(appUrls(multiEnv).map(url => url.href)).toEqual([oldUrl, buyUrl])
    expect(isAppOrigin(oldOrigin, multiEnv)).toBe(true)
    expect(isAppOrigin(buyOrigin, multiEnv)).toBe(true)
    for (const origin of [null, undefined, '', 'null', `${buyOrigin}/`, `${buyOrigin}.evil.test`, 'https://www.aumboonchu.com', 'http://aumboonchu.com', 'https://aumboonchu.com:444', `${buyOrigin}/buy/`])
      expect(isAppOrigin(origin, multiEnv)).toBe(false)
    expect(isTrustedOrigin(new Request('https://api.test'), multiEnv)).toBe(true)
    expect(isTrustedOrigin(new Request('https://api.test', { headers: { Origin: buyOrigin } }), multiEnv)).toBe(true)
  })
  it.each(['not json', '{}', '[null]', '[123]', '["https://evil.test/"]oops',
    '["https://aumboonchu.com/buy/", "https://example.test/path*"]', '["https://name:pass@aumboonchu.com/buy/"]',
    '["https://aumboonchu.com/buy/?x=1"]', '["https://aumboonchu.com/buy/#x"]', '["javascript:alert(1)"]',
    '["http://aumboonchu.com/buy/"]', '["https://aumboonchu.com/buy"]', JSON.stringify(Array(9).fill(buyUrl)), 'x'.repeat(8193)])(
  'a malformed additional frontend list does not grant additional access (%s)', raw => {
    const config = { APP_URL: oldUrl, APP_ORIGIN: oldOrigin, ADDITIONAL_APP_URLS: raw }
    expect(appUrls(config).map(url => url.href)).toEqual([oldUrl])
    expect(isAppOrigin(buyOrigin, config)).toBe(false)
    expect(isAppOrigin(oldOrigin, config)).toBe(true)
  })
  it('keeps local configuration unchanged when no additional URL is set', () => {
    expect(appUrls(env).map(url => url.href)).toEqual([env.APP_URL])
    expect(isAppOrigin(buyOrigin, env)).toBe(false)
    expect(appUrls({ APP_URL: 'https://example.test/', APP_ORIGIN: 'https://mismatch.test' })).toEqual([])
    expect(appUrls({ APP_URL: 'https://example.test/', APP_ORIGIN: 'https://mismatch.test',
      ADDITIONAL_APP_URLS: '["https://aumboonchu.com/buy/"]' })).toEqual([])
  })
  it('allows exact return paths and preserves ordinary query/fragment data only on those paths', () => {
    for (const url of [oldUrl, buyUrl, `${buyUrl}?view=products#section`]) expect(safeAppReturnTo(url, multiEnv)).toBe(url)
    for (const url of ['https://evil.test/', `${buyOrigin}/`, `${buyOrigin}/buy`, `${buyOrigin}/buyer/`,
      `${buyUrl}nested/`, 'https://aumboonchu.com.evil.test/buy/', 'https://name:pass@aumboonchu.com/buy/',
      'https://aumboonchu.com:444/buy/', 'http://aumboonchu.com/buy/', '//aumboonchu.com/buy/', `${buyOrigin}/%62uy/`,
      'https:\\aumboonchu.com/buy/', `${buyUrl}\n`, 'x'.repeat(4097)]) expect(safeAppReturnTo(url, multiEnv)).toBe(oldUrl)
  })
})

describe('both frontend origins use the same protected API and OAuth callback', () => {
  it.each([oldOrigin, buyOrigin])('allows CORS for %s without adding cookies', async origin => {
    const response = await call('/auth/me', 'GET', origin)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(response.headers.get('Set-Cookie')).toBeNull()
    const preflight = await app.fetch(new Request('https://api.test/api/v1/admin/products/x', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type,x-smartcart-admin' },
    }), multiEnv)
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('X-SmartCart-Admin')
  })
  it.each(['https://evil.test', 'https://aumboonchu.com.evil.test', 'null'])('rejects foreign CORS/exchange origin %s', async origin => {
    const me = await call('/auth/me', 'GET', origin)
    expect(me.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect((await call('/auth/exchange', 'POST', origin, { code: loginCode, codeVerifier: verifier })).status).toBe(403)
  })
  it.each([oldUrl, buyUrl])('stores the exact initiating frontend %s and keeps the registered callback', async returnTo => {
    const { google, state } = await start(returnTo)
    expect(google.searchParams.get('redirect_uri')).toBe(`${env.API_ORIGIN}/auth/google/callback`)
    expect(google.searchParams.get('scope')).toBe('openid email profile')
    expect(google.searchParams.get('code_challenge_method')).toBe('S256')
    expect(await env.DB.prepare('SELECT return_to FROM auth_transactions WHERE state_hash = ?').bind(await digest(state)).first('return_to')).toBe(returnTo)
  })
  it.each([oldUrl, buyUrl])('returns a verified cancellation to %s but still consumes state once', async returnTo => {
    const { state } = await start(returnTo)
    const callback = `/auth/google/callback?error=access_denied&state=${state}`
    const first = await call(callback)
    expect(first.headers.get('Location')).toBe(`${returnTo}?auth=failed`)
    expect(first.headers.get('Set-Cookie')).toBeNull()
    const replay = await call(callback)
    expect(replay.headers.get('Location')).toBe(`${oldUrl}?auth=failed`)
  })
  it('returns setup and malformed-start errors only to explicitly approved return URLs', async () => {
    const noGoogle: AuthEnv = { ...multiEnv, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }
    const setup = await app.fetch(new Request(`https://api.test/auth/google/start?return_to=${encodeURIComponent(buyUrl)}`), noGoogle)
    expect(setup.headers.get('Location')).toBe(`${buyUrl}?auth=setup_required`)
    expect((await call(`/auth/google/start?return_to=${encodeURIComponent(buyUrl + 'nested/')}`)).headers.get('Location')).toBe(`${oldUrl}?auth=failed`)
    expect((await call(`/auth/google/start?return_to=${encodeURIComponent(buyUrl)}`)).headers.get('Location')).toBe(`${buyUrl}?auth=failed`)
  })
  it.each([oldOrigin, buyOrigin])('exchanges a PKCE handoff from %s without changing its single-use guarantees', async origin => {
    await seedLogin()
    expect((await call('/auth/exchange', 'POST', null, { code: loginCode, codeVerifier: verifier })).status).toBe(403)
    expect((await call('/auth/exchange', 'POST', origin, { code: loginCode, codeVerifier: 'x'.repeat(64) })).status).toBe(400)
    const good = await call('/auth/exchange', 'POST', origin, { code: loginCode, codeVerifier: verifier })
    expect(good.status).toBe(200)
    expect(good.headers.get('Set-Cookie')).toBeNull()
    expect((await call('/auth/exchange', 'POST', origin, { code: loginCode, codeVerifier: verifier })).status).toBe(400)
  })
  it('completes verified Google login back to /buy/ and exchanges on its origin using the unchanged API callback', async () => {
    const keys = await generateKeyPair('RS256', { extractable: true }), jwk = await exportJWK(keys.publicKey)
    fetchMock.get('https://www.googleapis.com').intercept({ path: '/oauth2/v3/certs' })
      .reply(200, JSON.stringify({ keys: [{ ...jwk, kid: 'buy-test-key', alg: 'RS256', use: 'sig' }] }), { headers: { 'Content-Type': 'application/json' } })
    const { state } = await start(buyUrl)
    const nonce = await env.DB.prepare('SELECT nonce FROM auth_transactions WHERE state_hash = ?').bind(await digest(state)).first<string>('nonce')
    const idToken = await new SignJWT({ nonce, email: 'buy-fixture@example.test', name: 'Buy test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'buy-test-key' }).setIssuer('https://accounts.google.com')
      .setAudience(multiEnv.GOOGLE_CLIENT_ID!).setSubject('buy-fixture-subject').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
    fetchMock.get('https://oauth2.googleapis.com').intercept({ path: '/token', method: 'POST' })
      .reply(200, JSON.stringify({ id_token: idToken }), { headers: { 'Content-Type': 'application/json' } })
    const callback = await call(`/auth/google/callback?state=${state}&code=test-provider-code`)
    const destination = new URL(callback.headers.get('Location')!)
    expect(`${destination.origin}${destination.pathname}`).toBe(buyUrl)
    const code = new URLSearchParams(destination.hash.slice(1)).get('login_code')!
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const exchanged = await call('/auth/exchange', 'POST', buyOrigin, { code, codeVerifier: verifier })
    expect(exchanged.status).toBe(200)
    expect(exchanged.headers.get('Set-Cookie')).toBeNull()
    const { data } = await exchanged.json<{ data: { sessionToken: string } }>()
    const me = await app.fetch(new Request('https://api.test/auth/me', { headers: { Origin: buyOrigin, Authorization: `Bearer ${data.sessionToken}` } }), multiEnv)
    expect(await me.json()).toMatchObject({ data: { authenticated: true, account: { primaryEmail: 'buy-fixture@example.test' } } })
    fetchMock.assertNoPendingInterceptors()
  })
  it('returns a consumed provider failure to the initiating /buy/ frontend without granting an authenticated handoff', async () => {
    const { state } = await start(buyUrl)
    fetchMock.get('https://oauth2.googleapis.com').intercept({ path: '/token', method: 'POST' })
      .reply(400, JSON.stringify({ error: 'invalid_grant' }), { headers: { 'Content-Type': 'application/json' } })
    const callback = await call(`/auth/google/callback?state=${state}&code=invalid-provider-code`)
    expect(callback.headers.get('Location')).toBe(`${buyUrl}?auth=failed`)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions').first('n')).toBe(0)
    fetchMock.assertNoPendingInterceptors()
  })
  it('uses the same exact allowlist for protected writes and still rejects missing Origin', async () => {
    const token = 't'.repeat(43)
    await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .bind('frontend-write-session', userId, await digest(token), new Date(Date.now() + 60_000).toISOString()).run()
    for (const [path, method] of [['/api/v1/admin/login', 'POST'], ['/api/v1/products/missing/detail', 'PATCH'],
      ['/api/v1/purchases/missing', 'PATCH'], ['/api/v1/purchases/missing', 'DELETE']] as const) {
      for (const origin of [oldOrigin, buyOrigin, 'https://evil.test', null]) {
        const headers = new Headers({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
        if (origin !== null) headers.set('Origin', origin)
        const response = await app.fetch(new Request(`https://api.test${path}`, { method, headers,
          body: JSON.stringify(path.includes('/admin/') ? { accountId: userId, password: 'not-admin' } : {}) }), multiEnv)
        const body = await response.json<{ error: { code: string } }>()
        if (origin === oldOrigin || origin === buyOrigin) {
          expect(response.status).not.toBe(401)
          expect(body.error.code).not.toBe('UNTRUSTED_ORIGIN')
          if (path.includes('/admin/')) expect(body.error.code).toBe('ADMIN_FORBIDDEN')
        } else {
          expect(response.status).toBe(403)
          expect(body.error.code).toBe('UNTRUSTED_ORIGIN')
        }
      }
    }
  })
})

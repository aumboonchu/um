import { applyD1Migrations, env, fetchMock, SELF } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import app from '../src/index'

const configuredEnv = { ...env, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-only-secret' }
const verifier = 'v'.repeat(64)
const loginCode = 'c'.repeat(43)
const userId = 'auth-test-user'

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').bind(userId, 'Auth test').run()
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterAll(() => fetchMock.deactivate())

async function hash(value: string, format: 'hex' | 'base64' = 'hex'): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return format === 'hex' ? [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function seedLogin(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  await env.DB.prepare('INSERT INTO auth_login_codes (code_hash, user_id, code_challenge, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hash(loginCode), userId, await hash(verifier, 'base64'), expiresAt).run()
}

function exchange(codeVerifier = verifier, origin: string = env.APP_ORIGIN) {
  return SELF.fetch('https://example.com/auth/exchange', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: loginCode, codeVerifier }),
  })
}

describe('Google Login and cross-site browser sessions', () => {
  it('exposes readiness without exposing credentials and disables caching', async () => {
    const response = await SELF.fetch('https://example.com/auth/config')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ data: { googleEnabled: false } })
  })

  it('returns setup failures to the configured GitHub Pages path', async () => {
    const response = await app.fetch(new Request('https://example.com/auth/google/start'), {
      ...env, APP_ORIGIN: 'https://aumboonchu.github.io', APP_URL: 'https://aumboonchu.github.io/um/',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://aumboonchu.github.io/um/?auth=setup_required')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('starts Google with PKCE and ignores return URLs outside this app', async () => {
    const challenge = await hash(verifier, 'base64')
    const response = await app.fetch(new Request(`https://example.com/auth/google/start?app_code_challenge=${challenge}&return_to=https://evil.example/`), configuredEnv)
    expect(response.status).toBe(302)
    const google = new URL(response.headers.get('Location')!)
    expect(google.origin).toBe('https://accounts.google.com')
    expect(google.searchParams.get('client_id')).toBe(configuredEnv.GOOGLE_CLIENT_ID)
    expect(google.searchParams.get('code_challenge_method')).toBe('S256')
    const transaction = await env.DB.prepare('SELECT return_to, browser_code_challenge FROM auth_transactions WHERE state_hash = ?')
      .bind(await hash(google.searchParams.get('state')!)).first()
    expect(transaction).toMatchObject({ return_to: env.APP_URL, browser_code_challenge: challenge })
  })

  it('rejects login initiation without a browser challenge', async () => {
    const response = await app.fetch(new Request('https://example.com/auth/google/start'), configuredEnv)
    expect(response.headers.get('Location')).toBe(`${env.APP_URL}?auth=failed`)
  })

  it('returns to the app on Google cancellation and invalid state', async () => {
    for (const query of ['error=access_denied', 'code=unknown&state=unknown']) {
      const response = await app.fetch(new Request(`https://example.com/auth/google/callback?${query}`), configuredEnv)
      expect(response.headers.get('Location')).toBe(`${env.APP_URL}?auth=failed`)
    }
  })

  it('exchanges a PKCE-bound handoff without cookies, authenticates the bearer, and revokes it on logout', async () => {
    await seedLogin()
    const response = await exchange()
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const { data } = await response.json<{ data: { sessionToken: string } }>()
    const headers = { Origin: env.APP_ORIGIN, Authorization: `Bearer ${data.sessionToken}` }
    const me = await SELF.fetch('https://example.com/auth/me', { headers })
    expect(await me.json()).toMatchObject({ data: { authenticated: true, account: { id: userId } } })
    const stored = await env.DB.prepare('SELECT token_hash FROM auth_sessions WHERE user_id = ?').bind(userId).first<{ token_hash: string }>()
    expect(stored?.token_hash).toBe(await hash(data.sessionToken))
    expect((await exchange()).status).toBe(400)
    expect((await SELF.fetch('https://example.com/auth/logout', { method: 'POST', headers })).status).toBe(200)
    expect(await (await SELF.fetch('https://example.com/auth/me', { headers })).json()).toMatchObject({ data: { authenticated: false } })
  })

  it('allows only one simultaneous exchange of the same handoff', async () => {
    await seedLogin()
    const responses = await Promise.all([exchange(), exchange()])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?').bind(userId).first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('rejects the wrong verifier without consuming the legitimate login code', async () => {
    await seedLogin()
    expect((await exchange('x'.repeat(64))).status).toBe(400)
    expect((await exchange()).status).toBe(200)
  })

  it('rejects expired codes, untrusted origins, and oversized bodies', async () => {
    await seedLogin(new Date(Date.now() - 1000).toISOString())
    expect((await exchange()).status).toBe(400)
    expect((await exchange(verifier, 'https://evil.example')).status).toBe(403)
    const response = await SELF.fetch('https://example.com/auth/exchange', {
      method: 'POST', headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(5000) }),
    })
    expect(response.status).toBe(400)
  })

  it('allows Authorization in CORS preflight only for the configured app', async () => {
    for (const origin of [env.APP_ORIGIN, 'https://evil.example']) {
      const response = await SELF.fetch('https://example.com/auth/me', {
        method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
      })
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin === env.APP_ORIGIN ? origin : null)
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    }
  })

  it('does not fall back to a cookie when the bearer header is invalid', async () => {
    const token = 't'.repeat(43)
    await env.DB.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind('cookie-test', userId, await hash(token), new Date(Date.now() + 60_000).toISOString()).run()
    const me = await SELF.fetch('https://example.com/auth/me', { headers: { Authorization: 'Bearer malformed', Cookie: `smartcart_session=${token}` } })
    expect(await me.json()).toMatchObject({ data: { authenticated: false } })
  })

  it('completes the Google callback and issues only a browser-bound code, then rejects callback replay', async () => {
    const challenge = await hash(verifier, 'base64')
    const start = await app.fetch(new Request(`https://example.com/auth/google/start?app_code_challenge=${challenge}`), configuredEnv)
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    const transaction = await env.DB.prepare('SELECT nonce FROM auth_transactions WHERE state_hash = ?').bind(await hash(state)).first<{ nonce: string }>()
    const keys = await generateKeyPair('RS256', { extractable: true })
    const jwk = await exportJWK(keys.publicKey)
    const idToken = await new SignJWT({ nonce: transaction!.nonce, email: 'test@example.com', name: 'Google test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://accounts.google.com')
      .setAudience(configuredEnv.GOOGLE_CLIENT_ID).setSubject('google-test-subject').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
    fetchMock.get('https://oauth2.googleapis.com').intercept({ path: '/token', method: 'POST' }).reply(200, JSON.stringify({ id_token: idToken }), { headers: { 'Content-Type': 'application/json' } })
    fetchMock.get('https://www.googleapis.com').intercept({ path: '/oauth2/v3/certs' }).reply(200, JSON.stringify({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] }), { headers: { 'Content-Type': 'application/json' } })
    const callbackUrl = `https://example.com/auth/google/callback?code=google-code&state=${state}`
    const response = await app.fetch(new Request(callbackUrl), configuredEnv)
    expect(response.status).toBe(302)
    const destination = new URL(response.headers.get('Location')!)
    expect(`${destination.origin}${destination.pathname}`).toBe(env.APP_URL)
    expect(new URLSearchParams(destination.hash.slice(1)).get('login_code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first('count')).toBe(0)
    expect((await app.fetch(new Request(callbackUrl), configuredEnv)).headers.get('Location')).toBe(`${env.APP_URL}?auth=failed`)
    fetchMock.assertNoPendingInterceptors()
  })
})


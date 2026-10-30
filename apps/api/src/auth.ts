import { createRemoteJWKSet, jwtVerify } from 'jose'
import { googleAvatarUrl } from './google-avatar'

export type AuthEnv = Env & {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

type GoogleAuthEnv = AuthEnv & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string }

type AuthTransaction = {
  id: string
  code_verifier: string
  nonce: string
  return_to: string
  browser_code_challenge: string | null
}

type UserRow = {
  id: string
  display_name: string | null
  primary_email: string | null
  avatar_url: string | null
}

type GoogleTokenResponse = {
  id_token: string
}

type GoogleProfile = {
  issuer: string
  subject: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
}

export type SmartCartAccount = {
  id: string
  displayName: string | null
  primaryEmail: string | null
  avatarUrl: string | null
}

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const AUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000
const LOGIN_CODE_TTL_MS = 60 * 1000
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const textEncoder = new TextEncoder()

export function getRequestId(request: Request): string {
  return request.headers.get('X-Request-Id') ?? crypto.randomUUID()
}

export async function startGoogleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (!isGoogleLoginConfigured(env)) {
    return redirectToApp(env, 'auth=setup_required')
  }

  const url = new URL(request.url)
  const browserChallenge = url.searchParams.get('app_code_challenge')
  if (!browserChallenge || !/^[A-Za-z0-9_-]{43}$/.test(browserChallenge)) {
    return redirectToApp(env, 'auth=failed')
  }
  const state = randomToken(32)
  const codeVerifier = randomToken(48)
  const nonce = randomToken(32)
  const expiresAt = new Date(Date.now() + AUTH_TRANSACTION_TTL_MS).toISOString()

  await env.DB.prepare(
    `INSERT INTO auth_transactions
      (id, provider, state_hash, code_verifier, nonce, return_to, expires_at, browser_code_challenge)
     VALUES (?, 'google', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await sha256Hex(state),
      codeVerifier,
      nonce,
      safeReturnTo(url.searchParams.get('return_to'), env),
      expiresAt,
      browserChallenge,
    )
    .run()

  const authorizationUrl = new URL(GOOGLE_AUTHORIZE_URL)
  authorizationUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCallbackUrl(env),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await sha256Base64Url(codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()

  return Response.redirect(authorizationUrl.toString(), 302)
}

export async function completeGoogleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (!isGoogleLoginConfigured(env)) {
    return redirectToApp(env, 'auth=setup_required')
  }

  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')

  if (!state || !code || url.searchParams.has('error')) {
    return redirectToApp(env, 'auth=failed')
  }

  const transaction = await env.DB.prepare(
    `SELECT id, code_verifier, nonce, return_to, browser_code_challenge
       FROM auth_transactions
      WHERE provider = 'google'
        AND state_hash = ?
        AND consumed_at IS NULL
        AND expires_at > ?`,
  )
    .bind(await sha256Hex(state), new Date().toISOString())
    .first<AuthTransaction>()

  if (!transaction?.browser_code_challenge) {
    return redirectToApp(env, 'auth=failed')
  }

  const consumeResult = await env.DB.prepare(
    'UPDATE auth_transactions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
  )
    .bind(new Date().toISOString(), transaction.id)
    .run()

  if (!consumeResult.meta.changes) {
    return redirectToApp(env, 'auth=failed')
  }

  try {
    const tokens = await exchangeGoogleCode(code, transaction.code_verifier, env)
    const profile = await verifyGoogleIdentity(tokens.id_token, transaction.nonce, env)
    const account = await findOrCreateGoogleAccount(profile, env)
    const loginCode = randomToken(32)
    await env.DB.prepare(
      `INSERT INTO auth_login_codes (code_hash, user_id, code_challenge, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(await sha256Hex(loginCode), account.id, transaction.browser_code_challenge,
      new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString()).run()
    const destination = new URL(safeReturnTo(transaction.return_to, env))
    // Only a short-lived, PKCE-bound code travels in the fragment, never a session token.
    destination.hash = new URLSearchParams({ login_code: loginCode }).toString()
    return Response.redirect(destination.toString(), 302)
  } catch {
    return redirectToApp(env, 'auth=failed')
  }
}

export function isGoogleLoginConfigured(env: AuthEnv): env is GoogleAuthEnv {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    && !env.GOOGLE_CLIENT_ID.startsWith('replace-') && !env.GOOGLE_CLIENT_SECRET.startsWith('replace-'))
}

export async function exchangeBrowserLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (request.headers.get('Origin') !== env.APP_ORIGIN) {
    return Response.json({ error: { code: 'UNTRUSTED_ORIGIN' } }, { status: 403 })
  }
  const invalid = () => Response.json({ error: { code: 'INVALID_LOGIN_CODE' } }, { status: 400 })
  let input: unknown
  try {
    if (!request.headers.get('Content-Type')?.includes('application/json')) return invalid()
    const reader = request.body?.getReader()
    if (!reader) return invalid()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return invalid() }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    input = JSON.parse(new TextDecoder().decode(bytes))
  } catch { return invalid() }
  if (typeof input !== 'object' || !input || !('code' in input) || !('codeVerifier' in input)
    || typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.code)
    || typeof input.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) return invalid()

  // Atomic consumption: concurrent exchanges can create at most one session.
  const login = await env.DB.prepare(
    `UPDATE auth_login_codes SET consumed_at = ?
      WHERE code_hash = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING user_id`,
  ).bind(new Date().toISOString(), await sha256Hex(input.code), await sha256Base64Url(input.codeVerifier),
    new Date().toISOString()).first<{ user_id: string }>()
  if (!login) return invalid()
  const sessionToken = await createSession(login.user_id, env)
  return Response.json({ data: { sessionToken, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString() } })
}

export async function currentAccount(request: Request, env: AuthEnv): Promise<SmartCartAccount | null> {
  const sessionToken = requestSessionToken(request)
  if (!sessionToken) return null

  const row = await env.DB.prepare(
    `SELECT users.id, users.display_name, users.primary_email, users.avatar_url
       FROM auth_sessions
       INNER JOIN users ON users.id = auth_sessions.user_id
      WHERE auth_sessions.token_hash = ?
        AND auth_sessions.revoked_at IS NULL
        AND auth_sessions.expires_at > ?`,
  )
    .bind(await sha256Hex(sessionToken), new Date().toISOString())
    .first<UserRow>()

  if (!row) return null
  return { id: row.id, displayName: row.display_name, primaryEmail: row.primary_email, avatarUrl: googleAvatarUrl(row.avatar_url) }
}

// Admin elevation is bound to this exact live Google session, not just a user ID.
export async function currentAuthSessionId(request: Request, env: AuthEnv): Promise<string | null> {
  const token = requestSessionToken(request)
  if (!token) return null
  return env.DB.prepare('SELECT id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(await sha256Hex(token), new Date().toISOString()).first<string>('id')
}

export async function revokeCurrentSession(request: Request, env: AuthEnv): Promise<void> {
  const sessionToken = requestSessionToken(request)
  if (!sessionToken) return

  await env.DB.prepare(
    'UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
  )
    .bind(new Date().toISOString(), await sha256Hex(sessionToken))
    .run()
}

export function clearSessionCookie(env: AuthEnv): string {
  return `smartcart_session=; Path=/; HttpOnly; ${secureCookieAttribute(env)}SameSite=Lax; Max-Age=0`
}

export function isTrustedOrigin(request: Request, env: AuthEnv): boolean {
  const origin = request.headers.get('Origin')
  return !origin || origin === env.APP_ORIGIN
}

async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  env: GoogleAuthEnv,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: googleCallbackUrl(env),
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  })
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload: unknown = await response.json()

  if (!response.ok || !isGoogleTokenResponse(payload)) {
    throw new Error('Google token exchange failed')
  }
  return payload
}

async function verifyGoogleIdentity(
  idToken: string,
  expectedNonce: string,
  env: GoogleAuthEnv,
): Promise<GoogleProfile> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    audience: env.GOOGLE_CLIENT_ID,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  })

  if (payload.nonce !== expectedNonce || typeof payload.sub !== 'string') {
    throw new Error('Google identity token validation failed')
  }

  return {
    issuer: typeof payload.iss === 'string' ? payload.iss : 'https://accounts.google.com',
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    displayName: typeof payload.name === 'string' ? payload.name : null,
    avatarUrl: googleAvatarUrl(payload.picture),
  }
}

async function findOrCreateGoogleAccount(profile: GoogleProfile, env: AuthEnv): Promise<SmartCartAccount> {
  const identity = await env.DB.prepare(
    `SELECT users.id, users.display_name, users.primary_email, users.avatar_url
       FROM user_identities
       INNER JOIN users ON users.id = user_identities.user_id
      WHERE provider = 'google' AND issuer = ? AND provider_subject = ?`,
  )
    .bind(profile.issuer, profile.subject)
    .first<UserRow>()

  if (identity) {
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(`UPDATE user_identities SET last_login_at = ?
        WHERE provider = 'google' AND issuer = ? AND provider_subject = ?`)
        .bind(now, profile.issuer, profile.subject),
      env.DB.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?')
        .bind(profile.avatarUrl, now, identity.id),
    ])
    return { id: identity.id, displayName: identity.display_name, primaryEmail: identity.primary_email, avatarUrl: profile.avatarUrl }
  }

  const userId = crypto.randomUUID()
  const identityId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, display_name, primary_email, avatar_url, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(userId, profile.displayName, profile.email, profile.avatarUrl, new Date().toISOString()),
    env.DB.prepare(
      `INSERT INTO user_identities
        (id, user_id, provider, issuer, provider_subject, provider_email, last_login_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?)`,
    ).bind(
      identityId,
      userId,
      profile.issuer,
      profile.subject,
      profile.email,
      new Date().toISOString(),
    ),
  ])

  return { id: userId, displayName: profile.displayName, primaryEmail: profile.email, avatarUrl: profile.avatarUrl }
}

async function createSession(userId: string, env: AuthEnv): Promise<string> {
  const token = randomToken(32)
  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      await sha256Hex(token),
      new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
    )
    .run()
  return token
}

function redirectToApp(env: AuthEnv, query: string): Response {
  const destination = new URL(env.APP_URL)
  destination.search = query
  return Response.redirect(destination.toString(), 302)
}

function safeReturnTo(returnTo: string | null, env: AuthEnv): string {
  if (!returnTo) return env.APP_URL
  try {
    const candidate = new URL(returnTo)
    const app = new URL(env.APP_URL)
    if (candidate.origin === app.origin && candidate.pathname === app.pathname
      && !candidate.username && !candidate.password) return candidate.toString()
  } catch {
    // Treat malformed return URLs as the default app destination.
  }
  return env.APP_URL
}

function googleCallbackUrl(env: AuthEnv): string {
  return `${env.API_ORIGIN.replace(/\/$/, '')}/auth/google/callback`
}

function requestSessionToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization')
  if (authorization !== null) return /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] ?? null
  return parseCookie(request.headers.get('Cookie'), 'smartcart_session')
}

function secureCookieAttribute(env: AuthEnv): string {
  return new URL(env.API_ORIGIN).protocol === 'https:' ? 'Secure; ' : ''
}

function parseCookie(header: string | null, key: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...valueParts] = part.trim().split('=')
    if (name === key) return valueParts.join('=') || null
  }
  return null
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return bytesToBase64Url(new Uint8Array(digest))
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function isGoogleTokenResponse(payload: unknown): payload is GoogleTokenResponse {
  return typeof payload === 'object' && payload !== null && 'id_token' in payload && typeof payload.id_token === 'string'
}

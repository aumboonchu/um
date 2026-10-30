import { timingSafeEqual } from 'node:crypto'
import { currentAuthSessionId, type AuthEnv } from './auth'

type AccountRow = { user_id: string; password_hash: string; password_salt: string; password_iterations: number; must_change_password: number; credential_revision: number }
export type AdminAccess = { userId: string; authSessionId: string; tokenHash: string; credentialRevision: number; mustChangePassword: boolean }
export class AdminError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429) { super(code) }
}
const fail = (code: string, status: AdminError['status']): never => { throw new AdminError(code, status) }
const encoder = new TextEncoder()
export const ADMIN_PASSWORD_ITERATIONS = 100_000
export const adminSha = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const unhex = (value: string) => Uint8Array.from(value.match(/.{2}/g) ?? [], v => parseInt(v, 16))
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)))
const sessionToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
export async function adminPasswordHash(password: string, salt: string, iterations = ADMIN_PASSWORD_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, key, 256)))
}
export async function adminBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '') || !request.body
    || Number(request.headers.get('Content-Length')) > 10_240) return fail('INVALID_ADMIN_INPUT', 400)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength
    if (size > 10_240) { await reader.cancel(); return fail('INVALID_ADMIN_INPUT', 400) }
    chunks.push(value)
  } } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return fail('INVALID_ADMIN_INPUT', 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('INVALID_ADMIN_INPUT', 400)
  return body as Record<string, unknown>
}
function passwordBody(body: Record<string, unknown>, userId: string): string {
  if (Object.keys(body).some(k => !['accountId', 'password'].includes(k)) || typeof body.password !== 'string'
    || !body.password.length || body.password.length > 128 || /[\u0000-\u001f\u007f]/.test(body.password)) return fail('INVALID_ADMIN_INPUT', 400)
  if (body.accountId !== userId) return fail('ADMIN_ACCOUNT_MISMATCH', 403)
  return body.password
}
export async function adminEligible(userId: string, env: AuthEnv): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT user_id FROM admin_accounts WHERE user_id = ?').bind(userId).first())
}
// Reused inside writes: session revocation/expiry or credential rotation wins even after a preflight check.
export const ADMIN_LIVE = `EXISTS (SELECT 1 FROM admin_sessions s
  JOIN admin_accounts a ON a.user_id = s.user_id AND a.credential_revision = s.credential_revision
  JOIN auth_sessions g ON g.id = s.auth_session_id AND g.user_id = s.user_id
  WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    AND g.revoked_at IS NULL AND g.expires_at > ? AND a.must_change_password = 0)`
export async function requireAdmin(request: Request, userId: string, env: AuthEnv, allowBootstrap = false): Promise<AdminAccess> {
  const token = request.headers.get('X-SmartCart-Admin')
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return fail('ADMIN_SESSION_REQUIRED', 403)
  const authSessionId = await currentAuthSessionId(request, env)
  if (!authSessionId) return fail('ADMIN_SESSION_REQUIRED', 403)
  const tokenHash = await adminSha(token), now = new Date().toISOString()
  const row = await env.DB.prepare(`SELECT a.must_change_password, a.credential_revision FROM admin_sessions s
    JOIN admin_accounts a ON a.user_id = s.user_id AND a.credential_revision = s.credential_revision
    JOIN auth_sessions g ON g.id = s.auth_session_id AND g.user_id = s.user_id
    WHERE s.token_hash = ? AND s.user_id = ? AND s.auth_session_id = ?
      AND s.revoked_at IS NULL AND s.expires_at > ? AND g.revoked_at IS NULL AND g.expires_at > ?`)
    .bind(tokenHash, userId, authSessionId, now, now).first<{ must_change_password: number; credential_revision: number }>()
  if (!row) return fail('ADMIN_SESSION_REQUIRED', 403)
  if (row.must_change_password && !allowBootstrap) return fail('ADMIN_PASSWORD_CHANGE_REQUIRED', 403)
  return { userId, authSessionId, tokenHash, credentialRevision: row.credential_revision, mustChangePassword: Boolean(row.must_change_password) }
}
export async function adminLogin(request: Request, userId: string, env: AuthEnv) {
  const body = await adminBody(request), password = passwordBody(body, userId)
  const authSessionId = await currentAuthSessionId(request, env)
  if (!authSessionId) return fail('ADMIN_FORBIDDEN', 403)
  const account = await env.DB.prepare('SELECT * FROM admin_accounts WHERE user_id = ?').bind(userId).first<AccountRow>()
  if (!account) return fail('ADMIN_FORBIDDEN', 403)
  const nowMs = Date.now(), cutoff = nowMs - 15 * 60_000
  // Reserve each attempt atomically BEFORE the expensive hash, including concurrent requests.
  const reserved = await env.DB.prepare(`UPDATE admin_accounts SET
    login_attempts = CASE WHEN login_window_start <= ? THEN 1 ELSE login_attempts + 1 END,
    login_window_start = CASE WHEN login_window_start <= ? THEN ? ELSE login_window_start END
    WHERE user_id = ? AND (login_window_start <= ? OR login_attempts < 5)`)
    .bind(cutoff, cutoff, nowMs, userId, cutoff).run()
  if (!reserved.meta.changes) return fail('ADMIN_RATE_LIMITED', 429)
  const actual = await adminPasswordHash(password, account.password_salt, account.password_iterations)
  if (!timingSafeEqual(unhex(actual), unhex(account.password_hash))) return fail('ADMIN_LOGIN_FAILED', 401)
  const token = sessionToken(), tokenHash = await adminSha(token), now = new Date().toISOString()
  const expiresAt = new Date(nowMs + (account.must_change_password ? 5 : 15) * 60_000).toISOString()
  const result = await env.DB.prepare(`INSERT INTO admin_sessions (token_hash,user_id,auth_session_id,credential_revision,expires_at)
    SELECT ?, a.user_id, g.id, a.credential_revision, ? FROM admin_accounts a JOIN auth_sessions g ON g.user_id = a.user_id
    WHERE a.user_id = ? AND a.credential_revision = ? AND g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ?`)
    .bind(tokenHash, expiresAt, userId, account.credential_revision, authSessionId, now).run()
  if (!result.meta.changes) return fail('ADMIN_SESSION_REQUIRED', 403)
  // Bounded housekeeping for this owner only; never remove Google sessions or offline data.
  await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now).run()
  return { token, expiresAt, mustChangePassword: Boolean(account.must_change_password) }
}
export async function changeAdminPassword(request: Request, access: AdminAccess, env: AuthEnv) {
  const password = passwordBody(await adminBody(request), access.userId)
  if (password.trim().length < 8 || /^(.)\1+$/.test(password)) return fail('INVALID_ADMIN_INPUT', 400)
  const old = await env.DB.prepare('SELECT password_hash,password_salt,password_iterations FROM admin_accounts WHERE user_id = ?').bind(access.userId).first<AccountRow>()
  if (!old) return fail('ADMIN_SESSION_REQUIRED', 403)
  if (timingSafeEqual(unhex(await adminPasswordHash(password, old.password_salt, old.password_iterations)), unhex(old.password_hash))) return fail('INVALID_ADMIN_INPUT', 400)
  const salt = random(), hash = await adminPasswordHash(password, salt), token = sessionToken(), tokenHash = await adminSha(token)
  const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE admin_accounts SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0,
      credential_revision = credential_revision + 1, updated_at = ? WHERE user_id = ? AND credential_revision = ?
      AND EXISTS (SELECT 1 FROM admin_sessions s JOIN auth_sessions g ON g.id = s.auth_session_id AND g.user_id = s.user_id
        WHERE s.token_hash = ? AND s.user_id = admin_accounts.user_id AND s.credential_revision = admin_accounts.credential_revision
          AND s.revoked_at IS NULL AND s.expires_at > ? AND g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ?)`)
      .bind(hash, salt, ADMIN_PASSWORD_ITERATIONS, now, access.userId, access.credentialRevision, access.tokenHash, now, access.authSessionId, now),
    env.DB.prepare(`INSERT INTO admin_sessions (token_hash,user_id,auth_session_id,credential_revision,expires_at)
      SELECT ?, user_id, ?, credential_revision, ? FROM admin_accounts WHERE user_id = ? AND password_hash = ? AND credential_revision = ?`)
      .bind(tokenHash, access.authSessionId, expiresAt, access.userId, hash, access.credentialRevision + 1),
    env.DB.prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND credential_revision <
      (SELECT credential_revision FROM admin_accounts WHERE user_id = ?) AND revoked_at IS NULL`).bind(now, access.userId, access.userId),
  ])
  if (!result[0].meta.changes || !result[1].meta.changes) return fail('ADMIN_SESSION_REQUIRED', 403)
  return { token, expiresAt, mustChangePassword: false }
}
export async function adminLogout(access: AdminAccess, env: AuthEnv) {
  await env.DB.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ?')
    .bind(new Date().toISOString(), access.tokenHash, access.userId).run()
  return { signedOut: true }
}

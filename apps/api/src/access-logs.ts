import type { AuthEnv } from './auth'

export const ACCESS_LOG_RETENTION_DAYS = 90
export const ACCESS_EVENTS = ['login_started', 'login_succeeded', 'login_failed', 'logout',
  'admin_login_succeeded', 'admin_login_failed', 'admin_password_changed'] as const
type AccessEvent = typeof ACCESS_EVENTS[number]
type Outcome = 'success' | 'failure'
const reasons = new Set(['STARTED', 'SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_CHANGED', 'SETUP_REQUIRED',
  'INVALID_REQUEST', 'INVALID_STATE', 'PROVIDER_DENIED', 'PROVIDER_ERROR', 'INVALID_LOGIN_CODE', 'UNTRUSTED_ORIGIN',
  'ADMIN_FORBIDDEN', 'ADMIN_ACCOUNT_MISMATCH', 'INVALID_ADMIN_INPUT', 'ADMIN_RATE_LIMITED', 'ADMIN_LOGIN_FAILED',
  'ADMIN_SESSION_REQUIRED', 'ADMIN_PASSWORD_CHANGE_REQUIRED', 'INTERNAL_ERROR'])
const cutoff = () => new Date(Date.now() - ACCESS_LOG_RETENTION_DAYS * 86_400_000).toISOString()

/** Coarse, spoofable request hints, not a unique device identity. Raw headers are never persisted. */
export function accessDevice(request: Request) {
  const ua = (request.headers.get('User-Agent') ?? '').slice(0, 1024)
  const browser = !ua ? null : /Edg(?:e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /CriOS\//.test(ua) ? 'Chrome iOS' : /FxiOS\//.test(ua) ? 'Firefox iOS'
    : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Version\/.+Safari\//.test(ua) ? 'Safari' : 'Other'
  const os = !ua ? null : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other'
  const deviceType = !ua ? null : /iPad|Tablet|Android(?!.*Mobile)/.test(ua) ? 'Tablet'
    : /iPhone|iPod|Mobile/.test(ua) ? 'Mobile' : /Windows|Macintosh|Linux/.test(ua) ? 'Desktop' : 'Other'
  // Cloudflare sets cf metadata. Do not trust a client-controlled CF-IPCountry header.
  const cf = request.cf
  const candidate = cf && 'country' in cf ? cf.country : null
  const country = typeof candidate === 'string' && /^[A-Z]{2}$/.test(candidate) && !['XX', 'T1'].includes(candidate) ? candidate : null
  return { browser, os, deviceType, country }
}

/** Best-effort, awaited telemetry: a log outage must not invalidate an already-issued login/session. */
export async function recordAccess(request: Request, env: AuthEnv, event: AccessEvent, outcome: Outcome,
  userId: string | null = null, reason: string | null = null): Promise<void> {
  try {
    const device = accessDevice(request)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM access_logs WHERE occurred_at < ?').bind(cutoff()),
      env.DB.prepare(`INSERT INTO access_logs
        (id,occurred_at,event,outcome,reason,user_id,provider,browser,os,device_type,country) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(crypto.randomUUID(), new Date().toISOString(), event, outcome,
          reason === null ? null : reasons.has(reason) ? reason : 'INTERNAL_ERROR', userId,
          event.startsWith('admin_') ? 'admin' : 'google', device.browser, device.os, device.deviceType, device.country),
    ])
  } catch { console.error(JSON.stringify({ message: 'access_log_write_failed' })) }
}

export async function purgeAccessLogs(env: AuthEnv): Promise<void> {
  await env.DB.prepare('DELETE FROM access_logs WHERE occurred_at < ?').bind(cutoff()).run()
}

export class AccessLogQueryError extends Error {}
const invalid = (): never => { throw new AccessLogQueryError('INVALID_QUERY') }
type Cursor = { at: string; id: string; event: string; outcome: string }
function decodeCursor(value: string, event: string, outcome: string): Cursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return invalid()
  let parsed: unknown
  try { parsed = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) } catch { return invalid() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid()
  const p = parsed as Record<string, unknown>
  if (Object.keys(p).sort().join(',') !== 'at,event,id,outcome' || typeof p.at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.at)
    || !Number.isFinite(Date.parse(p.at)) || new Date(p.at).toISOString() !== p.at
    || typeof p.id !== 'string' || !/^[0-9a-f-]{36}$/.test(p.id) || p.event !== event || p.outcome !== outcome) return invalid()
  return { at: p.at, id: p.id, event, outcome }
}
type Row = { id: string; occurred_at: string; event: AccessEvent; outcome: Outcome; reason: string | null;
  user_id: string | null; display_name: string | null; primary_email: string | null; provider: 'google' | 'admin';
  browser: string | null; os: string | null; device_type: string | null; country: string | null }
const displayText = (value: string | null, max: number) => value?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || null

export async function listAccessLogs(url: URL, env: AuthEnv) {
  const query = url.searchParams
  for (const key of query.keys()) if (!['event', 'outcome', 'cursor', 'limit'].includes(key) || query.getAll(key).length !== 1) return invalid()
  const event = query.get('event') ?? '', outcome = query.get('outcome') ?? '', size = query.get('limit') ?? '30'
  if (event && !ACCESS_EVENTS.some(e => e === event) || outcome && !['success', 'failure'].includes(outcome)
    || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(size)) return invalid()
  const limit = Number(size), rawCursor = query.get('cursor')
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor, event, outcome)
  const clauses = ['l.occurred_at >= ?'], binds: (string | number)[] = [cutoff()]
  if (event) { clauses.push('l.event = ?'); binds.push(event) }
  if (outcome) { clauses.push('l.outcome = ?'); binds.push(outcome) }
  if (cursor) { clauses.push('(l.occurred_at < ? OR (l.occurred_at = ? AND l.id < ?))'); binds.push(cursor.at, cursor.at, cursor.id) }
  const rows = await env.DB.prepare(`SELECT l.*, u.display_name, u.primary_email FROM access_logs l
    LEFT JOIN users u ON u.id = l.user_id WHERE ${clauses.join(' AND ')}
    ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?`).bind(...binds, limit + 1).all<Row>()
  const page = rows.results.slice(0, limit), last = page.at(-1)
  const nextCursor = rows.results.length > limit && last ? btoa(JSON.stringify({ at: last.occurred_at, id: last.id, event, outcome }))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : null
  const collectionStartedAt = await env.DB.prepare('SELECT collection_started_at FROM access_log_settings WHERE id = 1').first<string>('collection_started_at')
  return { items: page.map(r => ({ id: r.id, occurredAt: r.occurred_at, event: r.event, outcome: r.outcome,
    reason: r.reason, userId: r.user_id, displayName: displayText(r.display_name, 200), primaryEmail: displayText(r.primary_email, 320),
    provider: r.provider, browser: r.browser, os: r.os, deviceType: r.device_type, country: r.country })),
  nextCursor, retentionDays: ACCESS_LOG_RETENTION_DAYS, collectionStartedAt }
}

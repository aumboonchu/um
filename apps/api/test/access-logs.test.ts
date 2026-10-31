import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminPasswordHash, adminSha, ADMIN_PASSWORD_ITERATIONS } from '../src/admin'
import { accessDevice, listAccessLogs, purgeAccessLogs, recordAccess } from '../src/access-logs'
import app from '../src/index'

const owner = 'access-owner', member = 'access-member', password = 'Access-test-password!'
const ownerToken = 'o'.repeat(43), memberToken = 'm'.repeat(43), salt = '34'.repeat(32)
const headers = { Authorization: `Bearer ${ownerToken}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
type Session = { token: string; expiresAt: string; mustChangePassword: boolean }
type Item = { id: string; occurredAt: string; event: string; outcome: string; reason: string | null;
  userId: string | null; displayName: string | null; primaryEmail: string | null; provider: string;
  browser: string | null; os: string | null; deviceType: string | null; country: string | null }
type Page = { items: Item[]; nextCursor: string | null; retentionDays: number; collectionStartedAt: string | null }
const data = async <T>(response: Response) => (await response.json<{ data: T }>()).data
const request = (path: string, token?: string, base: HeadersInit = headers) => {
  const h = new Headers(base); if (token) h.set('X-SmartCart-Admin', token)
  return SELF.fetch(`https://example.test/api/v1/admin/${path}`, { headers: h })
}
async function elevate() {
  const response = await SELF.fetch('https://example.test/api/v1/admin/login', {
    method: 'POST', headers, body: JSON.stringify({ accountId: owner, password }),
  })
  expect(response.status).toBe(200)
  return (await data<Session>(response)).token
}
async function clearLogs() { await env.DB.prepare('DELETE FROM access_logs').run() }
async function insertLog(n: number, event = 'login_failed', outcome = 'failure', at = new Date().toISOString()) {
  const id = `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
  await env.DB.prepare(`INSERT INTO access_logs(id,occurred_at,event,outcome,reason,user_id,provider)
    VALUES (?,?,?,?,?,?,?)`).bind(id, at, event, outcome, null, owner, 'google').run()
  return id
}
let hash = ''
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  hash = await adminPasswordHash(password, salt)
})
beforeEach(async () => {
  for (const [id, token] of [[owner, ownerToken], [member, memberToken]]) {
    await env.DB.prepare('INSERT INTO users(id,display_name,primary_email) VALUES (?,?,?)')
      .bind(id, `${id} name`, `${id}@example.test`).run()
    await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .bind(`${id}-google`, id, await adminSha(token), '2099-01-01T00:00:00.000Z').run()
  }
  await env.DB.prepare(`INSERT INTO admin_accounts(user_id,password_hash,password_salt,password_iterations,must_change_password,created_at,updated_at)
    VALUES (?,?,?,?,0,?,?)`).bind(owner, hash, salt, ADMIN_PASSWORD_ITERATIONS, new Date().toISOString(), new Date().toISOString()).run()
})

describe('private administrator access log endpoint', () => {
  it('starts collection empty without inventing historical logins', async () => {
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_logs').first('n')).toBe(0)
    const page = await listAccessLogs(new URL('https://example.test/'), env)
    expect(page).toMatchObject({ items: [], nextCursor: null, retentionDays: 90 })
    expect(page.collectionStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects anonymous, ordinary Google and member access without exposing log rows', async () => {
    await insertLog(1)
    for (const [base, status] of [[{}, 401], [headers, 403], [{ ...headers, Authorization: `Bearer ${memberToken}` }, 403]] as const) {
      const response = await request('access-logs', undefined, base)
      expect(response.status).toBe(status)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.text()).not.toContain(`${owner}@example.test`)
    }
  })

  it('requires completed first-password change and a live elevation tied to its Google session', async () => {
    await env.DB.prepare('UPDATE admin_accounts SET must_change_password = 1 WHERE user_id = ?').bind(owner).run()
    const bootstrap = await elevate()
    const denied = await request('access-logs', bootstrap)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'ADMIN_PASSWORD_CHANGE_REQUIRED' } })
    await env.DB.prepare('UPDATE admin_accounts SET must_change_password = 0 WHERE user_id = ?').bind(owner).run()
    expect((await request('access-logs', bootstrap)).status).toBe(200)
    await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), `${owner}-google`).run()
    expect((await request('access-logs', bootstrap)).status).toBe(401)
  })

  it('rejects revoked, expired, foreign-account and credential-rotated admin sessions', async () => {
    const token = await elevate()
    expect((await request('access-logs', token, { ...headers, Authorization: `Bearer ${memberToken}` })).status).toBe(403)
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ?').bind('2000-01-01T00:00:00.000Z').run()
    expect((await request('access-logs', token)).status).toBe(403)
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ?, revoked_at = ?').bind('2099-01-01T00:00:00.000Z', new Date().toISOString()).run()
    expect((await request('access-logs', token)).status).toBe(403)
    await env.DB.prepare('UPDATE admin_sessions SET revoked_at = NULL').run()
    await env.DB.prepare('UPDATE admin_accounts SET credential_revision = credential_revision + 1').run()
    expect((await request('access-logs', token)).status).toBe(403)
  })

  it('returns bounded security fields only, joined to current account identity, without cookies', async () => {
    const token = await elevate(); await clearLogs()
    await recordAccess(new Request('https://example.test/?secret=never-store', { headers: {
      'User-Agent': ua, Cookie: 'tracking=secret-cookie', Authorization: 'Bearer SECRET',
      'CF-Connecting-IP': '192.0.2.42', Referer: 'https://private.example/secret',
    } }), env, 'login_succeeded', 'success', owner, 'SIGNED_IN')
    const response = await request('access-logs', token)
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const text = await response.text(), page = JSON.parse(text) as { data: Page }
    expect(page.data.items).toHaveLength(1)
    expect(page.data.items[0]).toMatchObject({ userId: owner, displayName: `${owner} name`, primaryEmail: `${owner}@example.test`,
      event: 'login_succeeded', outcome: 'success', reason: 'SIGNED_IN', provider: 'google', browser: 'Safari', os: 'iOS', deviceType: 'Mobile', country: null })
    expect(Object.keys(page.data.items[0]).sort()).toEqual(['id','occurredAt','event','outcome','reason','userId','displayName','primaryEmail','provider','browser','os','deviceType','country'].sort())
    for (const secret of ['SECRET', 'secret-cookie', '192.0.2.42', 'private.example', 'never-store', ua, hash, salt, ownerToken, token]) expect(text).not.toContain(secret)
    await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind('Updated name', owner).run()
    expect((await data<Page>(await request('access-logs', token))).items[0].displayName).toBe('Updated name')
  })

  it('paginates same-millisecond rows without duplicates and binds cursors to filters', async () => {
    const token = await elevate(); await clearLogs()
    const at = new Date().toISOString()
    const ids = await Promise.all([1,2,3].map(n => insertLog(n, 'login_failed', 'failure', at)))
    await insertLog(4, 'login_succeeded', 'success', at)
    const first = await data<Page>(await request('access-logs?limit=2&event=login_failed&outcome=failure', token))
    expect(first.items.map(i => i.id)).toEqual([...ids].sort().reverse().slice(0, 2))
    expect(first.nextCursor).toBeTypeOf('string')
    const second = await data<Page>(await request(`access-logs?limit=2&event=login_failed&outcome=failure&cursor=${first.nextCursor}`, token))
    expect(second.items.map(i => i.id)).toEqual([[...ids].sort()[0]])
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items,...second.items].map(i => i.id)).size).toBe(3)
    expect((await request(`access-logs?event=login_failed&outcome=success&cursor=${first.nextCursor}`, token)).status).toBe(400)
    expect((await request(`access-logs?cursor=${first.nextCursor}`, token)).status).toBe(400)
  })

  it.each(['limit=0', 'limit=51', 'limit=3.5', 'limit=01', 'limit=999999', 'event=DROP%20TABLE',
    'outcome=anything', 'event=logout&event=login_failed', 'limit=1&limit=2', 'unknown=x', 'cursor=',
    'cursor=not-json', 'cursor=' + 'A'.repeat(513), 'cursor=%3Cscript%3E'])('rejects invalid or oversized query %s', async query => {
    const token = await elevate()
    expect((await request(`access-logs?${query}`, token)).status).toBe(400)
  })

  it('rejects cursors with invalid dates, IDs, extra fields or mismatched filters', async () => {
    const token = await elevate()
    const valid = { at: new Date().toISOString(), id: crypto.randomUUID(), event: '', outcome: '' }
    for (const cursor of [{...valid,at:'2026-02-30T00:00:00.000Z'}, {...valid,id:"' OR 1=1 --"}, {...valid,extra:'secret'}, {...valid,event:'logout'}]) {
      const encoded = btoa(JSON.stringify(cursor)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '')
      expect((await request(`access-logs?cursor=${encoded}`, token)).status).toBe(400)
    }
  })

  it('filters expired records even before purge and physically deletes only expired logs', async () => {
    const token = await elevate(); await clearLogs()
    const old = await insertLog(1, 'login_failed', 'failure', new Date(Date.now() - 91*86_400_000).toISOString())
    const current = await insertLog(2, 'login_failed', 'failure', new Date(Date.now() - 89*86_400_000).toISOString())
    expect((await data<Page>(await request('access-logs', token))).items.map(i => i.id)).toEqual([current])
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_logs WHERE id = ?').bind(old).first('n')).toBe(1)
    await purgeAccessLogs(env)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_logs').first('n')).toBe(1)
    expect(await env.DB.prepare('SELECT id FROM access_logs').first('id')).toBe(current)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(2)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions').first('n')).toBe(2)
  })
})

describe('safe access event capture', () => {
  it('stores only coarse allowlisted device hints and trusts cf country rather than a request header', async () => {
    expect(accessDevice(new Request('https://example.test', { headers: { 'User-Agent': ua, 'CF-IPCountry': 'US' } })))
      .toEqual({ browser:'Safari', os:'iOS', deviceType:'Mobile', country:null })
    expect(accessDevice(new Request('https://example.test', { cf: { country:'TH' }, headers:{ 'CF-IPCountry':'US', 'User-Agent':'Mozilla/5.0 (Android 14; Mobile) Chrome/130.0' } })))
      .toEqual({ browser:'Chrome', os:'Android', deviceType:'Mobile', country:'TH' })
    expect(accessDevice(new Request('https://example.test', { cf: { country:'XX' }, headers:{ 'User-Agent':'<script>private fingerprint</script>' } })))
      .toEqual({ browser:'Other', os:'Other', deviceType:'Other', country:null })
    expect(accessDevice(new Request('https://example.test'))).toEqual({ browser:null, os:null, deviceType:null, country:null })
  })

  it('does not persist arbitrary reasons or raw malformed UA and performs fallback expiry cleanup on writes', async () => {
    await insertLog(1, 'login_failed', 'failure', '2000-01-01T00:00:00.000Z')
    await recordAccess(new Request('https://example.test', { headers:{'User-Agent':'secret-unique-device-id'} }), env, 'login_failed', 'failure', null, 'RAW_SECRET_REASON')
    const rows = await env.DB.prepare('SELECT * FROM access_logs').all()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]).toMatchObject({ reason:'INTERNAL_ERROR', user_id:null, browser:'Other', os:'Other', device_type:'Other' })
    expect(JSON.stringify(rows.results)).not.toContain('secret-unique-device-id')
    expect(JSON.stringify(rows.results)).not.toContain('RAW_SECRET_REASON')
  })

  it('awaits and contains a log storage failure without leaking its error or failing authentication telemetry', async () => {
    const failure = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('sensitive-database-or-token-detail'))
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(recordAccess(new Request('https://example.test'), env, 'login_succeeded', 'success', owner, 'SIGNED_IN')).resolves.toBeUndefined()
      expect(output).toHaveBeenCalledWith(JSON.stringify({message:'access_log_write_failed'}))
      expect(JSON.stringify(output.mock.calls)).not.toContain('sensitive-database-or-token-detail')
    } finally { failure.mockRestore(); output.mockRestore() }
  })

  it('still returns a usable newly issued Google session when only telemetry storage fails', async () => {
    const verifier = 'w'.repeat(64), code = 'q'.repeat(43)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '')
    await env.DB.prepare('INSERT INTO auth_login_codes(code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)')
      .bind(await adminSha(code), owner, challenge, new Date(Date.now()+60_000).toISOString()).run()
    const failure = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('private-storage-failure'))
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await app.fetch(new Request('https://example.test/auth/exchange', {method:'POST',headers,
        body:JSON.stringify({code,codeVerifier:verifier})}), env)
      expect(response.status).toBe(200)
      const session = await data<{sessionToken:string}>(response)
      expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const me = await app.fetch(new Request('https://example.test/auth/me', {
        headers:{Authorization:`Bearer ${session.sessionToken}`},
      }), env)
      expect(await me.json()).toMatchObject({data:{authenticated:true,account:{id:owner}}})
      expect(output).toHaveBeenCalledWith(JSON.stringify({message:'access_log_write_failed'}))
      expect(JSON.stringify(output.mock.calls)).not.toContain('private-storage-failure')
    } finally { failure.mockRestore(); output.mockRestore() }
  })

  it('records Google start, successful PKCE exchange and a single real logout without storing secrets', async () => {
    const verifier = 'v'.repeat(64), code = 'c'.repeat(43)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '')
    const start = await app.fetch(new Request(`https://example.test/auth/google/start?app_code_challenge=${challenge}`), {
      ...env, GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET:'test-secret-never-log',
    })
    expect(start.status).toBe(302)
    await env.DB.prepare('INSERT INTO auth_login_codes(code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)')
      .bind(await adminSha(code), owner, challenge, new Date(Date.now()+60_000).toISOString()).run()
    const exchange = await SELF.fetch('https://example.test/auth/exchange', {method:'POST',headers,
      body:JSON.stringify({code,codeVerifier:verifier})})
    expect(exchange.status).toBe(200)
    expect(exchange.headers.get('Set-Cookie')).toBeNull()
    const session = await data<{sessionToken:string}>(exchange)
    const auth = {...headers,Authorization:`Bearer ${session.sessionToken}`}
    expect((await SELF.fetch('https://example.test/auth/logout', {method:'POST',headers:auth})).status).toBe(200)
    expect((await SELF.fetch('https://example.test/auth/logout', {method:'POST',headers:auth})).status).toBe(200)
    const rows = await env.DB.prepare('SELECT event,user_id,reason FROM access_logs').all()
    expect(rows.results.filter(r=>r.event==='login_started')).toHaveLength(1)
    expect(rows.results.filter(r=>r.event==='login_succeeded')).toEqual([{event:'login_succeeded',user_id:owner,reason:'SIGNED_IN'}])
    expect(rows.results.filter(r=>r.event==='logout')).toEqual([{event:'logout',user_id:owner,reason:'SIGNED_OUT'}])
    const raw = JSON.stringify(await env.DB.prepare('SELECT * FROM access_logs').all())
    for(const secret of [code,verifier,challenge,session.sessionToken,'test-secret-never-log']) expect(raw).not.toContain(secret)
  })

  it('does not amplify unauthenticated junk into stored logs or trust client identity claims', async () => {
    const configured = {...env,GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-secret'}
    for (const path of ['/auth/google/start', '/auth/google/start?app_code_challenge=bad',
      '/auth/google/callback?code=unknown&state=unknown', '/auth/google/callback?error=private-provider-text&state=unknown']) {
      expect((await app.fetch(new Request(`https://example.test${path}`), configured)).status).toBe(302)
    }
    for (const body of [{code:'x'.repeat(43),codeVerifier:'v'.repeat(64),userId:owner,email:'attacker-input@example.test'}, {}, {code:'oversized'.repeat(800)}]) {
      expect((await SELF.fetch('https://example.test/auth/exchange', {method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400)
    }
    expect((await SELF.fetch('https://example.test/auth/exchange', {method:'POST',headers:{...headers,Origin:'https://evil.example'},
      body:JSON.stringify({code:'x'.repeat(43),codeVerifier:'v'.repeat(64)})})).status).toBe(403)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_logs').first('n')).toBe(0)
  })

  it('logs one wrong-verifier failure per known live handoff without trusting client identity and preserves legitimate exchange', async () => {
    const verifier = 'j'.repeat(64), code = 'k'.repeat(43)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '')
    await env.DB.prepare('INSERT INTO auth_login_codes(code_hash,user_id,code_challenge,expires_at) VALUES (?,?,?,?)')
      .bind(await adminSha(code), owner, challenge, new Date(Date.now()+60_000).toISOString()).run()
    const wrong = () => SELF.fetch('https://example.test/auth/exchange', {method:'POST',headers,
      body:JSON.stringify({code,codeVerifier:'z'.repeat(64),userId:member,email:'attacker-input@example.test'})})
    const failed = await Promise.all([wrong(),wrong(),wrong()])
    expect(failed.every(response=>response.status===400)).toBe(true)
    const rows = await env.DB.prepare('SELECT * FROM access_logs WHERE event = ?').bind('login_failed').all()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]).toMatchObject({user_id:null,event:'login_failed',reason:'INVALID_LOGIN_CODE'})
    expect(JSON.stringify(rows.results)).not.toContain('attacker-input@example.test')
    const success = await SELF.fetch('https://example.test/auth/exchange', {method:'POST',headers,
      body:JSON.stringify({code,codeVerifier:verifier})})
    expect(success.status).toBe(200)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_logs WHERE event = ? AND user_id = ?')
      .bind('login_succeeded',owner).first('n')).toBe(1)
    expect((await wrong()).status).toBe(400)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_logs WHERE event = ?').bind('login_failed').first('n')).toBe(1)
  })

  it('logs a valid-state Google cancellation once while rejecting concurrent or replayed callbacks', async () => {
    const configured = {...env,GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-secret'}
    const challenge = 'a'.repeat(43)
    const started = await app.fetch(new Request(`https://example.test/auth/google/start?app_code_challenge=${challenge}`), configured)
    const state = new URL(started.headers.get('Location')!).searchParams.get('state')!
    await clearLogs()
    const callback = () => app.fetch(new Request(`https://example.test/auth/google/callback?error=access_denied&state=${state}`), configured)
    const canceled = await Promise.all([callback(),callback()])
    expect(canceled.every(response=>response.status===302&&response.headers.get('Location')===`${env.APP_URL}?auth=failed`)).toBe(true)
    expect((await callback()).status).toBe(302)
    const rows = await env.DB.prepare('SELECT event,reason,user_id FROM access_logs').all()
    expect(rows.results).toEqual([{event:'login_failed',reason:'PROVIDER_DENIED',user_id:null}])
  })

  it('attributes failed admin login to verified Google account, not the submitted accountId', async () => {
    const response = await SELF.fetch('https://example.test/api/v1/admin/login', { method:'POST',
      headers:{...headers,Authorization:`Bearer ${memberToken}`}, body:JSON.stringify({accountId:owner,password:'incorrect-secret-password'}) })
    expect(response.status).toBe(403)
    const rows = await env.DB.prepare('SELECT * FROM access_logs WHERE event = ?').bind('admin_login_failed').all()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]).toMatchObject({user_id:member,provider:'admin',outcome:'failure',reason:'ADMIN_ACCOUNT_MISMATCH'})
    expect(JSON.stringify(rows.results)).not.toContain('incorrect-secret-password')
  })

  it('records successful admin entry and successful password rotation but no password values', async () => {
    const token = await elevate()
    const nextPassword = 'Different-test-password!'
    const changed = await SELF.fetch('https://example.test/api/v1/admin/password', {method:'POST',
      headers:{...headers,'X-SmartCart-Admin':token},body:JSON.stringify({accountId:owner,password:nextPassword})})
    expect(changed.status).toBe(200)
    const rows = await env.DB.prepare('SELECT * FROM access_logs').all()
    expect(rows.results.some(r=>r.event==='admin_login_succeeded'&&r.user_id===owner&&r.outcome==='success')).toBe(true)
    expect(rows.results.some(r=>r.event==='admin_password_changed'&&r.user_id===owner&&r.outcome==='success')).toBe(true)
    for(const secret of [password,nextPassword,hash,salt,ownerToken,token]) expect(JSON.stringify(rows.results)).not.toContain(secret)
  })
})

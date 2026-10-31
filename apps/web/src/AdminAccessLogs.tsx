import { useEffect, useRef, useState } from 'react'
import { adminAccessEvents, adminAccessLogs, adminMessage, adminSessionError,
  type AdminAccessEvent, type AdminAccessLog, type AdminAccessOutcome, type AdminAccessPage } from './admin-client'

const events: Record<AdminAccessEvent, string> = {
  login_started: 'เริ่มเข้าสู่ระบบ', login_succeeded: 'เข้าสู่ระบบสำเร็จ', login_failed: 'เข้าสู่ระบบไม่สำเร็จ',
  logout: 'ออกจากระบบ', admin_login_succeeded: 'เข้า admin สำเร็จ', admin_login_failed: 'เข้า admin ไม่สำเร็จ',
  admin_password_changed: 'เปลี่ยนรหัสผ่าน admin',
}
const reasons: Record<string, string> = {
  INVALID_LOGIN_CODE: 'รหัสเข้าใช้งานไม่ถูกต้องหรือหมดอายุ',
  ADMIN_LOGIN_FAILED: 'รหัสผ่าน admin ไม่ถูกต้อง', ADMIN_RATE_LIMITED: 'ลองเข้าสู่ระบบถี่เกินไป',
  ADMIN_FORBIDDEN: 'ไม่มีสิทธิ์ admin', SETUP_REQUIRED: 'ยังตั้งค่าการเข้าสู่ระบบไม่ครบ',
  INVALID_REQUEST: 'คำขอไม่ถูกต้อง',
  INVALID_STATE: 'คำขอหมดอายุหรือไม่ถูกต้อง', PROVIDER_DENIED: 'ผู้ใช้ยกเลิกหรือ Google ไม่อนุญาต',
  PROVIDER_ERROR: 'ยืนยันบัญชี Google ไม่สำเร็จ', UNTRUSTED_ORIGIN: 'คำขอมาจากเว็บไซต์ที่ไม่อนุญาต',
  ADMIN_ACCOUNT_MISMATCH: 'บัญชีไม่ตรงกับคำขอ', INVALID_ADMIN_INPUT: 'ข้อมูลเข้าสู่ระบบไม่ครบ',
  ADMIN_SESSION_REQUIRED: 'หมดเวลาสิทธิ์ผู้ดูแล', ADMIN_PASSWORD_CHANGE_REQUIRED: 'ต้องเปลี่ยนรหัสผ่านก่อน',
  INTERNAL_ERROR: 'ระบบขัดข้องระหว่างยืนยันบัญชี',
}
function localTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}
function LogCard({ item }: { item: AdminAccessLog }) {
  return <li className="admin-log-card">
    <div className="admin-log-heading"><strong>{events[item.event]}</strong><span className={`admin-log-outcome ${item.outcome}`}>{item.outcome === 'success' ? 'สำเร็จ' : 'ไม่สำเร็จ'}</span></div>
    <time dateTime={item.occurredAt}>{localTime(item.occurredAt)}</time>
    <div className="admin-log-account"><strong>{item.displayName ?? 'ยังไม่ระบุบัญชี'}</strong>{item.primaryEmail ? <span>{item.primaryEmail}</span> : null}</div>
    <p>{item.provider === 'google' ? 'Google' : 'Admin'} · {[item.browser, item.os, item.deviceType].filter(Boolean).join(' · ') || 'ไม่ทราบอุปกรณ์'}{item.country ? ` · ประเทศโดยประมาณ: ${item.country}` : ''}</p>
    {item.reason && item.outcome === 'failure' ? <p className="admin-log-reason">{reasons[item.reason] ?? 'ไม่สำเร็จ กรุณาดูรหัสอ้างอิง'}</p> : null}
    <details className="admin-log-details"><summary>รหัสอ้างอิง</summary><p>เหตุการณ์: {item.id}</p>{item.userId ? <p>บัญชี: {item.userId}</p> : null}{item.reason ? <p>ผลตรวจสอบ: {item.reason}</p> : null}</details>
  </li>
}

export function AdminAccessLogs({ apiOrigin, token, online, onSessionError }: {
  apiOrigin: string; token: string; online: boolean; onSessionError: (error: unknown) => void;
}) {
  const [event, setEvent] = useState<AdminAccessEvent | ''>(''), [outcome, setOutcome] = useState<AdminAccessOutcome | ''>('')
  const [page, setPage] = useState<AdminAccessPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), mounted = useRef(true), callback = useRef(onSessionError); callback.current = onSessionError
  async function load(reset = true) {
    if (!online || !token || !reset && (busy || !page?.nextCursor)) return
    const current = ++generation.current
    setBusy(true); setError('')
    if (reset) setPage(null)
    try {
      const next = await adminAccessLogs(apiOrigin, token, { event, outcome, cursor: reset ? null : page?.nextCursor })
      if (!mounted.current || current !== generation.current) return
      setPage(previous => ({ ...next, items: reset ? next.items : [...(previous?.items ?? []), ...next.items.filter(item => !previous?.items.some(old => old.id === item.id))] }))
    } catch (failure) {
      if (!mounted.current || current !== generation.current) return
      setError(adminMessage(failure))
      if (adminSessionError(failure)) { setPage(null); callback.current(failure) }
    } finally { if (mounted.current && current === generation.current) setBusy(false) }
  }
  useEffect(() => {
    mounted.current = true
    if (online) void load()
    else { generation.current += 1; setPage(null); setBusy(false); setError('') }
    return () => { mounted.current = false; generation.current += 1 }
    // Log state is memory-only and each filter/session change invalidates older requests.
  }, [apiOrigin, token, online, event, outcome])
  return <section className="admin-access-logs" aria-labelledby="admin-logs-title" aria-busy={busy}>
    <div className="summary-row"><h2 id="admin-logs-title">ประวัติเข้าใช้งาน</h2><button type="button" className="text-button" disabled={!online || busy} onClick={() => void load()}>รีเฟรช</button></div>
    <div className="admin-log-filters">
      <label>เหตุการณ์<select value={event} disabled={!online} onChange={change => setEvent(change.target.value as AdminAccessEvent | '')}><option value="">ทั้งหมด</option>{adminAccessEvents.map(value => <option value={value} key={value}>{events[value]}</option>)}</select></label>
      <label>ผลลัพธ์<select value={outcome} disabled={!online} onChange={change => setOutcome(change.target.value as AdminAccessOutcome | '')}><option value="">ทั้งหมด</option><option value="success">สำเร็จ</option><option value="failure">ไม่สำเร็จ</option></select></label>
    </div>
    <div className="admin-log-notice"><p>แสดงย้อนหลัง 90 วัน · ลบตามรอบรายวัน · ไม่ใช้คุกกี้ติดตาม</p>
      <p>เริ่มเก็บหลังอัปเดตนี้ ไม่ใช่ประวัติย้อนหลังทั้งหมด{page?.collectionStartedAt ? ` · เริ่ม ${localTime(page.collectionStartedAt)}` : ''}</p>
      <p>เบราว์เซอร์และอุปกรณ์เป็นข้อมูลโดยประมาณ ไม่ใช่รหัสเครื่อง</p></div>
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {page?.items.length ? <ol className="admin-log-list">{page.items.map(item => <LogCard key={item.id} item={item} />)}</ol> : page && !busy ? <p className="empty-state">ยังไม่มีประวัติที่ตรงกับตัวกรอง</p> : null}
    {busy ? <p role="status">กำลังโหลดประวัติ…</p> : null}
    {page?.nextCursor ? <button type="button" className="secondary-button" disabled={!online || busy} onClick={() => void load(false)}>ดูประวัติเพิ่มเติม</button> : null}
    {error ? <button type="button" className="secondary-button" disabled={!online || busy} onClick={() => void load()}>ลองอีกครั้ง</button> : null}
  </section>
}

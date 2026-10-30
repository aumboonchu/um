import { useEffect, useRef, useState } from 'react'
import {
  adminDetail, AdminError, adminFields, adminList, adminLogin, adminMessage, adminRequest, adminSessionError,
  clearAdminEdit, createAdminEdit, definiteAdminEditError, readAdminEdit, sendAdminEdit,
  type AdminEdit, type AdminFields, type AdminProduct, type AdminSession,
} from './admin-client'
import { Icon, PageHeader, ProductThumb } from './ui'

export function AdminEntry({ apiOrigin, accountId, online, onOpen }: { apiOrigin: string; accountId: string; online: boolean; onOpen: () => void }) {
  const [eligible, setEligible] = useState(false)
  useEffect(() => {
    if (!online) return
    let current = true
    void adminRequest(apiOrigin, '/status').then(data => {
      if (current) setEligible(typeof data === 'object' && data !== null && 'eligible' in data && data.eligible === true)
    }).catch(() => { if (current) setEligible(false) })
    return () => { current = false }
  }, [apiOrigin, accountId, online])
  return eligible ? <div className="admin-entry"><button type="button" className="text-button" disabled={!online} onClick={onOpen}>ผู้ดูแลระบบ</button></div> : null
}

export function AdminPanel({ apiOrigin, accountId, online, onBack, onChanged, onDirtyChange }: {
  apiOrigin: string; accountId: string; online: boolean; onBack: () => void; onChanged: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [session, setSession] = useState<AdminSession | null>(null), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [items, setItems] = useState<AdminProduct[]>([]), [cursor, setCursor] = useState<string | null>(null), [total, setTotal] = useState(0)
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [loaded, setLoaded] = useState(false)
  const [product, setProduct] = useState<AdminProduct | null>(null), [fields, setFields] = useState<AdminFields | null>(null)
  const [pending, setPending] = useState<AdminEdit | null>(null), [storageBlocked, setStorageBlocked] = useState(false), [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const mounted = useRef(true), busyRef = useRef(false), sessionRef = useRef<AdminSession | null>(null), sequence = useRef(0)
  const callbacks = useRef({ onChanged }); callbacks.current = { onChanged }
  const dirty = busy || Boolean(pending) || Boolean(product && fields && JSON.stringify(fields) !== JSON.stringify(adminFields(product)))
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  function restore() {
    try { const attempt = readAdminEdit(accountId); setPending(attempt); if (attempt) setFields(adminFields(attempt.payload)); setStorageBlocked(false) }
    catch { setStorageBlocked(true); setError('ยังตรวจคำขอเดิมบนเครื่องไม่ได้ อย่าล้างข้อมูลเว็บหากมีคำขอรอยืนยัน') }
  }
  useEffect(() => {
    mounted.current = true; restore()
    return () => {
      mounted.current = false; sequence.current += 1
      const token = sessionRef.current?.token; sessionRef.current = null
      if (token) void adminRequest(apiOrigin, '/logout', token, { method: 'POST' }).catch(() => { /* The short server expiry remains authoritative. */ })
    }
  }, [accountId, apiOrigin])
  function changeSession(value: AdminSession | null) { sessionRef.current = value; setSession(value) }
  useEffect(() => {
    if (!session) return
    const timer = setTimeout(() => { changeSession(null); setPassword(''); setConfirmation(''); setError('หมดเวลาผู้ดูแล กรุณาใส่รหัสผ่านอีกครั้ง') }, Math.max(0, Date.parse(session.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [session])
  function start() { if (busyRef.current || !online) return false; busyRef.current = true; setBusy(true); setError(''); return true }
  function finish() { busyRef.current = false; if (mounted.current) setBusy(false) }
  function failure(e: unknown) {
    setError(adminMessage(e))
    if (adminSessionError(e)) { changeSession(null); setPassword(''); setConfirmation('') }
  }
  async function signIn() {
    if (!start()) return
    const changing = Boolean(session?.mustChangePassword)
    if (changing && (password.length < 8 || password.length > 128 || password !== confirmation)) {
      setError(password !== confirmation ? 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' : 'ใช้รหัสผ่านใหม่อย่างน้อย 8 ตัวอักษร'); finish(); return
    }
    try {
      const next = await adminLogin(apiOrigin, accountId, password, changing ? session!.token : null)
      if (!mounted.current) return
      changeSession(next); setPassword(''); setConfirmation(''); setMessage(changing ? 'เปลี่ยนรหัสผ่านแล้ว' : '')
    } catch (e) {
      if (mounted.current) {
        failure(e)
        if (changing && !(e instanceof AdminError && [400, 403, 429].includes(e.status))) {
          // The change may have committed even if its reply was lost; never silently retry an old bootstrap token.
          changeSession(null); setPassword(''); setConfirmation(''); setError('ยังยืนยันการเปลี่ยนรหัสไม่ได้ ลองเข้าสู่ระบบด้วยรหัสใหม่ที่ตั้งไว้')
        }
      }
    } finally { finish() }
  }
  async function loadList(reset = true, nextQuery = query) {
    const token = sessionRef.current?.token
    if (!token || !start()) return
    const generation = ++sequence.current
    try {
      const page = await adminList(apiOrigin, token, nextQuery, reset ? null : cursor)
      if (!mounted.current || sequence.current !== generation || sessionRef.current?.token !== token) return
      setItems(previous => reset ? page.items : [...previous, ...page.items.filter(value => !previous.some(item => item.id === value.id))])
      setCursor(page.nextCursor); setTotal(page.total); setLoaded(true); setQuery(nextQuery)
    } catch (e) { if (mounted.current && generation === sequence.current) failure(e) }
    finally { finish() }
  }
  async function openProduct(id: string, discard = false) {
    const token = sessionRef.current?.token
    if (!token || !start()) return
    try {
      const value = await adminDetail(apiOrigin, token, id)
      if (!mounted.current || sessionRef.current?.token !== token) return
      setProduct(value); setFields(pending && !discard ? adminFields(pending.payload) : adminFields(value)); setStale(false); setMessage('')
      window.scrollTo({ top: 0, behavior: 'auto' })
    } catch (e) { if (mounted.current) failure(e) }
    finally { finish() }
  }
  useEffect(() => {
    if (!online || !session || session.mustChangePassword || busyRef.current) return
    if (pending) void openProduct(pending.productId)
    else if (!loaded && !product) void loadList()
    // Reconnecting must not discard an unsent form or repeat an uncertain mutation.
  }, [session?.token, online])
  async function save() {
    const token = sessionRef.current?.token
    if (!token || !product || !fields || storageBlocked || stale && !pending || !start()) return
    let attempt: AdminEdit
    try { attempt = pending ?? createAdminEdit(accountId, product, fields) }
    catch (e) { failure(e); finish(); return }
    setPending(attempt); setMessage('')
    try {
      await sendAdminEdit(apiOrigin, token, accountId, attempt)
      if (!mounted.current) return
      let cleanupPending = false
      try { clearAdminEdit(accountId, attempt); setPending(null) } catch { cleanupPending = true }
      setMessage(cleanupPending ? 'บันทึกแล้ว แต่ยังล้างสถานะคำขอบนเครื่องไม่ได้ ตรวจสอบด้วยรหัสเดิมอีกครั้ง' : 'บันทึกข้อมูลกลางแล้ว')
      callbacks.current.onChanged(); setLoaded(false)
      try {
        const latest = await adminDetail(apiOrigin, token, attempt.productId)
        if (mounted.current) { setProduct(latest); if (!cleanupPending) setFields(adminFields(latest)); setStale(false) }
      } catch (e) { if (mounted.current) { setStale(true); failure(e); setMessage('บันทึกแล้ว แต่ยังโหลดข้อมูลล่าสุดไม่ได้') } }
    } catch (e) {
      if (!mounted.current) return
      failure(e)
      if (definiteAdminEditError(e)) {
        try { clearAdminEdit(accountId, attempt); setPending(null); if (e instanceof AdminError && e.code === 'PRODUCT_CONFLICT') setStale(true) }
        catch { setStorageBlocked(true) }
      } else if (e instanceof AdminError && e.code === 'ADMIN_STORAGE_BLOCKED') setStorageBlocked(true)
    } finally { finish() }
  }
  function closeProduct() {
    if (busy) return
    if (dirty && !window.confirm('ออกจากสินค้านี้หรือไม่? คำขอที่ส่งแล้วจะเก็บรหัสไว้เพื่อตรวจสอบผล')) return
    if (pending) { setError('กรุณาตรวจสอบคำขอเดิมก่อนเปิดสินค้าอื่น'); return }
    setProduct(null); setFields(null); setStale(false); setError(''); setMessage('')
    if (!loaded) void loadList()
  }
  function back() {
    if (busy) return
    if (product && session && !session.mustChangePassword) closeProduct()
    else onBack()
  }
  const locked = !online || busy || Boolean(pending) || storageBlocked || stale
  const changing = Boolean(session?.mustChangePassword)
  return <section className="mobile-page focused-page admin-page" aria-labelledby="admin-title">
    <PageHeader title={product && session && !changing ? 'แก้ไขสินค้ากลาง' : 'ผู้ดูแลระบบ'} id="admin-title" onBack={back} />
    <div className="page-content admin-content">
      {!online ? <p className="pending-caption" role="status">ผู้ดูแลระบบใช้งานเมื่อออนไลน์</p> : null}
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {message ? <p className="inline-message" role="status">{message}</p> : null}
      {storageBlocked ? <button type="button" className="secondary-button" disabled={busy} onClick={restore}>ตรวจสอบคำขอเดิมบนเครื่อง</button> : null}
      {!session || changing ? <form className="focused-form" onSubmit={event => { event.preventDefault(); void signIn() }}>
        {changing ? <><h2>ตั้งรหัสผ่านใหม่</h2><p className="muted">เปลี่ยนรหัสเริ่มต้นก่อนใช้งาน</p></> : <p className="muted">สำหรับบัญชีผู้ดูแลเท่านั้น</p>}
        <label>{changing ? 'รหัสผ่านใหม่' : 'รหัสผ่านผู้ดูแล'}<input type="password" value={password} autoComplete={changing ? 'new-password' : 'current-password'} minLength={changing ? 8 : 1} maxLength={128} required disabled={!online || busy} onChange={event => setPassword(event.target.value)} /></label>
        {changing ? <><p className="muted">อย่างน้อย 8 ตัวอักษร</p><label>ยืนยันรหัสผ่านใหม่<input type="password" value={confirmation} autoComplete="new-password" minLength={8} maxLength={128} required disabled={!online || busy} onChange={event => setConfirmation(event.target.value)} /></label></> : null}
        <div className="page-actions"><button className="primary-button" disabled={!online || busy}>{busy ? 'กำลังตรวจสอบ…' : changing ? 'เปลี่ยนรหัสผ่าน' : 'เข้าสู่ระบบผู้ดูแล'}</button></div>
      </form> : product && fields ? <>
        <div className="matched-product"><ProductThumb imageUrl={product.imageUrl} /><div><h2>{product.name}</h2><p className="muted">SKU: {product.sku}</p><p className="muted">UPC / EAN: {product.upc ?? 'ยังไม่มี'}</p></div></div>
        <p className="pending-caption">แก้ข้อมูลกลางทั้งระบบ · ไม่เปลี่ยนยอดซื้อเดิม</p>
        <form className="focused-form product-editor" onSubmit={event => { event.preventDefault(); void save() }}>
          <fieldset className="purchase-fieldset" disabled={locked}>
            <legend className="sr-only">รายละเอียดสินค้ากลาง</legend>
            <label>ชื่อสินค้า<input required value={fields.name} maxLength={200} onChange={event => setFields({ ...fields, name: event.target.value })} /></label>
            <label>แบรนด์<input value={fields.brand} maxLength={100} onChange={event => setFields({ ...fields, brand: event.target.value })} /></label>
            <label>ขนาด / บรรจุ<input value={fields.packageSize} maxLength={100} onChange={event => setFields({ ...fields, packageSize: event.target.value })} /></label>
            <label>หน่วย<input value={fields.unit} maxLength={40} onChange={event => setFields({ ...fields, unit: event.target.value })} /></label>
            <label>หมวดหมู่<input value={fields.category} maxLength={100} onChange={event => setFields({ ...fields, category: event.target.value })} /></label>
          </fieldset>
          <details className="disclosure"><summary>ข้อมูลระบบ<Icon name="down" /></summary><div className="admin-metadata"><p>แหล่งข้อมูล: {product.source}</p><p>รหัสจากร้าน: {product.sourceProductId ?? 'ไม่มี'}</p>{product.sourceUrl ? <p>ลิงก์: {product.sourceUrl}</p> : null}<p>รหัสสินค้า: {product.id}</p><p>เวอร์ชัน: {product.revision}</p><p>สร้าง: {product.createdAt}</p><p>อัปเดต: {product.updatedAt}</p><p>ข้อมูลที่แต่ละบัญชีปรับไว้ยังคงเดิม</p></div></details>
          {pending ? <div className="pending-change"><p>ยังรอยืนยันผล คำขออาจถูกบันทึกแล้ว</p><small>{pending.payload.operationId}</small><button type="button" className="primary-button" disabled={!online || busy || storageBlocked} onClick={() => void save()}>{busy ? 'กำลังตรวจสอบ…' : 'ตรวจสอบผลด้วยรหัสเดิม'}</button></div>
            : <div className="page-actions"><button className="primary-button" disabled={locked}>{busy ? 'กำลังบันทึก…' : 'บันทึกข้อมูลกลาง'}</button><button type="button" className="text-button" disabled={busy} onClick={closeProduct}>กลับไปสินค้าทั้งหมด</button></div>}
        </form>
        {stale && !pending ? <button type="button" className="secondary-button" disabled={!online || busy} onClick={() => {
          if (!dirty || window.confirm('โหลดข้อมูลล่าสุดและละทิ้งแบบฟอร์มนี้หรือไม่?')) void openProduct(product.id, true)
        }}>โหลดข้อมูลล่าสุด</button> : null}
      </> : <>
        <div className="summary-row"><h2>สินค้าทั้งระบบ</h2>{loaded ? <span className="status-chip">{total} สินค้า</span> : null}</div>
        <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); void loadList(true, search) }}><div className="search-bar"><button className="icon-button" aria-label="ค้นหาสินค้าทั้งระบบ" disabled={!online || busy}><Icon name="search" /></button><input aria-label="ค้นหาสินค้าทั้งระบบ" type="search" maxLength={80} value={search} onChange={event => setSearch(event.target.value)} placeholder="ชื่อสินค้า, SKU หรือบาร์โค้ด" disabled={!online || busy} /></div></form>
        {pending ? <div className="pending-change"><p>มีคำขอแก้ไขที่รอยืนยันผล</p><button type="button" className="secondary-button" disabled={!online || busy} onClick={() => void openProduct(pending.productId)}>เปิดคำขอเดิม</button></div> : null}
        <div className="product-library">{items.map(item => <div className="library-row" key={item.id}><button type="button" className="library-details" disabled={!online || busy || Boolean(pending)} onClick={() => void openProduct(item.id)} aria-label={`แก้ไข ${item.name}`}><ProductThumb imageUrl={item.imageUrl} /><span className="row-description"><strong>{item.name}</strong><small>{item.sku}</small>{item.upc ? <small>{item.upc}</small> : null}</span></button></div>)}</div>
        {busy ? <p role="status">กำลังโหลด…</p> : loaded && !items.length ? <p className="empty-state">ไม่พบสินค้า</p> : null}
        {cursor ? <button type="button" className="secondary-button" disabled={!online || busy} onClick={() => void loadList(false)}>ดูสินค้าเพิ่มเติม</button> : null}
        <div className="page-actions"><button type="button" className="secondary-button" disabled={!online || busy} onClick={() => void loadList()}>โหลดข้อมูลใหม่</button><button type="button" className="text-button" disabled={busy} onClick={onBack}>ออกจากผู้ดูแล</button></div>
      </>}
    </div>
  </section>
}

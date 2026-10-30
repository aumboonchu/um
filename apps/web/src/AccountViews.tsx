import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './auth-client'
import { ProductEditor } from './ProductEditor'
import { ProductThumb } from './ui'
import {
  bangkokMonth, createChangeAttempt, fieldsForPurchase, formatMoney, formatPurchaseDate, getDashboard, getProductDetail, getPurchaseDetail,
  listPendingChanges, loadPendingChange, managementMessage, sendChange,
  type ChangeAttempt, type Dashboard, type ProductDetail, type PurchaseDetail, type PurchaseFields, type PurchaseItem,
} from './purchase-management'

export function PurchaseFieldInputs({ fields, onChange, disabled = false }: { fields: PurchaseFields; onChange: (fields: PurchaseFields) => void; disabled?: boolean }) {
  const edit = (name: keyof PurchaseFields, value: string) => onChange({ ...fields, [name]: value })
  return <fieldset className="purchase-fieldset purchase-form" disabled={disabled}>
    <legend>ข้อมูลการซื้อจริง</legend>
    <label>ราคาต่อหน่วย (บาท)<input value={fields.price} inputMode="decimal" required onChange={e => edit('price', e.target.value)} /></label>
    <label>จำนวน<input value={fields.quantity} inputMode="decimal" required onChange={e => edit('quantity', e.target.value)} /></label>
    <label className="full-width">วันที่และเวลาที่ซื้อ (เวลาบนอุปกรณ์)<input type="datetime-local" step="1" value={fields.purchasedAt} required onChange={e => edit('purchasedAt', e.target.value)} /></label>
    <label className="full-width">ร้านค้า (ไม่บังคับ)<input value={fields.storeName} maxLength={80} onChange={e => edit('storeName', e.target.value)} /></label>
    <label className="full-width">หมายเหตุ (ไม่บังคับ)<textarea value={fields.note} maxLength={500} rows={3} onChange={e => edit('note', e.target.value)} /></label>
  </fieldset>
}

export function PurchaseSummaryList({ items, onOpen }: { items: PurchaseItem[]; onOpen: (id: string) => void }) {
  return <div className="summary-purchases">{items.map(item => <button type="button" className="summary-purchase" key={item.id} onClick={() => onOpen(item.id)} aria-label={`ดูรายการซื้อ ${item.productName} ${formatPurchaseDate(item.purchasedAt)}`}>
    <span><strong>{item.productName}</strong><small>{formatPurchaseDate(item.purchasedAt)} · {item.quantity} หน่วย{item.storeName ? ` · ${item.storeName}` : ''}</small></span><strong>{formatMoney(item.totalMinor)}</strong>
  </button>)}</div>
}

export function HomeSummary({ apiOrigin, accountId, online, version, pendingCount, onAdd, onHistory, onPurchase }: { apiOrigin: string; accountId: string | null; online: boolean; version: number; pendingCount: number | null; onAdd: () => void; onHistory: () => void; onPurchase: (id: string) => void }) {
  const [month, setMonth] = useState(bangkokMonth), [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [pendingChanges, setPendingChanges] = useState<ChangeAttempt[]>([]), [pendingWarning, setPendingWarning] = useState('')
  useEffect(() => {
    if (accountId) {
      try { setPendingChanges(listPendingChanges(accountId)); setPendingWarning('') }
      catch { setPendingWarning('ยังตรวจรายการแก้ไข/ลบที่รอยืนยันบนอุปกรณ์ไม่ได้ กรุณาตรวจพื้นที่เก็บข้อมูล โดยอย่าล้างข้อมูลเว็บหากยังมีรายการค้าง') }
    }
    if (!accountId || !online || !/^\d{4}-\d{2}$/.test(month)) return
    let current = true
    setLoading(true); setError('')
    void getDashboard(apiOrigin, month).then(value => { if (current) setData(value) }).catch(e => { if (current) setError(managementMessage(e instanceof Error ? e.message : '')) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [apiOrigin, accountId, online, month, version, reload])
  const shown = data?.month === month ? data : null
  return <section className="content-panel home-summary" aria-labelledby="home-title">
    <div className="section-heading"><div><p className="eyebrow">ภาพรวมของคุณ</p><h2 id="home-title">สรุปค่าใช้จ่าย</h2></div><button className="primary-button" onClick={onAdd}>+ บันทึกการซื้อ</button></div>
    <label className="month-filter">เดือนที่ต้องการดู (เวลาไทย)<input type="month" min="2000-01" max="2100-12" value={month} onChange={e => setMonth(e.target.value)} /></label>
    {!accountId ? <p className="empty-state">เข้าสู่ระบบด้วย Google เพื่อดูสรุปค่าใช้จ่ายและรายการซื้อของคุณ</p> : null}
    {!online ? <p className="status-message">ออฟไลน์ — {shown ? 'แสดงข้อมูลล่าสุดที่โหลดแล้ว ยอดอาจยังไม่เป็นปัจจุบัน' : 'เชื่อมต่ออินเทอร์เน็ตเพื่อโหลดข้อมูลของบัญชีนี้'}</p> : null}
    {loading ? <p role="status">กำลังโหลดภาพรวม…</p> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {pendingWarning ? <p className="error-message" role="alert">{pendingWarning}</p> : null}
    {accountId && pendingChanges.length > 0 ? <div className="pending-change"><h3>มี {pendingChanges.length} รายการแก้ไข/ลบรอยืนยันผล</h3><p>รายการอาจเปลี่ยนในฐานข้อมูลแล้ว กดตรวจด้วยรหัสเดิม แม้รายการซื้อจะไม่อยู่ในประวัติแล้วก็ตาม</p>{pendingChanges.map(attempt => <button className="secondary-button" key={attempt.payload.operationId} onClick={() => onPurchase(attempt.purchaseId)}>ตรวจสอบคำขอ{attempt.action === 'edit' ? 'แก้ไข' : 'ลบ'} · {attempt.purchaseId}</button>)}</div> : null}
    {accountId && shown ? <>
      <dl className="summary-grid"><div className="summary-main"><dt>ยอดซื้อเดือนนี้</dt><dd>{formatMoney(shown.totalSpentMinor)}</dd></div><div><dt>รายการซื้อ</dt><dd>{shown.purchaseCount.toLocaleString('th-TH')} <small>รายการ</small></dd></div><div><dt>เฉลี่ยต่อรายการ</dt><dd>{formatMoney(shown.averageMinor)}</dd></div><div><dt>สินค้าที่ซื้อ</dt><dd>{shown.productCount.toLocaleString('th-TH')} <small>ชนิด</small></dd></div></dl>
      {shown.purchaseCount === 0 ? <div className="empty-state"><p>ยังไม่มีรายการซื้อในเดือนที่เลือก</p><button className="secondary-button" onClick={onAdd}>เพิ่มสินค้าหรือสแกนบาร์โค้ดชิ้นแรก</button></div> : null}
      <p className="status-message">ยอดนี้นับเฉพาะรายการที่ซิงก์เข้าระบบแล้ว{pendingCount ? ` ยังมี ${pendingCount} รายการรอซิงก์` : ''} ไม่รวมรายการที่ลบ</p>
      <div className="section-heading"><h3>รายการซื้อล่าสุด</h3><button className="secondary-button" onClick={onHistory}>ดูประวัติทั้งหมด</button></div>
      <PurchaseSummaryList items={shown.recentPurchases} onOpen={onPurchase} />
    </> : null}
    {accountId ? <button className="secondary-button" disabled={!online || loading} onClick={() => setReload(v => v + 1)}>โหลดภาพรวมใหม่</button> : null}
  </section>
}

export function PurchaseDetailView({ apiOrigin, accountId, id, online, onBack, onChanged, onProduct, onDirtyChange }: { apiOrigin: string; accountId: string; id: string; online: boolean; onBack: () => void; onChanged: () => void; onProduct: (id: string) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [data, setData] = useState<PurchaseDetail | null>(null), [fields, setFields] = useState<PurchaseFields | null>(null)
  const [pending, setPending] = useState<ChangeAttempt | null>(null), [storageError, setStorageError] = useState(false)
  const [loading, setLoading] = useState(false), [editing, setEditing] = useState(false), [deleting, setDeleting] = useState(false), [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false), [deleted, setDeleted] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const mounted = useRef(true), busy = useRef(false), loadSequence = useRef(0), heading = useRef<HTMLHeadingElement>(null)
  const dirty = Boolean(pending) || Boolean(editing && data && fields && JSON.stringify(fields) !== JSON.stringify(fieldsForPurchase(data)))
  const changedRef = useRef(onChanged); changedRef.current = onChanged
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  function readPending() {
    try { setPending(loadPendingChange(accountId, id)); setStorageError(false) }
    catch { setStorageError(true); setError('ยังตรวจสอบรายการที่รอผลบนอุปกรณ์ไม่ได้ จึงยังไม่เปิดให้แก้ไข/ลบใหม่ กรุณาลองตรวจสอบอีกครั้ง อย่าล้างข้อมูลเว็บหากยังมีรายการรอยืนยัน') }
  }
  async function load() {
    if (!online) return
    const token = ++loadSequence.current
    setLoading(true); setError('')
    try {
      const value = await getPurchaseDetail(apiOrigin, id)
      if (!mounted.current || token !== loadSequence.current) return
      setData(value); setFields(fieldsForPurchase(value)); setEditing(false); setDeleting(false); setChecked(false)
    } catch (e) { if (mounted.current && token === loadSequence.current) setError(managementMessage(e instanceof Error ? e.message : '')) }
    finally { if (mounted.current && token === loadSequence.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; readPending()
    heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest' })
    return () => { mounted.current = false; loadSequence.current += 1 }
  }, [accountId, id])
  useEffect(() => {
    // A reconnect must not discard a form the user is still editing.
    if (online && !editing && !deleted) void load()
  }, [accountId, id, online])
  async function submit(action: 'edit' | 'delete') {
    if (!online || busy.current || storageError) return
    if (!pending && (!data || (action === 'delete' && !checked))) return
    let attempt: ChangeAttempt
    try { attempt = pending ?? createChangeAttempt(id, data!.revision, action === 'edit' ? fields : null) }
    catch (e) { setError(e instanceof Error ? e.message : 'กรุณาตรวจข้อมูล'); return }
    setPending(attempt); setSaving(true); busy.current = true; setError(''); setMessage('กำลังตรวจยืนยันผลกับฐานข้อมูล…')
    const result = await sendChange(accountId, attempt, init => apiFetch(apiOrigin, `/api/v1/purchases/${encodeURIComponent(id)}`, init))
    busy.current = false
    if (!mounted.current) return
    setSaving(false)
    if (result.status === 'success') {
      setPending(result.cleanupPending ? attempt : null)
      setEditing(false); setDeleting(false); setChecked(false)
      setMessage(`${attempt.action === 'delete' ? 'ลบรายการจากประวัติและยอดรวมแล้ว (ข้อมูลเดิมยังเก็บไว้ ไม่ลบถาวร)' : 'แก้ไขรายการซื้อและยอดรวมแล้ว'}${result.cleanupPending ? ' แต่ยังล้างสถานะรอยืนยันบนอุปกรณ์ไม่ได้ ให้ตรวจสอบด้วยรหัสเดิมอีกครั้ง' : ''}`)
      changedRef.current()
      if (attempt.action === 'delete') setDeleted(true)
      else await load()
    } else {
      setMessage(''); setError(result.message)
      if (result.status === 'error') setPending(null)
      if (result.status === 'blocked') readPendingOrKeep(attempt)
    }
  }
  function readPendingOrKeep(attempt: ChangeAttempt) { try { setPending(loadPendingChange(accountId, id) ?? attempt) } catch { setPending(attempt) } }
  const locked = !online || saving || Boolean(pending) || storageError || deleted
  function reload() {
    if (dirty && !pending && !window.confirm('ละทิ้งข้อมูลที่แก้ไขและโหลดรายการล่าสุดหรือไม่?')) return
    readPending(); void load()
  }
  return <section className="content-panel detail-panel" aria-labelledby="purchase-detail-title">
    <button className="secondary-button back-button" onClick={onBack} disabled={saving}>← กลับ</button>
    <h2 id="purchase-detail-title" ref={heading} tabIndex={-1}>รายละเอียดรายการซื้อ</h2>
    {!online ? <p className="status-message">ขณะนี้ออฟไลน์ แก้ไขและลบได้เมื่อออนไลน์เท่านั้น ข้อมูลที่แสดงอาจยังไม่เป็นปัจจุบัน</p> : null}
    {loading ? <p role="status">กำลังโหลดรายการ…</p> : null}
    {message ? <p className="success-message" role="status">{message}</p> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {storageError ? <button className="secondary-button" onClick={readPending}>ตรวจสอบสถานะบนอุปกรณ์อีกครั้ง</button> : null}
    {pending ? <div className="pending-change"><strong>มีคำขอ{pending.action === 'delete' ? 'ลบ' : 'แก้ไข'}ที่ต้องตรวจสอบผล</strong><p>รายการอาจเปลี่ยนแล้ว ระบบเก็บรหัสเดิมไว้เพื่อไม่ส่งซ้ำเป็นรายการใหม่</p><small>รหัสรายการ: {pending.payload.operationId}</small><button className="primary-button" disabled={!online || saving || storageError} onClick={() => void submit(pending.action)}>{saving ? 'กำลังตรวจสอบ…' : 'ตรวจสอบผลด้วยรหัสเดิม'}</button></div> : null}
    {data ? <>
      <div className="detail-product"><h3>{data.productName}</h3><p>{[data.productBrand, data.packageSize].filter(Boolean).join(' · ')}</p><p>SKU: {data.productSku}</p><p>UPC / EAN: {data.productUpc ?? 'ยังไม่มีบาร์โค้ด'}</p><button className="secondary-button" onClick={() => onProduct(data.productId)} disabled={dirty || saving}>ดูรายละเอียดสินค้า</button></div>
      <dl className="detail-grid"><div><dt>ร้านค้า</dt><dd>{data.storeName ?? 'ไม่ระบุ'}</dd></div><div><dt>วันที่และเวลาซื้อ</dt><dd>{formatPurchaseDate(data.purchasedAt)}</dd></div><div><dt>ราคาต่อหน่วย</dt><dd>{formatMoney(data.unitPriceMinor)}</dd></div><div><dt>จำนวน</dt><dd>{data.quantity}</dd></div><div className="detail-total"><dt>ยอดรวมรายการ</dt><dd>{formatMoney(data.totalMinor)}</dd></div><div><dt>หมายเหตุ</dt><dd className="preserve-text">{data.note ?? 'ไม่มีหมายเหตุ'}</dd></div></dl>
      {data.shoppingRoundId ? <p className="image-import-notice">รายการอยู่ในรอบที่ชำระแล้ว {data.shoppingRoundId.slice(0, 8)} ดูรายงานรายรอบได้ ไม่เปิดให้แก้หรือลบรายชิ้นเพื่อคงยอดทั้งรอบ</p> : null}
      {!data.shoppingRoundId && !editing && !deleting && !deleted ? <div className="detail-actions"><button className="primary-button" disabled={locked || loading} onClick={() => { setEditing(true); setMessage(''); setError('') }}>แก้ไขรายการซื้อ</button><button className="danger-outline" disabled={locked || loading} onClick={() => { setDeleting(true); setChecked(false); setMessage(''); setError('') }}>ลบรายการซื้อ</button></div> : null}
      {editing && fields ? <form className="edit-purchase" onSubmit={e => { e.preventDefault(); void submit('edit') }}><PurchaseFieldInputs fields={fields} onChange={setFields} disabled={locked} /><div className="detail-actions"><button className="primary-button" disabled={locked}>บันทึกการแก้ไข</button><button type="button" className="secondary-button" disabled={saving || Boolean(pending)} onClick={() => { if (dirty && !window.confirm('ยกเลิกการแก้ไขที่ยังไม่บันทึกหรือไม่?')) return; setFields(fieldsForPurchase(data)); setEditing(false) }}>ยกเลิกการแก้ไข</button></div></form> : null}
      {deleting && !deleted ? <div className="delete-confirmation" role="region" aria-label="ยืนยันลบรายการซื้อ"><h3>ยืนยันลบรายการนี้หรือไม่?</h3><p>{data.productName} · {formatMoney(data.totalMinor)} · {formatPurchaseDate(data.purchasedAt)}</p><p>รายการจะไม่แสดงในประวัติและไม่นับในยอดรวม แต่จะเก็บข้อมูลเดิมไว้โดยไม่ลบถาวร</p><label className="delete-check"><input type="checkbox" checked={checked} disabled={locked} onChange={e => setChecked(e.target.checked)} /><span>ฉันตรวจสอบรายการและยืนยันให้ลบ</span></label><div className="detail-actions"><button className="danger-button" disabled={locked || !checked} onClick={() => void submit('delete')}>ยืนยันลบรายการนี้</button><button className="secondary-button" disabled={saving || Boolean(pending)} onClick={() => { setDeleting(false); setChecked(false) }}>ไม่ลบ / ย้อนกลับ</button></div></div> : null}
    </> : null}
    {!pending && !deleted ? <button className="secondary-button" disabled={!online || loading || saving} onClick={reload}>โหลดข้อมูลล่าสุด</button> : null}
  </section>
}

export function ProductDetailView({ apiOrigin, accountId, id, online, onBack, onPurchase, onBuy, onChanged, onDirtyChange }: { apiOrigin: string; accountId: string; id: string; online: boolean; onBack: () => void; onPurchase: (id: string) => void; onBuy: (product: ProductDetail) => void; onChanged: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [data, setData] = useState<ProductDetail | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [editorActive, setEditorActive] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!online || editorActive) { setLoading(false); return }
    let current = true
    setLoading(true); setError('')
    void getProductDetail(apiOrigin, id).then(value => { if (current) setData(value) }).catch(e => { if (current) setError(managementMessage(e instanceof Error ? e.message : '')) }).finally(() => { if (current) setLoading(false) })
    heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest' })
    return () => { current = false }
  }, [apiOrigin, id, online, reload, editorActive])
  return <section className="content-panel detail-panel" aria-labelledby="product-detail-title"><button className="secondary-button back-button" onClick={onBack}>← กลับ</button><h2 id="product-detail-title" tabIndex={-1} ref={heading}>รายละเอียดสินค้า</h2>
    {!online ? <p className="status-message">ออฟไลน์ — แสดงเฉพาะข้อมูลที่โหลดไว้ในหน้านี้</p> : null}
    {loading ? <p role="status">กำลังโหลดสินค้า…</p> : null}{error ? <p className="error-message" role="alert">{error}</p> : null}
    {data ? <><div className="detail-product">{data.imageUrl ? <ProductThumb imageUrl={data.imageUrl} large /> : null}<h3>{data.name}</h3><p>{[data.brand, data.packageSize].filter(Boolean).join(' · ')}</p><p>SKU: {data.sku}</p><p>UPC / EAN: {data.upc ?? 'ยังไม่มีบาร์โค้ด'}</p>{data.category ? <p>หมวดหมู่: {data.category}</p> : null}</div>
      <ProductEditor product={data} accountId={accountId} apiOrigin={apiOrigin} online={online} disabled={loading} onProduct={setData} onChanged={onChanged} onDirtyChange={onDirtyChange} onActiveChange={setEditorActive} />
      {!editorActive ? <>
      <dl className="summary-grid"><div><dt>จำนวนรายการซื้อ</dt><dd>{data.purchaseCount}</dd></div><div><dt>ยอดสะสม</dt><dd>{formatMoney(data.totalSpentMinor)}</dd></div><div><dt>ราคาต่ำสุดที่เคยซื้อ</dt><dd>{data.minimumPriceMinor === null ? '—' : formatMoney(data.minimumPriceMinor)}</dd></div><div><dt>ราคาสูงสุดที่เคยซื้อ</dt><dd>{data.maximumPriceMinor === null ? '—' : formatMoney(data.maximumPriceMinor)}</dd></div></dl>
      <p className="status-message">สถิติและราคานี้มาจากรายการซื้อของคุณเท่านั้น ไม่ใช่ราคาปัจจุบันจากร้านค้า ไม่รวมรายการที่ลบ</p><button className="primary-button" disabled={!online} onClick={() => onBuy(data)}>บันทึกซื้อสินค้านี้อีก</button>
      <h3>รายการซื้อสินค้านี้ล่าสุด (ไม่เกิน 20 รายการ)</h3><PurchaseSummaryList items={data.recentPurchases} onOpen={onPurchase} />{data.recentPurchases.length === 0 ? <p>ยังไม่มีรายการซื้อที่ใช้งานอยู่</p> : null}
      </> : null}
    </> : null}<button className="secondary-button" disabled={!online || loading || editorActive} onClick={() => setReload(value => value + 1)}>โหลดสินค้าใหม่</button>
  </section>
}

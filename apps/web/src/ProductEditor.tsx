import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './auth-client'
import { cacheProduct, findCachedProduct } from './offline'
import { getProductDetail, type ProductDetail } from './purchase-management'
import { createProductEdit, loadProductEdit, productEditMessage, productFields, sendProductEdit, type ProductEditAttempt, type ProductFields } from './product-edit'

export function ProductEditor({ product, accountId, apiOrigin, online, disabled, onProduct, onChanged, onDirtyChange, onActiveChange }: {
  product: ProductDetail; accountId: string; apiOrigin: string; online: boolean; disabled: boolean;
  onProduct: (product: ProductDetail) => void; onChanged: () => void; onDirtyChange: (dirty: boolean) => void; onActiveChange: (active: boolean) => void;
}) {
  const [fields, setFields] = useState(() => productFields(product)), [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<ProductEditAttempt | null>(null), [blocked, setBlocked] = useState(false)
  const [saving, setSaving] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const mounted = useRef(true), busy = useRef(false), heading = useRef<HTMLHeadingElement>(null)
  const callbacks = useRef({ onProduct, onChanged }); callbacks.current = { onProduct, onChanged }
  const dirty = Boolean(pending) || blocked || saving || editing && JSON.stringify(fields) !== JSON.stringify(productFields(product))
  const active = editing || Boolean(pending) || blocked || stale
  function restore() {
    try {
      const previous = loadProductEdit(accountId, product.id)
      setBlocked(false)
      if (previous) { setPending(previous); setFields(productFields(previous.payload)); setEditing(true); setMessage('มีคำขอที่รอยืนยันผล กรุณาตรวจสอบด้วยรหัสเดิม') }
    } catch { setBlocked(true); setError('ยังตรวจสอบคำขอเดิมบนอุปกรณ์ไม่ได้ จึงยังไม่ส่งคำขอใหม่ กรุณาลองอีกครั้ง อย่าล้างข้อมูลเว็บหากมีคำขอรอยืนยัน') }
  }
  useEffect(() => { mounted.current = true; restore(); return () => { mounted.current = false } }, [accountId, product.id])
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false) }, [dirty, onDirtyChange])
  useEffect(() => { onActiveChange(active); return () => onActiveChange(false) }, [active, onActiveChange])
  useEffect(() => { if (editing) heading.current?.focus({ preventScroll: true }) }, [editing])
  useEffect(() => {
    if (!dirty) return
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  async function refresh() {
    const next = await getProductDetail(apiOrigin, product.id)
    if (!mounted.current) return
    callbacks.current.onProduct(next)
    setFields(productFields(next)); setStale(false)
    try {
      const cached = next.upc ? await findCachedProduct(next.upc, accountId) : null
      await cacheProduct({ id: next.id, sku: next.sku, upc: next.upc, name: next.name, brand: next.brand, packageSize: next.packageSize,
        imageUrl: next.imageUrl, profileRevision: next.profileRevision ?? 0, source: cached?.source ?? 'smartcart',
        sourcePriceMinor: cached?.sourcePriceMinor ?? next.recentPurchases[0]?.unitPriceMinor ?? null,
        regularPriceMinor: cached?.regularPriceMinor ?? null, fetchedAt: cached?.fetchedAt ?? null }, accountId)
    } catch { if (mounted.current) setMessage('ข้อมูลใน D1 พร้อมแล้ว แต่ยังอัปเดต cache บนเครื่องไม่ได้') }
  }
  async function save() {
    if (!online || busy.current || blocked || stale && !pending) return
    let attempt: ProductEditAttempt
    try { attempt = pending ?? createProductEdit(accountId, product.id, product.profileRevision ?? 0, fields) }
    catch (e) { setError(productEditMessage(e instanceof Error ? e.message : 'INVALID_PRODUCT_CHANGE')); return }
    busy.current = true; setSaving(true); setPending(attempt); setError(''); setMessage('กำลังบันทึกสินค้า…')
    const result = await sendProductEdit(accountId, attempt, init => apiFetch(apiOrigin, `/api/v1/products/${encodeURIComponent(product.id)}/detail`, init))
    if (!mounted.current) { busy.current = false; return }
    if (result.status === 'success') {
      setPending(result.cleanupPending ? attempt : null)
      setMessage(result.cleanupPending ? 'บันทึกสินค้าแล้ว แต่ยังล้างสถานะบนเครื่องไม่ได้ โปรดตรวจสอบด้วยรหัสเดิม' : 'บันทึกสินค้าแล้ว')
      callbacks.current.onChanged()
      try { await refresh(); if (mounted.current) setEditing(result.cleanupPending) }
      catch { if (mounted.current) { setStale(true); setError('บันทึกสินค้าแล้ว แต่ยังโหลดข้อมูลล่าสุดไม่ได้ กรุณาโหลดล่าสุดก่อนแก้ไขครั้งต่อไป') } }
    } else {
      setMessage(''); setError(result.message)
      if (result.status === 'error') { setPending(null); if (result.code === 'PRODUCT_CONFLICT') setStale(true) }
      if (result.status === 'blocked') setBlocked(true)
    }
    busy.current = false; if (mounted.current) setSaving(false)
  }
  const locked = !online || saving || Boolean(pending) || blocked || stale
  function change(key: keyof ProductFields, value: string) { setFields(previous => ({ ...previous, [key]: value })); setError(''); setMessage('') }
  async function loadLatest() {
    if (busy.current || !online || pending || blocked) return
    if (dirty && !window.confirm('โหลดข้อมูลล่าสุดและยกเลิกข้อมูลในแบบฟอร์มนี้หรือไม่?')) return
    busy.current = true; setSaving(true); setError('')
    try { await refresh(); if (mounted.current) setEditing(false) }
    catch { if (mounted.current) setError('ยังโหลดสินค้าล่าสุดไม่ได้ กรุณาลองอีกครั้ง') }
    finally { busy.current = false; if (mounted.current) setSaving(false) }
  }
  return <div className="product-editor">
    {message ? <p role="status" className="success-message">{message}</p> : null}
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    {blocked ? <button type="button" className="secondary-button" disabled={saving} onClick={restore}>ตรวจสอบคำขอเดิมบนเครื่อง</button> : null}
    {!active ? <button type="button" className="secondary-button" disabled={!online || disabled} onClick={() => { setFields(productFields(product)); setEditing(true); setError(''); setMessage('') }}>แก้ไขสินค้า</button> : null}
    {active ? <>
      <h3 ref={heading} tabIndex={-1}>แก้ไขรายละเอียดสินค้า</h3><p className="muted">ข้อมูลเฉพาะบัญชีคุณ · SKU และบาร์โค้ดคงเดิม</p>
      <form className="focused-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <fieldset className="purchase-fieldset" disabled={locked}>
          <legend className="sr-only">รายละเอียดสินค้า</legend>
          <label>ชื่อสินค้า<input value={fields.name} maxLength={200} required onChange={event => change('name', event.target.value)} /></label>
          <label>แบรนด์<input value={fields.brand} maxLength={100} onChange={event => change('brand', event.target.value)} /></label>
          <label>ขนาด / บรรจุ<input value={fields.packageSize} maxLength={100} onChange={event => change('packageSize', event.target.value)} /></label>
          <details className="disclosure"><summary>รายละเอียดเพิ่มเติม</summary><div><label>หน่วย<input value={fields.unit} maxLength={40} onChange={event => change('unit', event.target.value)} /></label><label>หมวดหมู่<input value={fields.category} maxLength={100} onChange={event => change('category', event.target.value)} /></label></div></details>
        </fieldset>
        {pending ? <div className="pending-change"><p>คำขออาจถูกบันทึกแล้ว ตรวจสอบด้วยรหัสเดิมเพื่อไม่ส่งซ้ำ</p><small>{pending.payload.operationId}</small><button type="button" className="primary-button" disabled={!online || saving || blocked} onClick={() => void save()}>{saving ? 'กำลังตรวจสอบ…' : 'ตรวจสอบผลด้วยรหัสเดิม'}</button></div> : <div className="detail-actions"><button className="primary-button" disabled={locked || disabled}>{saving ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}</button><button type="button" className="secondary-button" disabled={saving || blocked} onClick={() => { setEditing(false); setStale(false); setFields(productFields(product)); setError(''); setMessage('') }}>ยกเลิก</button></div>}
      </form>
      {stale && !pending ? <button type="button" className="secondary-button" disabled={!online || saving} onClick={() => void loadLatest()}>โหลดข้อมูลสินค้าล่าสุด</button> : null}
    </> : null}
  </div>
}

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { AdminError, adminMessage, adminSessionError, type AdminProduct } from './admin-client'
import { clearAdminImage, definiteAdminImageError, readAdminImage, sendAdminImage, type AdminImageAttempt } from './admin-product-image'
import { ProductImageCropper } from './ProductImageCropper'
import { cropPreviewUrl, type CroppedProductImage } from './product-image-crop'
import { validateSourceImage } from './image-import'
import { ProductThumb } from './ui'

export type AdminImageState = { dirty: boolean; busy: boolean; pendingProductId: string | null }
export function AdminProductImage({ apiOrigin, accountId, token, product, online, disabled, onStateChange, onSaved, onConflict, onSessionError }: {
  apiOrigin: string; accountId: string; token: string; product: AdminProduct; online: boolean; disabled: boolean;
  onStateChange: (state: AdminImageState) => void; onSaved: () => Promise<void>; onConflict: () => void; onSessionError: (error: unknown) => void;
}) {
  const [source, setSource] = useState<File | null>(null), [draft, setDraft] = useState<CroppedProductImage | null>(null)
  const [pending, setPending] = useState<AdminImageAttempt | null>(null), [storageBlocked, setStorageBlocked] = useState(false)
  const [foreignPendingId, setForeignPendingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const mounted = useRef(true), busyRef = useRef(false), pendingRef = useRef<AdminImageAttempt | null>(null)
  const storedProductId = useRef<string | null>(null)
  const callbacks = useRef({ onStateChange, onSaved, onConflict, onSessionError }); callbacks.current = { onStateChange, onSaved, onConflict, onSessionError }
  function changePending(value: AdminImageAttempt | null) { pendingRef.current = value; storedProductId.current = value?.productId ?? null; setPending(value) }
  function restore() {
    try {
      const saved = readAdminImage(accountId)
      if (saved && saved.productId !== product.id) { storedProductId.current = saved.productId; setForeignPendingId(saved.productId); setStorageBlocked(true); setError('มีคำขอรูปของสินค้าอื่นรอยืนยัน'); return }
      setForeignPendingId(null)
      changePending(saved); if (saved) setDraft(saved.payload.productImage)
      setStorageBlocked(false)
    } catch { setStorageBlocked(true); setError('ยังตรวจคำขอรูปเดิมบนเครื่องไม่ได้ อย่าล้างข้อมูลเว็บหากมีคำขอรอยืนยัน') }
  }
  useEffect(() => {
    mounted.current = true; restore()
    return () => { mounted.current = false; callbacks.current.onStateChange({ dirty: false, busy: false, pendingProductId: storedProductId.current }) }
  }, [accountId, product.id])
  const dirty = Boolean(source || draft || pending) || storageBlocked || busy
  useEffect(() => { callbacks.current.onStateChange({ dirty, busy, pendingProductId: pending?.productId ?? foreignPendingId }) }, [dirty, busy, pending, foreignPendingId])
  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || disabled || !online || busyRef.current || pending) return
    const invalid = validateSourceImage(file)
    if (invalid) { setError(invalid); return }
    setSource(file); setDraft(null); setError(''); setMessage('')
  }
  async function save(image: CroppedProductImage, frozen = pending) {
    if (busyRef.current || !online || disabled) return
    const attempt: AdminImageAttempt = frozen ?? { version: 1, productId: product.id,
      payload: { accountId, operationId: crypto.randomUUID(), expectedRevision: product.revision, productImage: image } }
    busyRef.current = true; setBusy(true); setError(''); setMessage(''); changePending(attempt)
    try {
      await sendAdminImage(apiOrigin, token, attempt)
      if (!mounted.current) return
      let cleaned = false
      try { clearAdminImage(attempt); changePending(null); setDraft(null); cleaned = true }
      catch { setStorageBlocked(true) }
      setSource(null); setMessage(cleaned ? 'บันทึกรูปสินค้าแล้ว' : 'บันทึกรูปแล้ว แต่ยังล้างสถานะบนเครื่องไม่ได้ ตรวจด้วยรหัสเดิมได้')
      await callbacks.current.onSaved()
    } catch (e) {
      if (!mounted.current) return
      if (adminSessionError(e)) callbacks.current.onSessionError(e)
      setError(e instanceof AdminError && e.code === 'ADMIN_IMAGE_STORAGE_BLOCKED' ? 'ยังเก็บคำขอรูปบนเครื่องไม่ได้ จึงยังไม่ส่งคำขอใหม่'
        : e instanceof AdminError && ['PRODUCT_IMAGE_INVALID', 'PRODUCT_IMAGE_TOO_LARGE'].includes(e.code) ? 'รูปยังไม่ถูกต้อง กรุณาครอปใหม่'
          : adminMessage(e))
      if (e instanceof AdminError && e.code === 'ADMIN_IMAGE_STORAGE_BLOCKED') setStorageBlocked(true)
      if (definiteAdminImageError(e)) {
        try { clearAdminImage(attempt); changePending(null) } catch { setStorageBlocked(true) }
        if (e instanceof AdminError && e.code === 'PRODUCT_CONFLICT') callbacks.current.onConflict()
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="admin-product-image" aria-label="รูปสินค้า">
    <h3>รูปสินค้า</h3>
    {draft ? <div className="admin-crop-preview"><ProductThumb imageUrl={cropPreviewUrl(draft)} large /></div> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {message ? <p className="inline-message" role="status">{message}</p> : null}
    {source ? <ProductImageCropper source={source} disabled={busy || disabled || !online} onCancel={() => { setSource(null); setDraft(null) }}
      onConfirm={image => { setSource(null); setDraft(image); void save(image, null) }} />
      : pending ? <div className="pending-change"><p>รูปอาจบันทึกแล้ว ตรวจด้วยคำขอเดิม</p><button type="button" className="secondary-button" disabled={busy || disabled || !online} onClick={() => { setStorageBlocked(false); void save(pending.payload.productImage) }}>{busy ? 'กำลังตรวจรูป…' : 'ตรวจสอบรูปด้วยรหัสเดิม'}</button></div>
        : <>
          <label className="secondary-button admin-image-file">{product.imageUrl ? 'เปลี่ยนรูปสินค้า' : 'เลือกรูปสินค้า'}<input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || !online || busy || storageBlocked} onChange={choose} /></label>
          {draft ? <div className="detail-actions"><button type="button" className="primary-button" disabled={busy || disabled || !online || storageBlocked} onClick={() => void save(draft)}>บันทึกรูปสินค้า</button><button type="button" className="text-button" disabled={busy} onClick={() => { setDraft(null); setError('') }}>ไม่ใช้รูปนี้</button></div> : null}
        </>}
    {storageBlocked && !pending ? <button type="button" className="secondary-button" disabled={busy} onClick={restore}>ตรวจคำขอรูปบนเครื่องอีกครั้ง</button> : null}
    {!source && !pending && !message ? <p className="muted">เก็บเฉพาะส่วนที่ครอป ไม่เก็บภาพหน้าจอเต็ม</p> : null}
  </section>
}

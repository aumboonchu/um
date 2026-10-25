import { useEffect, useId, useRef } from 'react'
import type { BigcImportState } from './bigc-import'

export type ImportFeedbackProps = {
  state: BigcImportState
  onRetry: () => void
  onEdit: () => void
  onManual: () => void
  canRetry: boolean
  canManual: boolean
}

export function ImportFeedback({ state, onRetry, onEdit, onManual, canRetry, canManual }: ImportFeedbackProps) {
  const feedbackRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (state.status === 'idle' || state.status === 'loading') return
    const feedback = feedbackRef.current
    if (!feedback) return
    const reduceMotion = typeof window !== 'undefined'
      && (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false)
    feedback.focus?.({ preventScroll: true })
    feedback.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' })
  }, [state])

  if (state.status === 'idle') return null

  const isProblem = state.status === 'error' || state.status === 'uncertain'
  return <div
    ref={feedbackRef}
    className={`import-feedback import-feedback-${state.status}`}
    role={isProblem ? 'alert' : 'status'}
    aria-live={isProblem ? 'assertive' : 'polite'}
    aria-atomic="true"
    aria-labelledby={titleId}
    tabIndex={-1}
  >
    <span className={`import-status-icon${state.status === 'loading' ? ' import-spinner' : ''}`} aria-hidden="true">
      {state.status === 'loading' ? null : state.status === 'success' ? '✓' : '!'}
    </span>
    <div className="import-content">
      {state.status === 'loading' ? <>
        <h3 id={titleId}>กำลังตรวจสอบลิงก์และบันทึกสินค้า…</h3>
        <p>โปรดรอสักครู่ ขณะนี้ยังไม่ยืนยันว่าการเพิ่มสินค้าสำเร็จ</p>
      </> : state.status === 'success' ? <>
        <h3 id={titleId}>เพิ่มสินค้าเข้าฐานข้อมูลแล้ว</h3>
        <div className="import-product-details">
          <strong>{state.product.name}</strong>
          <span>SKU: <strong>{state.product.sku}</strong></span>
        </div>
        <p>ยืนยัน SKU ใน SmartCart แล้ว ลิงก์เดิมจะใช้ SKU เดิม ไม่เพิ่มสินค้าซ้ำ</p>
        <p className="import-next-step"><strong>ยังไม่ได้บันทึกรายการซื้อ</strong><br />กรอกราคาที่ซื้อจริงและจำนวน แล้วกด “บันทึกรายการซื้อ” ด้านล่าง</p>
      </> : state.status === 'error' ? <>
        <h3 id={titleId}>{state.title}</h3>
        <p>{state.message}</p>
        {state.code ? <p className="import-error-code">รหัสข้อผิดพลาด: <code>{state.code}</code></p> : null}
        <div className="import-actions">
          {state.retryable ? <button type="button" className="import-action import-retry" onClick={onRetry} disabled={!canRetry}>ลองนำเข้าอีกครั้ง</button> : null}
          <button type="button" className="import-action" onClick={onEdit}>แก้ไขลิงก์</button>
          <button type="button" className="import-action" onClick={onManual} disabled={!canManual}>ใช้ UPC / เพิ่มเอง</button>
        </div>
      </> : <>
        <h3 id={titleId}>ยังยืนยันผลการเพิ่มไม่ได้</h3>
        <p>{state.message}</p>
        {state.code ? <p className="import-error-code">รหัสการตรวจสอบ: <code>{state.code}</code></p> : null}
        <p>สินค้าอาจถูกบันทึกแล้ว ให้ตรวจสอบด้วยลิงก์เดิมก่อนดำเนินการต่อ</p>
        <div className="import-actions">
          <button type="button" className="import-action import-retry" onClick={onRetry} disabled={!canRetry}>ตรวจสอบด้วยลิงก์เดิม</button>
          <button type="button" className="import-action" onClick={onEdit}>แก้ไขลิงก์</button>
          <button type="button" className="import-action" onClick={onManual} disabled={!canManual}>ใช้ UPC / เพิ่มเอง</button>
        </div>
      </>}
    </div>
  </div>
}

export default ImportFeedback


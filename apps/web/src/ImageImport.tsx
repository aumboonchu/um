import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { apiFetch } from './auth-client'
import BarcodeScanner from './BarcodeScanner'
import {
  clearPendingImageAttempt, createImageImportAttempt, emptyImageFields, fieldsFromImageDraft, imageFingerprint,
  loadPendingImageAttempt, prepareImageUpload, requestPersistedImageConfirmation, requestImageExtraction, validateSourceImage,
  type ConfirmedImageProduct, type ImageImportAttempt, type ImageProductFields,
} from './image-import'

export type ImageImportProps = {
  accountId: string | null
  apiOrigin: string
  canImport: boolean
  onProduct: (product: ConfirmedImageProduct) => void
  onReset?: () => void
}

type Stage = 'idle' | 'preparing' | 'extracting' | 'review' | 'extract-error' | 'saving' | 'save-error' | 'uncertain' | 'success'
type Feedback = { kind: 'info' | 'error' | 'uncertain' | 'success'; title: string; message: string; code?: string }

export function ImageImport({ accountId, apiOrigin, canImport, onProduct, onReset }: ImageImportProps) {
  const id = useId()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [stage, setStageState] = useState<Stage>('idle')
  const [fields, setFields] = useState<ImageProductFields>(emptyImageFields)
  const [hasReview, setHasReview] = useState(false)
  const [checked, setChecked] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [allowExtractionRetry, setAllowExtractionRetry] = useState(true)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [savedProduct, setSavedProduct] = useState<ConfirmedImageProduct | null>(null)
  const [storageBlocked, setStorageBlocked] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const feedbackRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Stage>('idle')
  const mounted = useRef(true)
  const available = useRef(canImport)
  const epoch = useRef(0)
  const busyRef = useRef(false)
  const request = useRef<AbortController | null>(null)
  const preparedImage = useRef<Blob | null>(null)
  const fingerprint = useRef<string | null>(null)
  const attempt = useRef<ImageImportAttempt | null>(null)
  available.current = canImport

  function setStage(value: Stage) { stageRef.current = value; setStageState(value) }
  function invalidate() {
    epoch.current += 1
    request.current?.abort()
    request.current = null
    busyRef.current = false
  }
  function isCurrent(token: number) { return mounted.current && available.current && epoch.current === token }

  function restorePending() {
    if (!accountId) return
    try {
      const pending = loadPendingImageAttempt(accountId)
      setStorageBlocked(false)
      if (!pending) return
      attempt.current = pending
      fingerprint.current = pending.payload.imageSha256
      setFields(fieldsFromImageDraft(pending.payload))
      setHasReview(true)
      setChecked(true)
      setStage('uncertain')
      setFeedback({ kind: 'uncertain', title: 'มีรายการที่รอยืนยันผลการบันทึก', message: 'พบข้อมูลที่คุณยืนยันไว้ก่อนหน้านี้ สินค้าอาจถูกบันทึกแล้ว กดตรวจสอบด้วยรหัสรายการเดิมเพื่อรับ SKU โดยไม่ส่งเป็นรายการใหม่ ภาพต้นฉบับไม่ได้ถูกเก็บไว้' })
    } catch {
      setStorageBlocked(true)
      setFeedback({ kind: 'error', title: 'ยังตรวจสอบรายการที่ค้างอยู่ไม่ได้', message: 'พื้นที่เก็บข้อมูลบนอุปกรณ์ไม่พร้อมหรือข้อมูลรายการเดิมผิดรูปแบบ จึงยังไม่อนุญาตให้ส่งรายการใหม่ กรุณาลองตรวจสอบอีกครั้ง อย่าล้างข้อมูลเว็บหากยังมีรายการรอยืนยัน', code: 'IMAGE_PENDING_STORAGE_UNAVAILABLE' })
    }
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; invalidate(); preparedImage.current = null; fingerprint.current = null; attempt.current = null }
  }, [])

  useEffect(() => { restorePending() }, [accountId])

  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (canImport || !busyRef.current) return
    const wasSaving = stageRef.current === 'saving'
    invalidate()
    setStage(wasSaving ? 'uncertain' : 'extract-error')
    setFeedback(wasSaving
      ? { kind: 'uncertain', title: 'ยังยืนยันผลการบันทึกไม่ได้', message: 'การเชื่อมต่อหรือการเข้าสู่ระบบเปลี่ยนไป สินค้าอาจถูกบันทึกแล้ว เมื่อพร้อมให้ตรวจสอบด้วยปุ่มเดิม' }
      : { kind: 'error', title: 'การอ่านภาพหยุดลง', message: 'กรุณาเข้าสู่ระบบและเชื่อมต่ออินเทอร์เน็ตก่อนลองอีกครั้ง ยังไม่มีการสร้างสินค้า' })
  }, [canImport])

  useEffect(() => {
    if (!feedback || busyRef.current) return
    const element = feedbackRef.current
    const reduced = typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false)
    element?.focus?.({ preventScroll: true })
    element?.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' })
  }, [feedback])

  function resetImage(nextFile: File | null = null) {
    if (storageBlocked || (attempt.current && stageRef.current !== 'success')) return
    if (attempt.current && accountId) {
      try { clearPendingImageAttempt(accountId, attempt.current.payload.operationId) }
      catch {
        setFeedback({ kind: 'success', title: 'บันทึกสินค้าแล้ว แต่ยังล้างสถานะรอยืนยันไม่ได้', message: 'สินค้าอยู่ในฐานข้อมูลแล้ว กรุณาลองปุ่มเพิ่มสินค้าจากภาพใหม่อีกครั้งเมื่อพื้นที่เก็บข้อมูลบนอุปกรณ์พร้อม' })
        return
      }
    }
    invalidate()
    preparedImage.current = null
    fingerprint.current = null
    attempt.current = null
    setFile(nextFile)
    setFields(emptyImageFields())
    setHasReview(false)
    setChecked(false)
    setWarnings([])
    setAllowExtractionRetry(true)
    setFeedback(null)
    setSavedProduct(null)
    setStage('idle')
    if (!nextFile && fileInput.current) fileInput.current.value = ''
    onReset?.()
  }

  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    if (!canImport || storageBlocked || busyRef.current || attempt.current) return
    const selected = event.target.files?.[0]
    if (!selected) return
    const validation = validateSourceImage(selected)
    resetImage(validation ? null : selected)
    if (validation) setFeedback({ kind: 'error', title: 'ยังไม่ได้เลือกภาพที่รองรับ', message: validation })
  }

  function stopWaiting() {
    if (!canImport) return
    const wasSaving = stageRef.current === 'saving'
    invalidate()
    setStage(wasSaving ? 'uncertain' : 'idle')
    setFeedback(wasSaving
      ? { kind: 'uncertain', title: 'ยังยืนยันผลการบันทึกไม่ได้', message: 'หยุดรอผลแล้ว แต่สินค้าอาจถูกบันทึกไปแล้ว ให้ตรวจสอบด้วยปุ่มเดิมและรหัสรายการเดิม' }
      : { kind: 'info', title: 'ยกเลิกการอ่านภาพแล้ว', message: 'ยังไม่มีการสร้างสินค้า คุณสามารถเริ่มอ่านภาพอีกครั้งหรือเลือกภาพใหม่' })
  }

  async function readImage() {
    if (!canImport || storageBlocked || !file || busyRef.current || attempt.current) return
    const token = ++epoch.current
    const controller = new AbortController()
    request.current = controller
    busyRef.current = true
    setHasReview(false)
    setChecked(false)
    setWarnings([])
    setStage('preparing')
    setFeedback({ kind: 'info', title: 'กำลังเตรียมภาพ…', message: 'ปรับขนาดภาพก่อนส่งอ่านข้อมูล ยังไม่มีการบันทึกสินค้า' })
    try {
      const blob = preparedImage.current ?? await prepareImageUpload(file, controller.signal)
      const hash = fingerprint.current ?? await imageFingerprint(blob)
      if (!isCurrent(token)) return
      preparedImage.current = blob
      fingerprint.current = hash
      setStage('extracting')
      setFeedback({ kind: 'info', title: 'กำลังอ่านข้อมูลจากภาพ…', message: 'ภาพส่งให้ Cloudflare AI อ่านข้อมูลเท่านั้น ยังไม่สร้าง SKU จนกว่าคุณจะตรวจสอบและยืนยัน' })
      const result = await requestImageExtraction(blob, (init) => apiFetch(apiOrigin, '/api/v1/products/extract-image', init), { signal: controller.signal })
      if (!isCurrent(token)) return
      busyRef.current = false
      if (result.status === 'success') {
        fingerprint.current = result.imageSha256
        setFields(fieldsFromImageDraft(result.draft))
        setWarnings(result.warnings)
        setHasReview(true)
        setStage('review')
        setFeedback({ kind: 'info', title: 'อ่านภาพแล้ว — โปรดตรวจสอบข้อมูล', message: 'AI อาจอ่านชื่อ ราคา หรือรหัสผิดได้ ยังไม่มีการสร้างสินค้า แก้ไขข้อมูลด้านล่างแล้วติ๊กยืนยันก่อนบันทึก' })
      } else if (result.status === 'error') {
        setAllowExtractionRetry(result.retryable)
        setStage('extract-error')
        setFeedback({ kind: 'error', title: 'ยังอ่านข้อมูลจากภาพไม่สำเร็จ', message: result.message, code: result.code })
      } else {
        setStage('idle')
        setFeedback({ kind: 'info', title: 'ยกเลิกการอ่านภาพแล้ว', message: 'ยังไม่มีการสร้างสินค้า' })
      }
    } catch (error) {
      if (!isCurrent(token)) return
      busyRef.current = false
      setStage('extract-error')
      setFeedback({ kind: 'error', title: 'ยังเตรียมภาพไม่สำเร็จ', message: error instanceof Error ? error.message : 'กรุณาเลือกภาพใหม่ ยังไม่มีการสร้างสินค้า' })
    } finally {
      if (isCurrent(token)) { busyRef.current = false; request.current = null }
    }
  }

  function beginManualReview() {
    if (!canImport || busyRef.current || !preparedImage.current || !fingerprint.current || attempt.current) return
    setFields(emptyImageFields())
    setWarnings([])
    setHasReview(true)
    setChecked(false)
    setStage('review')
    setFeedback({ kind: 'info', title: 'กรอกข้อมูลเองจากภาพ', message: 'ยังไม่ได้อ่านข้อมูลอัตโนมัติ กรุณาดูภาพและกรอกข้อมูลเองให้ถูกต้อง ยังไม่มีการสร้างสินค้าจนกว่าคุณจะยืนยัน' })
  }

  function editField(key: keyof ImageProductFields, value: string) {
    if (!canImport || busyRef.current || attempt.current) return
    setFields((previous) => ({ ...previous, [key]: value }))
    setChecked(false)
    setFeedback(null)
  }

  async function confirmProduct(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (!canImport || !accountId || busyRef.current || !hasReview) return
    if (!checked) {
      setFeedback({ kind: 'error', title: 'กรุณาตรวจสอบและยืนยันข้อมูลก่อน', message: 'ติ๊กยืนยันหลังตรวจชื่อ ราคา และรหัสสินค้าแล้ว จึงจะบันทึกเป็น SKU ได้' })
      return
    }
    try { attempt.current ??= createImageImportAttempt(fields, fingerprint.current) }
    catch (error) {
      setFeedback({ kind: 'error', title: 'ข้อมูลสินค้ายังไม่ครบหรือไม่ถูกต้อง', message: error instanceof Error ? error.message : 'กรุณาตรวจสอบข้อมูลอีกครั้ง' })
      return
    }
    const pending = attempt.current
    const token = ++epoch.current
    const controller = new AbortController()
    request.current = controller
    busyRef.current = true
    setStage('saving')
    setFeedback({ kind: 'info', title: 'กำลังบันทึกข้อมูลที่คุณยืนยัน…', message: 'ยังไม่ยืนยันผลสำเร็จจนกว่าจะได้รับ SKU กลับจากระบบ กรุณารอสักครู่' })
    let result
    try {
      result = await requestPersistedImageConfirmation(accountId, pending, (init) => apiFetch(apiOrigin, '/api/v1/products/import-image', init), { signal: controller.signal })
      setStorageBlocked(false)
    } catch {
      if (!isCurrent(token)) return
      busyRef.current = false
      request.current = null
      setStage('uncertain')
      setFeedback({ kind: 'uncertain', title: 'ยังส่งคำขอครั้งนี้ไม่ได้', message: 'เก็บรหัสรายการบนอุปกรณ์ไม่สำเร็จ จึงยังไม่ได้ส่งคำขอครั้งนี้ กรุณาตรวจสอบพื้นที่เก็บข้อมูลแล้วลองด้วยปุ่มเดิม อย่าส่งเป็นรายการใหม่หากเคยส่งไปแล้ว', code: 'IMAGE_PENDING_STORAGE_UNAVAILABLE' })
      return
    }
    if (!isCurrent(token)) return
    busyRef.current = false
    request.current = null
    if (result.status === 'success') {
      let cleared = false
      try { clearPendingImageAttempt(accountId, pending.payload.operationId); cleared = true; attempt.current = null } catch { /* D1 success remains authoritative. Keep UUID for cleanup/replay. */ }
      setStage('success')
      setSavedProduct(result.product)
      setFeedback({ kind: 'success', title: 'ยืนยันสินค้าเข้าฐานข้อมูลแล้ว', message: `ยังไม่ได้บันทึกรายการซื้อ กรอกราคาที่ซื้อจริงและจำนวน แล้วกด “บันทึกรายการซื้อ” ด้านล่าง${cleared ? '' : ' — ยังล้างสถานะรอยืนยันบนอุปกรณ์ไม่ได้ หากกลับมาเห็นรายการเดิม ให้ตรวจสอบด้วยรหัสเดิมได้อย่างปลอดภัย'}` })
      setFile(null)
      preparedImage.current = null
      fingerprint.current = null
      onProduct(result.product)
    } else if (result.status === 'uncertain' || result.status === 'cancelled') {
      setStage('uncertain')
      setFeedback({ kind: 'uncertain', title: 'ยังยืนยันผลการบันทึกไม่ได้', message: result.status === 'uncertain' ? result.message : 'สินค้าอาจถูกบันทึกแล้ว กรุณาตรวจสอบด้วยข้อมูลและรหัสรายการเดิม', code: result.status === 'uncertain' ? result.code : undefined })
    } else {
      try { clearPendingImageAttempt(accountId, pending.payload.operationId) }
      catch {
        setStage('uncertain')
        setFeedback({ kind: 'uncertain', title: 'ข้อมูลยังไม่ผ่านการตรวจสอบ', message: 'ระบบไม่รับข้อมูลนี้ และยังล้างสถานะบนอุปกรณ์ไม่ได้ กรุณาตรวจสอบด้วยปุ่มเดิมอีกครั้งก่อนแก้ไขข้อมูล', code: result.code })
        return
      }
      attempt.current = null
      setChecked(false)
      setStage('save-error')
      setFeedback({ kind: 'error', title: 'ยังบันทึกสินค้าไม่สำเร็จ', message: result.message, code: result.code })
    }
  }

  const busy = stage === 'preparing' || stage === 'extracting' || stage === 'saving'
  const locked = storageBlocked || Boolean(attempt.current) || stage === 'uncertain' || stage === 'saving' || stage === 'success'
  const canRead = canImport && Boolean(file) && !busy && !attempt.current && !hasReview
    && (stage !== 'extract-error' || allowExtractionRetry)

  return <section className="image-import" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>เพิ่มสินค้าจากภาพ</h3>
    <p className="image-import-notice">รองรับภาพหน้าสินค้าจาก Big C และแอป Makro Pro — แคปภาพให้เห็นชื่อ ขนาดบรรจุ และราคา แล้วเลือกภาพด้านล่าง</p>
    <p className="image-import-field-help">สินค้าขายเป็นแพ็ก: บันทึกราคาต่อแพ็กและขนาดให้ครบ เมื่อนำไปบันทึกรายการซื้อ จำนวน 1 หมายถึง 1 แพ็ก ไม่ใช่จำนวนชิ้นภายในแพ็ก</p>
    <p id={`${id}-privacy`} className="image-import-notice">ภาพจะส่งให้ Cloudflare AI อ่านข้อมูล SmartCart เก็บเฉพาะข้อมูลที่คุณยืนยัน ไม่บันทึกภาพต้นฉบับลงฐานข้อมูล กรุณาครอปข้อมูลส่วนตัวออกและให้เห็นสินค้าชัดเจน</p>
    <label htmlFor={`${id}-file`}>เลือกภาพหน้าจอหรือรูปสินค้า (JPG / PNG / WebP ไม่เกิน 10 MB)</label>
    <input ref={fileInput} id={`${id}-file`} type="file" accept="image/jpeg,image/png,image/webp" onChange={selectImage} disabled={!canImport || busy || locked} aria-describedby={`${id}-privacy`} />
    {!canImport ? <p className="status-message">เข้าสู่ระบบด้วย Google และเชื่อมต่ออินเทอร์เน็ตก่อนเพิ่มสินค้าจากภาพ</p> : null}
    {preview ? <figure className="image-import-preview"><img src={preview} alt="ภาพสินค้าที่เลือกเพื่ออ่านข้อมูล" /><figcaption>ภาพตัวอย่างบนอุปกรณ์ — ยังไม่ใช่สินค้าที่บันทึกแล้ว</figcaption></figure> : null}
    {!hasReview && file && !busy ? <div className="image-import-actions">
      <button type="button" className="primary-button" disabled={!canRead} onClick={() => void readImage()}>{stage === 'extract-error' ? 'ลองอ่านภาพอีกครั้ง' : 'อ่านข้อมูลจากภาพ'}</button>
      {stage === 'extract-error' && preparedImage.current ? <button type="button" className="secondary-button" onClick={beginManualReview} disabled={!canImport}>กรอกข้อมูลจากภาพเอง</button> : null}
      <button type="button" className="secondary-button" onClick={() => resetImage()} disabled={!canImport}>ล้างภาพ / เลือกใหม่</button>
    </div> : null}
    {feedback ? <div ref={feedbackRef} className={`import-feedback image-import-feedback import-feedback-${feedback.kind === 'info' ? 'loading' : feedback.kind}`} role={feedback.kind === 'error' || feedback.kind === 'uncertain' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' || feedback.kind === 'uncertain' ? 'assertive' : 'polite'} aria-atomic="true" aria-labelledby={`${id}-feedback-title`} tabIndex={-1}>
      <span className={`import-status-icon${busy ? ' import-spinner' : ''}`} aria-hidden="true">{busy ? null : feedback.kind === 'success' ? '✓' : feedback.kind === 'info' ? 'i' : '!'}</span>
      <div className="import-content"><h3 id={`${id}-feedback-title`}>{feedback.title}</h3><p>{feedback.message}</p>
        {feedback.code ? <p className="import-error-code">รหัสการตรวจสอบ: <code>{feedback.code}</code></p> : null}
        {savedProduct ? <div className="import-product-details"><strong>{savedProduct.name}</strong><span>SKU: <strong>{savedProduct.sku}</strong></span></div> : null}
        {busy ? <button type="button" className="import-action" onClick={stopWaiting} disabled={!canImport}>{stage === 'saving' ? 'หยุดรอผล' : 'ยกเลิกการอ่านภาพ'}</button> : null}
        {stage === 'uncertain' ? <button type="button" className="import-action import-retry" onClick={() => void confirmProduct()} disabled={!canImport || busy}>ตรวจสอบด้วยข้อมูลและรหัสรายการเดิม</button> : null}
        {storageBlocked && !hasReview ? <button type="button" className="import-action" onClick={restorePending}>ตรวจสอบรายการที่ค้างอยู่อีกครั้ง</button> : null}
      </div>
    </div> : null}
    {hasReview ? <form className="image-import-review" onSubmit={(event) => void confirmProduct(event)}>
      <fieldset disabled={!canImport || busy || locked}>
        <legend>ตรวจสอบและแก้ไขข้อมูลก่อนยืนยัน</legend>
        {warnings.length > 0 ? <ul className="image-import-warnings" aria-label="ข้อควรตรวจสอบจากการอ่านภาพ">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
        <label>ชื่อสินค้า<input value={fields.name} onChange={(event) => editField('name', event.target.value)} maxLength={200} required /></label>
        <label>แบรนด์ (ไม่บังคับ)<input value={fields.brand} onChange={(event) => editField('brand', event.target.value)} maxLength={100} /></label>
        <label>ขนาดบรรจุ / จำนวนชิ้นต่อแพ็ก (ไม่บังคับ)<input value={fields.packageSize} onChange={(event) => editField('packageSize', event.target.value)} maxLength={100} placeholder="เช่น 24.6 g x 12" /></label>
        <label>ราคาอ้างอิงจากภาพ (บาท)<input value={fields.sourcePrice} onChange={(event) => editField('sourcePrice', event.target.value)} inputMode="decimal" placeholder="เว้นว่างหากไม่มีราคา" /></label>
        <p className="image-import-field-help">ใช้ราคาต่อหน่วยขาย เช่น แพ็ก 12 ชิ้น ราคา 45 บาท ให้ใส่ 45 ไม่ใช่ราคาต่อชิ้น 3.75 หรือราคาขีดฆ่า ราคาในภาพไม่ใช่การรับประกันราคาปัจจุบัน และยังไม่ใช่ราคาของรายการซื้อ</p>
        <label>UPC / EAN บาร์โค้ด (ไม่บังคับ)<input value={fields.upc} onChange={(event) => editField('upc', event.target.value)} inputMode="numeric" maxLength={14} placeholder="ใส่เมื่อเห็นบาร์โค้ดชัดเจนเท่านั้น" /></label>
        <BarcodeScanner disabled={!canImport || busy || locked} onDetected={(value) => editField('upc', value)} />
        <p className="image-import-field-help">หากภาพไม่มีบาร์โค้ด ให้เว้นว่าง ห้ามใช้รหัสสินค้า Big C หรือ Code ของ Makro Pro แทนบาร์โค้ด</p>
        <label>รหัสสินค้าร้าน / Code ที่แสดงบนภาพ (ไม่บังคับ)<input value={fields.retailerCode} onChange={(event) => editField('retailerCode', event.target.value)} maxLength={80} placeholder="เช่น 60560 หรือ 197584" /></label>
        <p className="image-import-field-help">เก็บไว้เป็นข้อมูลอ้างอิงของรายการนำเข้าเท่านั้น ไม่ใช่ UPC และไม่ใช้ยืนยันตัวสินค้าระหว่างร้าน</p>
        <label className="image-import-confirmation"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} required /><span>ฉันตรวจสอบชื่อ ราคา และรหัสแล้ว ยืนยันบันทึกข้อมูลนี้เป็นสินค้า</span></label>
      </fieldset>
      {!locked ? <div className="image-import-actions"><button type="submit" className="primary-button" disabled={!canImport || busy || !checked}>ยืนยันและบันทึกสินค้าเป็น SKU</button><button type="button" className="secondary-button" onClick={() => resetImage()} disabled={!canImport || busy}>ยกเลิก / เลือกภาพใหม่</button></div> : null}
    </form> : null}
    {stage === 'success' ? <button type="button" className="secondary-button" onClick={() => resetImage()} disabled={!canImport}>เพิ่มสินค้าจากภาพใหม่</button> : null}
  </section>
}

export default ImageImport

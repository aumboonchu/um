import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { constrainCropBounds, cropProductImage, defaultCropBounds, validCropBounds, type CropBounds, type CroppedProductImage } from './product-image-crop'

export function ProductImageCropper({ source, onConfirm, onCancel, disabled = false, initialBounds }: {
  source: Blob; onConfirm: (image: CroppedProductImage) => void; onCancel: () => void; disabled?: boolean; initialBounds?: CropBounds | null;
}) {
  const [url, setUrl] = useState(''), [bounds, setBounds] = useState<CropBounds>(() => validCropBounds(initialBounds) ? constrainCropBounds(initialBounds) : defaultCropBounds(1, 2))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false)
  const surface = useRef<HTMLDivElement>(null), request = useRef<AbortController | null>(null), mounted = useRef(true), inFlight = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number; box: CropBounds; mode: 'move' | 'resize'; width: number; height: number } | null>(null)
  useEffect(() => {
    mounted.current = true; setReady(false); setError('')
    if (validCropBounds(initialBounds)) setBounds(constrainCropBounds(initialBounds))
    const next = URL.createObjectURL(source); setUrl(next)
    return () => { mounted.current = false; request.current?.abort(); URL.revokeObjectURL(next); drag.current = null }
  }, [source])
  useEffect(() => { if (disabled) { request.current?.abort(); drag.current = null } }, [disabled])
  function start(event: PointerEvent<HTMLDivElement | HTMLButtonElement>, mode: 'move' | 'resize') {
    if (disabled || busy || !ready || event.button !== 0) return
    const rect = surface.current?.getBoundingClientRect(); if (!rect?.width || !rect.height) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, box: bounds, mode, width: rect.width, height: rect.height }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || event.pointerId !== current.id || disabled || busy) return
    event.preventDefault()
    const dx = (event.clientX - current.x) / current.width, dy = (event.clientY - current.y) / current.height
    setBounds(constrainCropBounds(current.mode === 'move' ? { ...current.box, x: current.box.x + dx, y: current.box.y + dy }
      : { ...current.box, width: Math.min(1 - current.box.x, current.box.width + dx), height: Math.min(1 - current.box.y, current.box.height + dy) }))
  }
  async function confirm() {
    if (disabled || inFlight.current || !ready) return
    inFlight.current = true; setBusy(true); setError('')
    const controller = new AbortController(); request.current = controller
    try {
      const image = await cropProductImage(source, bounds, controller.signal)
      if (mounted.current && !controller.signal.aborted) onConfirm(image)
    } catch (e) { if (mounted.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'ครอปรูปไม่สำเร็จ') }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="crop-editor" aria-label="ครอปรูปสินค้า">
    <div className="crop-heading"><strong>เลือกเฉพาะรูปสินค้า</strong><span>ลากกรอบ · ดึงมุมปรับขนาด</span></div>
    <div className="crop-surface" ref={surface} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      {url ? <img className="crop-source" src={url} alt="ภาพต้นฉบับสำหรับเลือกกรอบสินค้า" draggable={false} onLoad={event => {
        const image = event.currentTarget
        if (!validCropBounds(initialBounds)) setBounds(defaultCropBounds(image.naturalWidth, image.naturalHeight))
        setReady(Boolean(image.naturalWidth && image.naturalHeight))
      }} onError={() => { setReady(false); setError('อ่านรูปไม่ได้ กรุณาเลือกรูปใหม่') }} /> : null}
      <div className="crop-selection" style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }} onPointerDown={event => start(event, 'move')}>
        <span className="crop-grid" aria-hidden="true" />
        <button type="button" className="crop-handle" aria-label="ปรับขนาดกรอบรูป" disabled={disabled || busy} onPointerDown={event => start(event, 'resize')} />
      </div>
    </div>
    <details className="crop-controls"><summary>ปรับกรอบละเอียด</summary><div>{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['ซ้าย', 'บน', 'ความกว้าง', 'ความสูง'][index]}<input type="range" aria-label={['กรอบด้านซ้าย', 'กรอบด้านบน', 'ความกว้างกรอบ', 'ความสูงกรอบ'][index]} min={key === 'x' || key === 'y' ? 0 : 3} max={100} step={1} value={Math.round(bounds[key] * 100)} disabled={disabled || busy} onChange={event => setBounds(current => constrainCropBounds({ ...current, [key]: Number(event.target.value) / 100 }))} /></label>)}</div></details>
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    <div className="crop-actions"><button type="button" className="primary-button" onClick={() => void confirm()} disabled={disabled || busy || !ready}>{busy ? 'กำลังครอป…' : 'ใช้รูปที่ครอป'}</button><button type="button" className="text-button" disabled={busy} onClick={onCancel}>ยกเลิกครอป</button></div>
  </section>
}

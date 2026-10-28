import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { startCameraScan } from './barcode-scanner'
import { Icon } from './ui'

export type BarcodeScannerProps = { disabled?: boolean; onDetected: (value: string) => void; presentation?: 'inline' | 'journey'; compact?: boolean; inputOnly?: boolean; roundCount?: number; onManual?: () => void }

export default function BarcodeScanner({ disabled = false, onDetected, presentation = 'inline', compact = false, inputOnly = false, roundCount = 0, onManual }: BarcodeScannerProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false), [torchSupported, setTorchSupported] = useState(false), [torchOn, setTorchOn] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(false)
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected

  function close(message: string) {
    restoreFocus.current = true
    setOpen(false)
    setFailed(false)
    setMessage(message)
    setReady(false); setTorchOn(false); setTorchSupported(false)
  }

  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false
      trigger.current?.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (disabled) { setOpen(false); setMessage(''); setFailed(false) }
  }, [disabled])

  useEffect(() => {
    if (!open || presentation !== 'journey') return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open, presentation])

  useEffect(() => {
    if (!open || disabled || !video.current) return
    let active = true
    panel.current?.focus({ preventScroll: true })
    panel.current?.scrollIntoView({ block: 'nearest' })
    const scan = startCameraScan(video.current, {
      onReady: () => { if (active) {
        setReady(true); setMessage(presentation === 'journey' ? '' : 'วางบาร์โค้ดในกรอบ')
        try { const track = (video.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]; setTorchSupported(Boolean((track?.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean })?.torch)) } catch { setTorchSupported(false) }
      } },
      onResult: (value) => {
        if (!active) return
        onDetectedRef.current(value)
        close(presentation === 'journey' ? '' : `สแกนได้ ${value} · ยังไม่ได้บันทึกสินค้า`)
      },
      onError: (message) => {
        if (!active) return
        restoreFocus.current = true
        setOpen(false)
        setFailed(true)
        setMessage(message)
      },
    })
    const hide = () => { if (document.hidden) { scan.stop(); close('ปิดกล้องเมื่อออกจากหน้านี้แล้ว') } }
    const leave = () => { scan.stop(); close('ปิดกล้องแล้ว') }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => { active = false; scan.stop(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave) }
  }, [open, disabled, presentation])

  function begin() {
    if (disabled || open) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setFailed(true)
      setMessage('เบราว์เซอร์นี้ยังเปิดกล้องไม่ได้ กรุณาเปิด SmartCart ผ่าน HTTPS ใน Safari หรือ Chrome หรือพิมพ์รหัสเอง')
      return
    }
    // Do not keep the numeric keyboard open over the camera on mobile.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setFailed(false)
    setReady(false); setTorchOn(false); setTorchSupported(false)
    setMessage('กำลังเปิดกล้อง… หากมีคำถามขอใช้กล้อง กรุณาเลือกอนุญาต')
    setOpen(true)
  }

  async function toggleTorch() {
    if (!ready || !torchSupported) return
    try {
      const track = (video.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]
      if (!track) return
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet & { torch: boolean }] })
      setTorchOn(value => !value)
    } catch { setMessage('เปิดแฟลชไม่ได้ ลองเพิ่มแสงรอบสินค้า') }
  }
  const camera = open ? <div ref={panel} id={`${id}-camera`} className={presentation === 'journey' ? 'scanner-overlay' : 'barcode-camera'} role={presentation === 'journey' ? 'dialog' : 'region'} aria-modal={presentation === 'journey' ? true : undefined} aria-label="กล้องสแกนบาร์โค้ด" tabIndex={-1} onKeyDown={event => {
    if (event.key === 'Escape') close('ปิดกล้องแล้ว')
    if (event.key === 'Tab' && presentation === 'journey') {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    {presentation === 'journey' ? <header className="scanner-header"><button type="button" className="icon-button" aria-label="ปิดกล้อง" onClick={() => close('')}><Icon name="backWhite" /></button><h2>สแกนสินค้า</h2></header> : null}
    <p className="scanner-instruction">วางบาร์โค้ดในกรอบ</p>
    <div className="barcode-camera-preview"><video ref={video} autoPlay muted playsInline aria-label="ภาพตัวอย่างกล้องสำหรับสแกน UPC / EAN" />{ready ? <div className="barcode-camera-guide" aria-hidden="true" /> : presentation === 'journey' ? <div className="scan-loading-art"><Icon name="scanExample" /></div> : null}</div>
    {presentation === 'journey' ? <div className="scanner-tools"><button type="button" className="icon-button" aria-label={torchOn ? 'ปิดแฟลช' : 'เปิดแฟลช'} aria-pressed={torchOn} disabled={!ready || !torchSupported} title={torchSupported ? undefined : 'กล้องนี้ไม่รองรับแฟลช'} onClick={() => void toggleTorch()}><Icon name="flash" /></button><span className="status-chip"><Icon name="basketSmall" />รอบนี้ {roundCount} รายการ</span></div> : null}
    {message ? <p role="status" className="scanner-message">{message}</p> : null}
    {presentation === 'journey' && onManual ? <button type="button" className="secondary-button" onClick={() => { close(''); onManual() }}><Icon name="barcode" />พิมพ์บาร์โค้ด</button> : <button type="button" className="secondary-button" onClick={() => close('ปิดกล้องแล้ว')}>ยกเลิก / ปิดกล้อง</button>}
  </div> : null
  return <div className={`barcode-scanner${presentation === 'journey' ? ' journey-scanner' : ''}`}>
    <button ref={trigger} type="button" className={presentation === 'journey' ? compact ? 'scan-more' : inputOnly ? 'secondary-button barcode-scan-button' : 'primary-button barcode-scan-button' : 'secondary-button barcode-scan-button'} onClick={begin} disabled={disabled || open} aria-expanded={open} aria-controls={`${id}-camera`}>
      <Icon name={presentation === 'journey' ? compact ? 'plusGreen' : inputOnly ? 'barcode' : 'scanWhite' : 'barcode'} />
      {presentation === 'journey' ? compact ? 'สแกนเพิ่ม' : inputOnly ? 'สแกนบาร์โค้ด' : 'สแกนสินค้า' : 'สแกนบาร์โค้ดด้วยกล้อง'}
    </button>
    {presentation === 'journey' && camera ? createPortal(camera, document.body) : camera}
    {!open && message ? <p className={`barcode-scan-status${failed ? ' barcode-scan-error' : ''}`} role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>{message}</p> : null}
  </div>
}

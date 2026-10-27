import { useEffect, useId, useRef, useState } from 'react'
import { startCameraScan } from './barcode-scanner'

export type BarcodeScannerProps = { disabled?: boolean; onDetected: (value: string) => void }

export default function BarcodeScanner({ disabled = false, onDetected }: BarcodeScannerProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
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
    if (!open || disabled || !video.current) return
    let active = true
    panel.current?.focus({ preventScroll: true })
    panel.current?.scrollIntoView({ block: 'nearest' })
    const scan = startCameraScan(video.current, {
      onReady: () => { if (active) setMessage('เล็งให้เห็นเส้นบาร์โค้ดครบทั้งสองข้าง ถือกล้องให้นิ่งจนอ่านรหัสได้') },
      onResult: (value) => {
        if (!active) return
        onDetectedRef.current(value)
        close(`สแกนได้ ${value} และเติมช่อง UPC / EAN แล้ว กรุณาตรวจรหัสก่อนยืนยัน ยังไม่มีการบันทึกสินค้า`)
      },
      onError: (message) => {
        if (!active) return
        restoreFocus.current = true
        setOpen(false)
        setFailed(true)
        setMessage(message)
      },
    })
    const hide = () => { if (document.hidden) { scan.stop(); close('หยุดสแกนและปิดกล้องแล้ว เนื่องจากสลับออกจากหน้านี้ กดสแกนอีกครั้งได้') } }
    const leave = () => { scan.stop(); close('ปิดกล้องแล้ว กดสแกนอีกครั้งเมื่อต้องการ') }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', leave)
    return () => { active = false; scan.stop(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', leave) }
  }, [open, disabled])

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
    setMessage('กำลังเปิดกล้อง… หากมีคำถามขอใช้กล้อง กรุณาเลือกอนุญาต')
    setOpen(true)
  }

  return <div className="barcode-scanner">
    <button ref={trigger} type="button" className="secondary-button barcode-scan-button" onClick={begin} disabled={disabled || open} aria-expanded={open} aria-controls={`${id}-camera`}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 8V4h4m10 0h4v4M3 16v4h4m10 0h4v-4M7 8v8m3-8v8m4-8v8m3-8v8" /></svg>
      สแกนบาร์โค้ดด้วยกล้อง
    </button>
    {open ? <div ref={panel} id={`${id}-camera`} className="barcode-camera" role="region" aria-label="กล้องสแกนบาร์โค้ด" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') close('ยกเลิกและปิดกล้องแล้ว ช่อง UPC เดิมไม่เปลี่ยนแปลง') }}>
      <div className="barcode-camera-preview"><video ref={video} autoPlay muted playsInline aria-label="ภาพตัวอย่างกล้องสำหรับสแกน UPC / EAN" /><div className="barcode-camera-guide" aria-hidden="true" /></div>
      <p>รองรับ EAN-13, EAN-8 และ UPC-A อ่านบนอุปกรณ์นี้ ไม่ส่งภาพกล้องไปเซิร์ฟเวอร์</p>
      <button type="button" className="secondary-button" onClick={() => close('ยกเลิกและปิดกล้องแล้ว ช่อง UPC เดิมไม่เปลี่ยนแปลง')}>ยกเลิก / ปิดกล้อง</button>
    </div> : null}
    {message ? <p className={`barcode-scan-status${failed ? ' barcode-scan-error' : ''}`} role={failed ? 'alert' : 'status'} aria-live={failed ? 'assertive' : 'polite'}>{message}</p> : null}
  </div>
}

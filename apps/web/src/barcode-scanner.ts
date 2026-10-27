export type BarcodeReading = { text: string; format: string }
type ScanControls = { stop: () => void }
type Decode = (stream: MediaStream, video: HTMLVideoElement, onReading: (reading: BarcodeReading) => void) => Promise<ScanControls>
export type CameraScanDependencies = {
  getStream: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  loadDecoder: () => Promise<Decode>
  timeoutMs?: number
}
type ScanCallbacks = {
  onReady: () => void
  onResult: (value: string) => void
  onError: (message: string) => void
}

/** Preserve leading zeroes. Do not accept QR text, retailer IDs, or unchecked digits. */
export function scannedGtin({ text, format }: BarcodeReading): string | null {
  const length = { EAN_13: 13, EAN_8: 8, UPC_A: 12 }[format]
  if (!length || !new RegExp(`^\\d{${length}}$`).test(text) || /^(\d)\1+$/.test(text)) return null
  const digits = [...text].map(Number)
  const check = digits.pop()!
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0)
  return (10 - sum % 10) % 10 === check ? text : null
}

export function cameraErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'ยังไม่ได้รับอนุญาตใช้กล้อง กรุณาอนุญาตกล้องสำหรับเว็บนี้ใน Safari หรือเบราว์เซอร์ แล้วลองใหม่ หรือพิมพ์รหัสเองได้'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'ไม่พบกล้องที่ใช้งานได้ กรุณาลองบนอุปกรณ์ที่มีกล้อง หรือพิมพ์รหัสเอง'
  if (name === 'NotReadableError' || name === 'AbortError') return 'เปิดกล้องไม่ได้ กล้องอาจกำลังถูกใช้งานโดยแอปอื่น กรุณาปิดแอปนั้นแล้วลองใหม่ หรือพิมพ์รหัสเอง'
  return 'เริ่มสแกนไม่ได้ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่ หากเปิดผ่านแอปอื่นให้ลองเปิดใน Safari หรือ Chrome หรือพิมพ์รหัสเอง'
}

export async function loadBarcodeDecoder(): Promise<Decode> {
  // Lazy-load on user request; all video processing remains in this browser.
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'), import('@zxing/library'),
  ])
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A]]])
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 250, delayBetweenScanSuccess: 250, tryPlayVideoTimeout: 8_000 })
  return (stream, video, onReading) => {
    // We own track cleanup. Avoid the library's optional/experimental torch controls.
    video.srcObject = stream
    return reader.decodeFromVideoElement(video, (result) => {
      if (result) onReading({ text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] })
    })
  }
}

/** Own our stream even while decoder startup / a permission prompt is pending. */
export function startCameraScan(video: HTMLVideoElement, callbacks: ScanCallbacks, dependencies?: CameraScanDependencies): ScanControls {
  let stopped = false
  let stream: MediaStream | null = null
  let controls: ScanControls | null = null
  let previous: string | null = null
  let matches = 0
  const deps = dependencies ?? { getStream: (constraints) => navigator.mediaDevices.getUserMedia(constraints), loadDecoder: loadBarcodeDecoder }
  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    try { controls?.stop() } catch { /* Always release our own camera tracks too. */ }
    stream?.getTracks().forEach((track) => track.stop())
    video.srcObject = null
  }
  const timer = setTimeout(() => {
    if (stopped) return
    stop()
    callbacks.onError('ยังอ่านบาร์โค้ดไม่ได้ภายใน 60 วินาที กล้องปิดแล้ว ลองให้เห็นเส้นบาร์โค้ดครบและมีแสงเพียงพอ แล้วสแกนใหม่ หรือพิมพ์รหัสเอง')
  }, deps.timeoutMs ?? 60_000)
  void (async () => {
    try {
      const decode = await deps.loadDecoder()
      if (stopped) return
      const acquired = await deps.getStream({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      if (stopped) { acquired.getTracks().forEach((track) => track.stop()); return }
      stream = acquired
      const decoderControls = await decode(stream, video, (reading) => {
        if (stopped) return
        const value = scannedGtin(reading)
        if (!value) { previous = null; matches = 0; return }
        matches = value === previous ? matches + 1 : 1
        previous = value
        if (matches < 2) return
        stop()
        callbacks.onResult(value)
      })
      controls = decoderControls
      if (stopped) { decoderControls.stop(); return }
      callbacks.onReady()
    } catch (error) {
      if (stopped) return
      stop()
      callbacks.onError(cameraErrorMessage(error))
    }
  })()
  return { stop }
}

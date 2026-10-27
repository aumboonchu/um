import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from '@zxing/library'
import BarcodeScanner from '../src/BarcodeScanner'
import { cameraErrorMessage, scannedGtin, startCameraScan, type BarcodeReading } from '../src/barcode-scanner'

const ean = { text: '8851959129012', format: 'EAN_13' }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('scanned UPC / EAN input', () => {
  it.each([ean, { text: '96385074', format: 'EAN_8' }, { text: '036000291452', format: 'UPC_A' }])('accepts checksum-valid $format and preserves zeroes', (value) => {
    expect(scannedGtin(value)).toBe(value.text)
  })
  it.each([
    { ...ean, text: '8851959129013' }, { ...ean, text: '60560' }, { ...ean, text: ' 8851959129012' },
    { ...ean, text: '0000000000000' }, { ...ean, text: 'https://example.com' },
    { ...ean, format: 'QR_CODE' }, { ...ean, format: 'CODE_128' }, { ...ean, format: 'EAN_8' },
  ])('ignores non-product or invalid scan %#', (value) => { expect(scannedGtin(value)).toBeNull() })

  it('decodes an actual generated EAN-13 pixel fixture with the bundled ZXing reader', () => {
    const left = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
    const even = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
    const right = left.map((bits) => [...bits].map((bit) => bit === '1' ? '0' : '1').join(''))
    // Leading 8 specifies LGLGGL parity. Quiet zones are included on both sides.
    const first = [...ean.text.slice(1, 7)].map((digit, index) => ('LGLGGL'[index] === 'L' ? left : even)[Number(digit)]).join('')
    const bits = `000000000000101${first}01010${[...ean.text.slice(7)].map((digit) => right[Number(digit)]).join('')}101000000000000`
    const width = bits.length * 3, height = 120
    const pixels = new Uint8ClampedArray(width * height).fill(255)
    for (let y = 10; y < height - 10; y++) for (let x = 0; x < width; x++) if (bits[Math.floor(x / 3)] === '1') pixels[y * width + x] = 0
    const reader = new MultiFormatReader()
    const result = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height))), new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]]]))
    expect(scannedGtin({ text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] })).toBe(ean.text)
  })
})

function fixture() {
  const stopTrack = vi.fn()
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
  const video = { srcObject: stream } as unknown as HTMLVideoElement
  const stopDecode = vi.fn()
  let emit!: (reading: BarcodeReading) => void
  const decode = vi.fn(async (_stream, _video, onReading: (reading: BarcodeReading) => void) => { emit = onReading; return { stop: stopDecode } })
  const getStream = vi.fn(async () => stream)
  const loadDecoder = vi.fn(async () => decode)
  const callbacks = { onReady: vi.fn(), onResult: vi.fn(), onError: vi.fn() }
  return { stream, video, stopTrack, stopDecode, decode, getStream, loadDecoder, callbacks, emit: (reading: BarcodeReading) => emit(reading) }
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve() }

describe('camera stream lifecycle', () => {
  it('requests only rear-camera video, fills after two matching checks and stops immediately', async () => {
    const f = fixture()
    const scan = startCameraScan(f.video, f.callbacks, f)
    await settle()
    expect(f.getStream).toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
    expect(f.callbacks.onReady).toHaveBeenCalledTimes(1)
    f.emit(ean)
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
    f.emit(ean)
    expect(f.callbacks.onResult).toHaveBeenCalledExactlyOnceWith(ean.text)
    expect(f.stopTrack).toHaveBeenCalledTimes(1)
    expect(f.stopDecode).toHaveBeenCalledTimes(1)
    expect(f.video.srcObject).toBeNull()
    f.emit(ean); scan.stop()
    expect(f.callbacks.onResult).toHaveBeenCalledTimes(1)
  })

  it('does not accept mismatched or invalid intermediate readings', async () => {
    const f = fixture(); const scan = startCameraScan(f.video, f.callbacks, f); await settle()
    f.emit(ean); f.emit({ text: '96385074', format: 'EAN_8' }); f.emit(ean)
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
    f.emit({ ...ean, text: '60560' }); f.emit(ean)
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
    f.emit(ean)
    expect(f.callbacks.onResult).toHaveBeenCalledExactlyOnceWith(ean.text)
    scan.stop()
  })

  it('cancelled startup does not even request a camera after a late library download', async () => {
    const f = fixture(); let ready!: (decode: typeof f.decode) => void
    const loadDecoder = () => new Promise<typeof f.decode>((resolve) => { ready = resolve })
    const scan = startCameraScan(f.video, f.callbacks, { ...f, loadDecoder })
    scan.stop(); ready(f.decode); await settle()
    expect(f.getStream).not.toHaveBeenCalled()
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
  })

  it('releases a late permission grant after cancel, without starting the decoder', async () => {
    const f = fixture(); let ready!: (stream: MediaStream) => void
    const getStream = () => new Promise<MediaStream>((resolve) => { ready = resolve })
    const scan = startCameraScan(f.video, f.callbacks, { ...f, getStream }); await settle()
    scan.stop(); ready(f.stream); await settle()
    expect(f.stopTrack).toHaveBeenCalledTimes(1)
    expect(f.decode).not.toHaveBeenCalled()
    expect(f.callbacks.onReady).not.toHaveBeenCalled()
  })

  it('stops tracks even while decoder startup is pending and stops late decoder controls', async () => {
    const f = fixture(); let ready!: (controls: { stop: () => void }) => void
    const decode = () => new Promise<{ stop: () => void }>((resolve) => { ready = resolve })
    const scan = startCameraScan(f.video, f.callbacks, { ...f, loadDecoder: async () => decode }); await settle()
    scan.stop(); expect(f.stopTrack).toHaveBeenCalledTimes(1)
    ready({ stop: f.stopDecode }); await settle()
    expect(f.stopDecode).toHaveBeenCalledTimes(1)
    expect(f.callbacks.onReady).not.toHaveBeenCalled()
  })

  it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError'])('explains camera failure %s without changing input', async (name) => {
    const f = fixture(); const getStream = async () => { throw { name } }
    startCameraScan(f.video, f.callbacks, { ...f, getStream }); await settle()
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(cameraErrorMessage({ name }))
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
    expect(f.callbacks.onReady).not.toHaveBeenCalled()
  })

  it('cleans up tracks when video/decoder startup throws', async () => {
    const f = fixture()
    startCameraScan(f.video, f.callbacks, { ...f, loadDecoder: async () => async () => { throw new Error('video blocked') } }); await settle()
    expect(f.stopTrack).toHaveBeenCalledTimes(1)
    expect(f.callbacks.onError).toHaveBeenCalledTimes(1)
  })

  it('times out and ignores late results without creating or looking up a product', async () => {
    vi.useFakeTimers(); const f = fixture()
    startCameraScan(f.video, f.callbacks, f); await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('60 วินาที'))
    expect(f.stopTrack).toHaveBeenCalledTimes(1)
    f.emit(ean); f.emit(ean)
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
  })

  it('can cancel repeatedly without duplicate cleanup or callbacks', async () => {
    const f = fixture(); const scan = startCameraScan(f.video, f.callbacks, f); await settle()
    scan.stop(); scan.stop(); f.emit(ean); f.emit(ean)
    expect(f.stopTrack).toHaveBeenCalledTimes(1)
    expect(f.callbacks.onResult).not.toHaveBeenCalled()
    expect(f.callbacks.onError).not.toHaveBeenCalled()
  })
})

describe('scanner button', () => {
  it('is opt-in, not a submit button, and does not open a camera on render', () => {
    const onDetected = vi.fn()
    const html = renderToStaticMarkup(createElement(BarcodeScanner, { onDetected }))
    expect(html).toContain('สแกนบาร์โค้ดด้วยกล้อง')
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('<video')
    expect(onDetected).not.toHaveBeenCalled()
  })
  it('locks scanning when the parent form is locked or saving', () => {
    expect(renderToStaticMarkup(createElement(BarcodeScanner, { disabled: true, onDetected: vi.fn() }))).toContain('disabled=""')
  })
})

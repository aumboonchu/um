export type CropBounds = { x: number; y: number; width: number; height: number }
export type CroppedProductImage = Readonly<{ data: string; sha256: string; width: number; height: number }>
export const MAX_PRODUCT_IMAGE_BYTES = 128 * 1024
export const MAX_PRODUCT_IMAGE_EDGE = 640
const MAX_ENCODED_BYTES = Math.ceil(MAX_PRODUCT_IMAGE_BYTES / 3) * 4

export function validCropBounds(value: unknown): value is CropBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const box = value as Record<string, unknown>
  return Object.keys(box).length === 4 && ['x', 'y', 'width', 'height'].every(k => typeof box[k] === 'number' && Number.isFinite(box[k]))
    && Number(box.x) >= 0 && Number(box.y) >= 0 && Number(box.width) > 0 && Number(box.height) > 0
    && Number(box.x) + Number(box.width) <= 1.000001 && Number(box.y) + Number(box.height) <= 1.000001
}
export function defaultCropBounds(width: number, height: number): CropBounds {
  // A phone screenshot includes navigation above and price/text below the product.
  return height / width > 1.5 ? { x: .12, y: .16, width: .76, height: .36 } : { x: .08, y: .08, width: .84, height: .84 }
}
export function constrainCropBounds(bounds: CropBounds): CropBounds {
  const finite = (n: number, fallback: number) => Number.isFinite(n) ? n : fallback
  const width = Math.min(1, Math.max(.03, finite(bounds.width, .5))), height = Math.min(1, Math.max(.03, finite(bounds.height, .5)))
  return { x: Math.min(1 - width, Math.max(0, finite(bounds.x, 0))), y: Math.min(1 - height, Math.max(0, finite(bounds.y, 0))), width, height }
}
export function isCroppedProductImage(value: unknown): value is CroppedProductImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const image = value as Record<string, unknown>
  return Object.keys(image).length === 4 && typeof image.data === 'string' && image.data.length > 0 && image.data.length <= MAX_ENCODED_BYTES
    && image.data.length % 4 === 0 && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    && image.data.length * 3 / 4 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0) <= MAX_PRODUCT_IMAGE_BYTES
    && typeof image.sha256 === 'string' && /^[0-9a-f]{64}$/.test(image.sha256)
    && ['width', 'height'].every(k => Number.isSafeInteger(image[k]) && Number(image[k]) >= 16 && Number(image[k]) <= MAX_PRODUCT_IMAGE_EDGE)
}
export const cropPreviewUrl = (image: CroppedProductImage) => `data:image/jpeg;base64,${image.data}`
function check(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Crop cancelled', 'AbortError') }
async function decode(source: Blob, signal?: AbortSignal): Promise<{ image: CanvasImageSource; width: number; height: number; close: () => void }> {
  check(signal)
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(source.type) || !source.size || source.size > 10 * 1024 * 1024) throw new Error('กรุณาเลือกรูป JPG, PNG หรือ WebP ไม่เกิน 10 MB')
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(source)
    if (signal?.aborted) { bitmap.close(); check(signal) }
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  const url = URL.createObjectURL(source), image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(new DOMException('Crop cancelled', 'AbortError')) }
      image.onload = () => { cleanup(); resolve() }
      image.onerror = () => { cleanup(); reject(new Error('อ่านรูปไม่ได้ กรุณาเลือกรูปใหม่')) }
      signal?.addEventListener('abort', abort, { once: true }); image.src = url
    })
    check(signal)
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (error) { URL.revokeObjectURL(url); throw error }
}
export async function cropProductImage(source: Blob, bounds: CropBounds, signal?: AbortSignal): Promise<CroppedProductImage> {
  check(signal)
  if (!validCropBounds(bounds)) throw new Error('กรอบรูปไม่ถูกต้อง กรุณาเลือกเฉพาะสินค้า')
  const decoded = await decode(source, signal)
  try {
    check(signal)
    const sx = Math.round(bounds.x * decoded.width), sy = Math.round(bounds.y * decoded.height)
    const sw = Math.min(decoded.width - sx, Math.round(bounds.width * decoded.width)), sh = Math.min(decoded.height - sy, Math.round(bounds.height * decoded.height))
    if (sw < 16 || sh < 16 || !decoded.width || !decoded.height) throw new Error('กรอบเล็กเกินไป กรุณาขยายให้เห็นสินค้า')
    let scale = Math.min(1, MAX_PRODUCT_IMAGE_EDGE / Math.max(sw, sh))
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    if (!context) throw new Error('เบราว์เซอร์นี้ครอปรูปไม่ได้ กรุณาลอง Chrome หรือ Safari เวอร์ชันใหม่')
    let blob: Blob | null = null
    // JPEG re-encoding copies only selected pixels; screenshot metadata is not retained.
    for (const quality of [.88, .76, .62, .48]) {
      check(signal)
      const width = Math.round(sw * scale), height = Math.round(sh * scale)
      if (width < 16 || height < 16) throw new Error('กรอบแคบเกินไป กรุณาขยายกรอบให้เห็นสินค้า')
      canvas.width = width; canvas.height = height
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(decoded.image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
      blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      check(signal)
      if (blob && blob.type === 'image/jpeg' && blob.size > 0 && blob.size <= MAX_PRODUCT_IMAGE_BYTES) break
      scale *= .8
    }
    if (!blob || blob.type !== 'image/jpeg' || !blob.size || blob.size > MAX_PRODUCT_IMAGE_BYTES) throw new Error('รูปที่ครอปยังใหญ่เกินไป กรุณาลดขนาดกรอบ')
    const bytes = new Uint8Array(await blob.arrayBuffer()); check(signal)
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('เตรียมรูป JPEG ไม่สำเร็จ')
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
    check(signal)
    const chunks: string[] = []
    for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)))
    return Object.freeze({ data: btoa(chunks.join('')), sha256, width: canvas.width, height: canvas.height })
  } finally { decoded.close() }
}

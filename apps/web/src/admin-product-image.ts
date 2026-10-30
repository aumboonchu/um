import { AdminError, adminRequest } from './admin-client'
import { isCroppedProductImage, type CroppedProductImage } from './product-image-crop'

export type AdminImageAttempt = { version: 1; productId: string; payload: {
  accountId: string; operationId: string; expectedRevision: number; productImage: CroppedProductImage;
} }
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const key = (accountId: string) => `smartcart-admin-image-v1:${encodeURIComponent(accountId)}`
const storageError = () => new AdminError('ADMIN_IMAGE_STORAGE_BLOCKED')
export function readAdminImage(accountId: string): AdminImageAttempt | null {
  try {
    const raw = localStorage.getItem(key(accountId))
    if (!raw) return null
    const value: unknown = raw.length <= 190_000 ? JSON.parse(raw) : null
    if (!record(value) || value.version !== 1 || typeof value.productId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.productId)
      || Object.keys(value).length !== 3 || !record(value.payload)) throw storageError()
    const p = value.payload
    if (Object.keys(p).length !== 4 || p.accountId !== accountId || typeof p.operationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.operationId)
      || !Number.isSafeInteger(p.expectedRevision) || Number(p.expectedRevision) < 0 || !isCroppedProductImage(p.productImage)) throw storageError()
    return { version: 1, productId: value.productId, payload: { accountId, operationId: p.operationId,
      expectedRevision: Number(p.expectedRevision), productImage: p.productImage } }
  } catch { throw storageError() }
}
export function persistAdminImage(attempt: AdminImageAttempt): void {
  const accountId = attempt.payload.accountId, raw = JSON.stringify(attempt)
  if (raw.length > 190_000 || !isCroppedProductImage(attempt.payload.productImage)) throw new AdminError('PRODUCT_IMAGE_INVALID', 400)
  const previous = readAdminImage(accountId)
  if (previous && JSON.stringify(previous) !== raw) throw storageError()
  try { localStorage.setItem(key(accountId), raw); if (localStorage.getItem(key(accountId)) !== raw) throw storageError() }
  catch { throw storageError() }
}
export function clearAdminImage(attempt: AdminImageAttempt): void {
  const previous = readAdminImage(attempt.payload.accountId)
  if (previous && JSON.stringify(previous) !== JSON.stringify(attempt)) throw storageError()
  try {
    localStorage.removeItem(key(attempt.payload.accountId))
    if (localStorage.getItem(key(attempt.payload.accountId)) !== null) throw storageError()
  } catch { throw storageError() }
}
export async function sendAdminImage(apiOrigin: string, token: string, attempt: AdminImageAttempt): Promise<void> {
  persistAdminImage(attempt)
  const data = await adminRequest(apiOrigin, `/products/${encodeURIComponent(attempt.productId)}/image`, token,
    { method: 'PATCH', body: JSON.stringify(attempt.payload) })
  if (!record(data) || data.operationId !== attempt.payload.operationId || data.productId !== attempt.productId
    || data.revision !== attempt.payload.expectedRevision + 1 || typeof data.imageUrl !== 'string'
    || !data.imageUrl.endsWith(`/${attempt.payload.productImage.sha256}.jpg`)) throw new AdminError('ADMIN_RESPONSE_INVALID')
}
export function definiteAdminImageError(e: unknown): boolean {
  return e instanceof AdminError && [400, 404, 409, 413].includes(e.status)
    && ['PRODUCT_IMAGE_INVALID', 'PRODUCT_IMAGE_TOO_LARGE', 'PRODUCT_NOT_FOUND', 'PRODUCT_CONFLICT'].includes(e.code)
}

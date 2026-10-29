import type { ProductDetail } from './purchase-management'

export type ProductFields = { name: string; brand: string; packageSize: string; unit: string; category: string }
type Payload = Readonly<{ accountId: string; operationId: string; expectedRevision: number; name: string; brand: string | null; packageSize: string | null; unit: string | null; category: string | null }>
export type ProductEditAttempt = Readonly<{ productId: string; payload: Payload }>
type Result = { status: 'success'; cleanupPending: boolean } | { status: 'error' | 'uncertain' | 'blocked'; code: string; message: string }
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const key = (accountId: string, id: string) => `smartcart-product-edit-v1:${encodeURIComponent(accountId)}:${encodeURIComponent(id)}`
export const productFields = (p: Pick<ProductDetail, 'name' | 'brand' | 'packageSize' | 'unit' | 'category'>): ProductFields => ({ name: p.name, brand: p.brand ?? '', packageSize: p.packageSize ?? '', unit: p.unit ?? '', category: p.category ?? '' })
export function productEditMessage(code: string) {
  switch (code) {
    case 'PRODUCT_CONFLICT': return 'สินค้าเปลี่ยนจากอีกแท็บแล้ว กรุณาโหลดล่าสุดก่อนแก้ไขอีกครั้ง'
    case 'PRODUCT_NOT_FOUND': return 'ไม่พบสินค้าที่เกี่ยวข้องกับบัญชีนี้'
    case 'INVALID_PRODUCT_CHANGE': return 'กรุณาตรวจชื่อสินค้าและความยาวข้อมูลอีกครั้ง'
    case 'UNAUTHENTICATED': case 'PRODUCT_ACCOUNT_MISMATCH': return 'กรุณาเข้าสู่ระบบด้วยบัญชีเดิม แล้วตรวจสอบคำขอด้วยรหัสเดิม'
    case 'UNTRUSTED_ORIGIN': return 'กรุณาเปิด SmartCart จากเว็บหลัก แล้วตรวจสอบด้วยรหัสเดิม'
    case 'OPERATION_CONFLICT': return 'รหัสรายการไม่ตรงกับข้อมูลเดิม อย่าส่งเป็นรายการใหม่ กรุณาตรวจสอบคำขอเดิม'
    default: return 'ยังยืนยันผลไม่ได้ ระบบเก็บคำขอไว้ กรุณาตรวจสอบด้วยรหัสเดิมเมื่อออนไลน์'
  }
}
export function createProductEdit(accountId: string, productId: string, revision: number, fields: ProductFields, operationId: string = crypto.randomUUID()): ProductEditAttempt {
  if (!accountId || accountId.length > 100 || !/^[A-Za-z0-9_-]{1,100}$/.test(productId)
    || !Number.isSafeInteger(revision) || revision < 0 || revision >= 1_000_000_000
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('INVALID_PRODUCT_CHANGE')
  const clean = (name: keyof ProductFields, max: number) => {
    const value = fields[name]
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('INVALID_PRODUCT_CHANGE')
    return value.trim() || null
  }
  const name = clean('name', 200)
  if (!name) throw new Error('INVALID_PRODUCT_CHANGE')
  return Object.freeze({ productId, payload: Object.freeze({ accountId, operationId: operationId.toLowerCase(), expectedRevision: revision, name,
    brand: clean('brand', 100), packageSize: clean('packageSize', 100), unit: clean('unit', 40), category: clean('category', 100) }) })
}
export function loadProductEdit(accountId: string, id: string, storage: Store = localStorage): ProductEditAttempt | null {
  const raw = storage.getItem(key(accountId, id))
  if (raw === null) return null
  if (raw.length > 12_000) throw new Error('PENDING_PRODUCT_INVALID')
  const v: unknown = JSON.parse(raw)
  if (!record(v) || v.productId !== id || !record(v.payload)) throw new Error('PENDING_PRODUCT_INVALID')
  const p = v.payload
  if (p.accountId !== accountId || typeof p.operationId !== 'string' || typeof p.expectedRevision !== 'number' || typeof p.name !== 'string'
    || ['brand', 'packageSize', 'unit', 'category'].some(k => p[k] !== null && typeof p[k] !== 'string')) throw new Error('PENDING_PRODUCT_INVALID')
  const attempt = createProductEdit(accountId, id, p.expectedRevision, { name: p.name,
    brand: typeof p.brand === 'string' ? p.brand : '', packageSize: typeof p.packageSize === 'string' ? p.packageSize : '',
    unit: typeof p.unit === 'string' ? p.unit : '', category: typeof p.category === 'string' ? p.category : '' }, p.operationId)
  if (JSON.stringify(attempt) !== raw) throw new Error('PENDING_PRODUCT_INVALID')
  return attempt
}
function clear(accountId: string, attempt: ProductEditAttempt, storage: Store) {
  const pending = loadProductEdit(accountId, attempt.productId, storage)
  if (pending && JSON.stringify(pending) !== JSON.stringify(attempt)) throw new Error('PENDING_PRODUCT_MISMATCH')
  storage.removeItem(key(accountId, attempt.productId))
  if (storage.getItem(key(accountId, attempt.productId)) !== null) throw new Error('PENDING_PRODUCT_STORAGE')
}
export async function sendProductEdit(accountId: string, attempt: ProductEditAttempt, send: (init: RequestInit) => Promise<Response>, options: { storage?: Store; timeoutMs?: number } = {}): Promise<Result> {
  let storage: Store
  try {
    storage = options.storage ?? localStorage
    if (accountId !== attempt.payload.accountId) throw new Error('PENDING_PRODUCT_MISMATCH')
    const pending = loadProductEdit(accountId, attempt.productId, storage)
    if (pending && JSON.stringify(pending) !== JSON.stringify(attempt)) throw new Error('PENDING_PRODUCT_MISMATCH')
    storage.setItem(key(accountId, attempt.productId), JSON.stringify(attempt))
    if (storage.getItem(key(accountId, attempt.productId)) !== JSON.stringify(attempt)) throw new Error('PENDING_PRODUCT_STORAGE')
  } catch { return { status: 'blocked', code: 'PENDING_PRODUCT_STORAGE', message: 'ยังเก็บรหัสคำขอบนอุปกรณ์ไม่ได้ จึงยังไม่ส่งคำขอครั้งนี้ กรุณาตรวจสอบพื้นที่เก็บข้อมูล อย่าล้างข้อมูลเว็บหากมีคำขอค้าง' } }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { response, body } = await Promise.race([
      (async () => { const response = await send({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt.payload), signal: controller.signal }); const body: unknown = await response.json(); return { response, body } })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TIMEOUT')) }, options.timeoutMs ?? 20_000) }),
    ])
    if (response.ok) {
      if (!record(body) || !record(body.data) || body.data.operationId !== attempt.payload.operationId || body.data.productId !== attempt.productId
        || body.data.profileRevision !== attempt.payload.expectedRevision + 1) throw new Error('INVALID_RESPONSE')
      let cleanupPending = false
      try { clear(accountId, attempt, storage) } catch { cleanupPending = true }
      return { status: 'success', cleanupPending }
    }
    const code = record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : 'INVALID_RESPONSE'
    if ([400, 404, 409].includes(response.status) && ['INVALID_PRODUCT_CHANGE', 'PRODUCT_NOT_FOUND', 'PRODUCT_CONFLICT'].includes(code)) {
      try { clear(accountId, attempt, storage) } catch { return { status: 'blocked', code: 'PENDING_PRODUCT_STORAGE', message: productEditMessage(code) } }
      return { status: 'error', code, message: productEditMessage(code) }
    }
    return { status: 'uncertain', code, message: productEditMessage(code) }
  } catch { return { status: 'uncertain', code: 'PRODUCT_REQUEST_UNCERTAIN', message: productEditMessage('PRODUCT_REQUEST_UNCERTAIN') } }
  finally { clearTimeout(timer) }
}

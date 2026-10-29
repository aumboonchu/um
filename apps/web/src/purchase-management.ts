import { apiFetch } from './auth-client'

export type PurchaseItem = { id: string; productId: string; productName: string; productSku: string; productUpc: string | null; productBrand: string | null; imageUrl: string | null; storeName: string | null; unitPriceMinor: number; quantity: number; totalMinor: number; purchasedAt: string; note: string | null }
export type PurchaseDetail = PurchaseItem & { revision: number; updatedAt: string; packageSize: string | null; shoppingRoundId?: string | null }
export type Dashboard = { month: string; start: string; end: string; totalSpentMinor: number; purchaseCount: number; productCount: number; averageMinor: number; recentPurchases: PurchaseItem[] }
export type ProductDetail = { id: string; sku: string; upc: string | null; name: string; brand: string | null; packageSize: string | null; unit: string | null; category: string | null; imageUrl: string | null; profileRevision?: number; purchaseCount: number; totalSpentMinor: number; totalQuantity: number; minimumPriceMinor: number | null; maximumPriceMinor: number | null; lastPurchasedAt: string | null; recentPurchases: PurchaseItem[] }
export type PurchaseFields = { price: string; quantity: string; purchasedAt: string; storeName: string; note: string }
export type EditPayload = { unitPriceMinor: number; quantity: number; purchasedAt: string; storeName: string | null; note: string | null }
type MutationPayload = Readonly<{ operationId: string; expectedRevision: number } & Partial<EditPayload>>
export type ChangeAttempt = Readonly<{ purchaseId: string; action: 'edit' | 'delete'; payload: MutationPayload }>
export type ChangeResult = { status: 'success'; cleanupPending: boolean } | { status: 'error' | 'uncertain' | 'blocked'; message: string; code?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ID = /^[A-Za-z0-9_-]{1,100}$/
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const textOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const money = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
export function validPurchase(v: unknown): v is PurchaseItem {
  return record(v) && typeof v.id === 'string' && ID.test(v.id) && typeof v.productId === 'string' && ID.test(v.productId)
    && typeof v.productName === 'string' && typeof v.productSku === 'string' && textOrNull(v.productUpc) && textOrNull(v.productBrand)
    && textOrNull(v.imageUrl) && textOrNull(v.storeName) && money(v.unitPriceMinor) && money(v.totalMinor)
    && typeof v.quantity === 'number' && Number.isFinite(v.quantity) && v.quantity > 0 && date(v.purchasedAt) && textOrNull(v.note)
}
function validDetail(v: unknown): v is PurchaseDetail { return validPurchase(v) && 'revision' in v && money(v.revision) && v.revision > 0 && 'updatedAt' in v && typeof v.updatedAt === 'string' && 'packageSize' in v && textOrNull(v.packageSize) }
function validDashboard(v: unknown): v is Dashboard { return record(v) && typeof v.month === 'string' && /^\d{4}-\d{2}$/.test(v.month) && date(v.start) && date(v.end) && money(v.totalSpentMinor) && money(v.averageMinor) && money(v.purchaseCount) && money(v.productCount) && Array.isArray(v.recentPurchases) && v.recentPurchases.every(validPurchase) }
function validProduct(v: unknown): v is ProductDetail { return record(v) && typeof v.id === 'string' && typeof v.sku === 'string' && typeof v.name === 'string'
  && (v.profileRevision === undefined || money(v.profileRevision))
  && ['upc', 'brand', 'packageSize', 'unit', 'category', 'imageUrl', 'lastPurchasedAt'].every(key => textOrNull(v[key]))
  && money(v.purchaseCount) && money(v.totalSpentMinor) && typeof v.totalQuantity === 'number' && Number.isFinite(v.totalQuantity)
  && (v.minimumPriceMinor === null || money(v.minimumPriceMinor)) && (v.maximumPriceMinor === null || money(v.maximumPriceMinor)) && Array.isArray(v.recentPurchases) && v.recentPurchases.every(validPurchase) }

export function managementMessage(code: string): string {
  switch (code) {
    case 'ROUND_LOCKED': return 'รายการอยู่ในรอบที่ชำระแล้ว ไม่เปิดให้แก้หรือลบรายชิ้น เพื่อคงยอดรายงานทั้งรอบ'
    case 'UNAUTHENTICATED': return 'กรุณาเข้าสู่ระบบด้วยบัญชีเดิมก่อนตรวจสอบรายการ'
    case 'UNTRUSTED_ORIGIN': return 'กรุณาเปิด SmartCart จากหน้าเว็บหลัก'
    case 'PURCHASE_NOT_FOUND': return 'ไม่พบรายการซื้อของบัญชีนี้ รายการอาจถูกลบไปแล้ว'
    case 'PRODUCT_NOT_FOUND': return 'ไม่พบสินค้าที่เกี่ยวข้องกับบัญชีนี้'
    case 'PURCHASE_CONFLICT': return 'รายการเปลี่ยนแปลงจากอีกแท็บแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข ไม่ได้บันทึกทับข้อมูลใหม่'
    case 'INVALID_PURCHASE_CHANGE': return 'ข้อมูลไม่ถูกต้อง กรุณาตรวจราคา จำนวน วันที่ ร้านค้า และหมายเหตุ'
    case 'OPERATION_CONFLICT': return 'รหัสรายการมีข้อมูลไม่ตรงกับครั้งก่อน ห้ามส่งเป็นรายการใหม่ กรุณาตรวจสอบรายการเดิม'
    default: return 'ยังเชื่อมต่อหรืออ่านข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง ข้อมูลในฐานข้อมูลยังเป็นข้อมูลหลัก'
  }
}
async function requestJson(send: (init: RequestInit) => Promise<Response>, init: RequestInit, timeout = 20_000) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => { const response = await send({ ...init, signal: controller.signal }); const body: unknown = await response.json(); return { response, body } })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('REQUEST_TIMEOUT')) }, timeout) }),
    ])
  } finally { clearTimeout(timer) }
}
function errorCode(body: unknown) { return record(body) && record(body.error) && typeof body.error.code === 'string' && /^[A-Z_]{1,64}$/.test(body.error.code) ? body.error.code : 'INVALID_RESPONSE' }
async function read<T>(apiOrigin: string, path: string, validate: (v: unknown) => v is T): Promise<T> {
  const { response, body } = await requestJson(init => apiFetch(apiOrigin, path, init), { method: 'GET' })
  if (!response.ok) throw new Error(errorCode(body))
  if (!record(body) || !validate(body.data)) throw new Error('INVALID_RESPONSE')
  return body.data
}
export const getDashboard = (api: string, month: string) => read(api, `/api/v1/dashboard?month=${encodeURIComponent(month)}`, validDashboard)
export const getPurchaseDetail = (api: string, id: string) => read(api, `/api/v1/purchases/${encodeURIComponent(id)}`, validDetail)
export const getProductDetail = (api: string, id: string) => read(api, `/api/v1/products/${encodeURIComponent(id)}/detail`, validProduct)
export const formatMoney = (minor: number) => new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' }).format(minor / 100)
export const formatPurchaseDate = (value: string) => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
export const bangkokMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7)
export function localDateTime(value = new Date().toISOString()): string {
  const d = new Date(value)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}
export function fieldsForPurchase(p: PurchaseDetail): PurchaseFields { return { price: (p.unitPriceMinor / 100).toFixed(2), quantity: String(p.quantity), purchasedAt: localDateTime(p.purchasedAt), storeName: p.storeName ?? '', note: p.note ?? '' } }
export function purchaseFieldsPayload(fields: PurchaseFields): EditPayload {
  const price = fields.price.trim()
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(price) || !/^\d+(?:\.\d+)?$/.test(fields.quantity.trim())) throw new Error('กรุณากรอกราคาทศนิยมไม่เกิน 2 ตำแหน่ง และจำนวนให้ถูกต้อง')
  const unitPriceMinor = Math.round(Number(price.replaceAll(',', '')) * 100), quantity = Number(fields.quantity)
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor <= 0 || unitPriceMinor > 100_000_000 || !Number.isFinite(quantity) || quantity <= 0 || quantity > 10_000 || Math.round(unitPriceMinor * quantity) <= 0) throw new Error('ราคาและจำนวนต้องมากกว่า 0 และอยู่ในขอบเขตที่รองรับ')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(fields.purchasedAt) || !Number.isFinite(Date.parse(fields.purchasedAt))) throw new Error('กรุณาระบุวันที่และเวลาที่ซื้อให้ถูกต้อง')
  if (fields.storeName.trim().length > 80 || fields.note.trim().length > 500) throw new Error('ร้านค้าต้องไม่เกิน 80 ตัวอักษร และหมายเหตุต้องไม่เกิน 500 ตัวอักษร')
  return { unitPriceMinor, quantity, purchasedAt: new Date(fields.purchasedAt).toISOString(), storeName: fields.storeName.trim() || null, note: fields.note.trim() || null }
}
export function createChangeAttempt(purchaseId: string, expectedRevision: number, fields: PurchaseFields | null, operationId: string = crypto.randomUUID()): ChangeAttempt {
  if (!ID.test(purchaseId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !UUID.test(operationId)) throw new Error('รหัสหรือเวอร์ชันรายการไม่ถูกต้อง กรุณาโหลดใหม่')
  return Object.freeze({ purchaseId, action: fields ? 'edit' : 'delete', payload: Object.freeze({ operationId, expectedRevision, ...(fields ? purchaseFieldsPayload(fields) : {}) }) })
}
const pendingKey = (account: string, id: string) => {
  if (!account || account.length > 200 || !ID.test(id)) throw new Error('INVALID_PENDING_CHANGE')
  return `smartcart-purchase-change-v1:${encodeURIComponent(account)}:${id}`
}
export function loadPendingChange(account: string, id: string): ChangeAttempt | null {
  const raw = localStorage.getItem(pendingKey(account, id))
  if (!raw) return null
  if (raw.length > 10_240) throw new Error('INVALID_PENDING_CHANGE')
  const data: unknown = JSON.parse(raw)
  if (!record(data) || data.accountId !== account || data.version !== 1 || !record(data.attempt) || data.attempt.purchaseId !== id
    || !['edit', 'delete'].includes(String(data.attempt.action)) || !record(data.attempt.payload)) throw new Error('INVALID_PENDING_CHANGE')
  const payload = data.attempt.payload
  if (typeof payload.operationId !== 'string' || !UUID.test(payload.operationId) || typeof payload.expectedRevision !== 'number' || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1) throw new Error('INVALID_PENDING_CHANGE')
  const allowed = data.attempt.action === 'edit' ? ['operationId', 'expectedRevision', 'unitPriceMinor', 'quantity', 'purchasedAt', 'storeName', 'note'] : ['operationId', 'expectedRevision']
  if (Object.keys(payload).length !== allowed.length || Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('INVALID_PENDING_CHANGE')
  if (data.attempt.action === 'edit' && (!money(payload.unitPriceMinor) || payload.unitPriceMinor <= 0 || payload.unitPriceMinor > 100_000_000 || typeof payload.quantity !== 'number' || !Number.isFinite(payload.quantity) || payload.quantity <= 0 || payload.quantity > 10_000
    || !date(payload.purchasedAt) || !textOrNull(payload.storeName) || (payload.storeName?.length ?? 0) > 80 || !textOrNull(payload.note) || (payload.note?.length ?? 0) > 500)) throw new Error('INVALID_PENDING_CHANGE')
  return Object.freeze({ purchaseId: id, action: data.attempt.action as 'edit' | 'delete', payload: Object.freeze(payload as MutationPayload) })
}
export function listPendingChanges(account: string): ChangeAttempt[] {
  if (!account || account.length > 200) throw new Error('INVALID_PENDING_CHANGE')
  const prefix = `smartcart-purchase-change-v1:${encodeURIComponent(account)}:`, results: ChangeAttempt[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    const attempt = loadPendingChange(account, key.slice(prefix.length))
    if (attempt) results.push(attempt)
  }
  return results
}
export function persistChange(account: string, attempt: ChangeAttempt) {
  const existing = loadPendingChange(account, attempt.purchaseId)
  if (existing && JSON.stringify(existing) !== JSON.stringify(attempt)) throw new Error('PENDING_CHANGE_CONFLICT')
  const raw = JSON.stringify({ version: 1, accountId: account, attempt })
  localStorage.setItem(pendingKey(account, attempt.purchaseId), raw)
  if (localStorage.getItem(pendingKey(account, attempt.purchaseId)) !== raw) throw new Error('PENDING_STORAGE_UNAVAILABLE')
}
function clearChange(account: string, attempt: ChangeAttempt) {
  const existing = loadPendingChange(account, attempt.purchaseId)
  if (existing && existing.payload.operationId !== attempt.payload.operationId) return false
  localStorage.removeItem(pendingKey(account, attempt.purchaseId))
  return localStorage.getItem(pendingKey(account, attempt.purchaseId)) === null
}
export async function sendChange(account: string, attempt: ChangeAttempt, send: (init: RequestInit) => Promise<Response>, timeout?: number): Promise<ChangeResult> {
  try { persistChange(account, attempt) } catch { return { status: 'blocked', message: 'เก็บรหัสรายการบนอุปกรณ์ไม่ได้ จึงยังไม่ส่งคำขอครั้งนี้ กรุณาตรวจสอบพื้นที่เก็บข้อมูลแล้วลองด้วยรหัสเดิม' } }
  try {
    const { response, body } = await requestJson(send, { method: attempt.action === 'edit' ? 'PATCH' : 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt.payload) }, timeout)
    if (response.ok && record(body) && record(body.data) && body.data.operationId === attempt.payload.operationId && body.data.purchaseId === attempt.purchaseId
      && body.data.action === attempt.action && body.data.revision === attempt.payload.expectedRevision + 1) {
      let cleared = false
      try { cleared = clearChange(account, attempt) } catch { /* A confirmed database write remains successful. */ }
      return { status: 'success', cleanupPending: !cleared }
    }
    const code = errorCode(body)
    if ((response.status === 400 || response.status === 404 || response.status === 409) && ['INVALID_PURCHASE_CHANGE', 'PURCHASE_NOT_FOUND', 'PURCHASE_CONFLICT', 'ROUND_LOCKED'].includes(code)) {
      if (!clearChange(account, attempt)) throw new Error('PENDING_STORAGE_UNAVAILABLE')
      return { status: 'error', code, message: managementMessage(code) }
    }
    return { status: 'uncertain', code, message: `ยังยืนยันผลไม่ได้ รายการอาจเปลี่ยนแล้ว กรุณาตรวจสอบด้วยรหัสเดิม ${managementMessage(code)}` }
  } catch { return { status: 'uncertain', message: 'การเชื่อมต่อขัดข้องหรือรอนานเกินไป รายการอาจเปลี่ยนแล้ว กดตรวจสอบด้วยรหัสเดิม ไม่ส่งเป็นรายการใหม่' } }
}

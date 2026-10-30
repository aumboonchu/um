import { apiFetch } from './auth-client'

export type AdminSession = { token: string; expiresAt: string; mustChangePassword: boolean }
export type AdminProduct = {
  id: string; sku: string; upc: string | null; name: string; brand: string | null; packageSize: string | null;
  unit: string | null; category: string | null; imageUrl: string | null; source: string;
  sourceProductId: string | null; sourceUrl: string | null; createdAt: string; updatedAt: string; revision: number;
}
export type AdminFields = { name: string; brand: string; packageSize: string; unit: string; category: string }
export type AdminEdit = { productId: string; payload: {
  accountId: string; operationId: string; expectedRevision: number; name: string;
  brand: string | null; packageSize: string | null; unit: string | null; category: string | null;
} }
export class AdminError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code) }
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const optional = (value: unknown) => value === null || typeof value === 'string'
export function adminFields(product: Pick<AdminProduct, keyof AdminFields> | AdminEdit['payload']): AdminFields {
  return { name: product.name, brand: product.brand ?? '', packageSize: product.packageSize ?? '', unit: product.unit ?? '', category: product.category ?? '' }
}
export function isAdminProduct(value: unknown): value is AdminProduct {
  return record(value) && typeof value.id === 'string' && typeof value.sku === 'string' && typeof value.name === 'string'
    && ['upc', 'brand', 'packageSize', 'unit', 'category', 'imageUrl', 'sourceProductId', 'sourceUrl'].every(key => optional(value[key]))
    && typeof value.source === 'string' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
}
export async function adminRequest(apiOrigin: string, path: string, token: string | null = null, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController(), headers = new Headers(init.headers)
  if (token) headers.set('X-SmartCart-Admin', token)
  if (init.body) headers.set('Content-Type', 'application/json')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await apiFetch(apiOrigin, `/api/v1/admin${path}`, { ...init, headers, signal: controller.signal })
        let body: unknown
        try { body = await response.json() } catch { throw new AdminError('ADMIN_RESPONSE_INVALID', response.status) }
        if (!response.ok) throw new AdminError(record(body) && record(body.error) && typeof body.error.code === 'string' ? body.error.code : 'ADMIN_REQUEST_FAILED', response.status)
        if (!record(body) || !('data' in body)) throw new AdminError('ADMIN_RESPONSE_INVALID', response.status)
        return body.data
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AdminError('ADMIN_TIMEOUT')) }, 20_000) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}
export async function adminLogin(apiOrigin: string, accountId: string, password: string, currentToken: string | null = null): Promise<AdminSession> {
  const data = await adminRequest(apiOrigin, currentToken ? '/password' : '/login', currentToken, { method: 'POST', body: JSON.stringify({ accountId, password }) })
  if (!record(data) || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.token)
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()
    || typeof data.mustChangePassword !== 'boolean' || currentToken && data.mustChangePassword) throw new AdminError('ADMIN_RESPONSE_INVALID')
  return { token: data.token, expiresAt: data.expiresAt, mustChangePassword: data.mustChangePassword }
}
export async function adminList(apiOrigin: string, token: string, query: string, cursor: string | null) {
  const params = new URLSearchParams()
  if (query.trim()) params.set('q', query.trim())
  if (cursor) params.set('cursor', cursor)
  const data = await adminRequest(apiOrigin, `/products?${params}`, token)
  if (!record(data) || !Array.isArray(data.items) || !data.items.every(isAdminProduct) || !optional(data.nextCursor)
    || !Number.isSafeInteger(data.total) || Number(data.total) < 0) throw new AdminError('ADMIN_RESPONSE_INVALID')
  return { items: data.items, nextCursor: data.nextCursor as string | null, total: Number(data.total) }
}
export async function adminDetail(apiOrigin: string, token: string, id: string): Promise<AdminProduct> {
  const data = await adminRequest(apiOrigin, `/products/${encodeURIComponent(id)}`, token)
  if (!isAdminProduct(data) || data.id !== id) throw new AdminError('ADMIN_RESPONSE_INVALID')
  return data
}
export function createAdminEdit(accountId: string, product: AdminProduct, fields: AdminFields): AdminEdit {
  const normalize = (value: string, max: number, required = false) => {
    const result = value.trim()
    if (result.length > max || required && !result || /[\u0000-\u001f\u007f]/.test(result)) throw new AdminError('INVALID_ADMIN_INPUT')
    return result || null
  }
  return { productId: product.id, payload: { accountId, operationId: crypto.randomUUID(), expectedRevision: product.revision,
    name: normalize(fields.name, 200, true)!, brand: normalize(fields.brand, 100), packageSize: normalize(fields.packageSize, 100),
    unit: normalize(fields.unit, 40), category: normalize(fields.category, 100) } }
}
const pendingKey = (accountId: string) => `smartcart-admin-edit-v1:${encodeURIComponent(accountId)}`
function validEdit(value: unknown, accountId: string): value is AdminEdit {
  if (!record(value) || typeof value.productId !== 'string' || !value.productId || !record(value.payload)) return false
  const p = value.payload
  if (p.accountId !== accountId || typeof p.operationId !== 'string' || !uuid.test(p.operationId)
    || !Number.isSafeInteger(p.expectedRevision) || Number(p.expectedRevision) < 0 || typeof p.name !== 'string' || !p.name.trim()) return false
  const limits = { name: 200, brand: 100, packageSize: 100, unit: 40, category: 100 }
  return Object.entries(limits).every(([key, max]) => optional(p[key]) && (p[key] === null || typeof p[key] === 'string'
    && p[key].length <= max && p[key].trim() === p[key] && !/[\u0000-\u001f\u007f]/.test(p[key])))
    && Object.keys(p).every(key => ['accountId', 'operationId', 'expectedRevision', ...Object.keys(limits)].includes(key))
}
export function readAdminEdit(accountId: string): AdminEdit | null {
  try {
    const raw = localStorage.getItem(pendingKey(accountId))
    if (!raw) return null
    const value: unknown = raw.length <= 10_000 ? JSON.parse(raw) : null
    if (!validEdit(value, accountId)) throw new AdminError('ADMIN_STORAGE_BLOCKED')
    return value
  } catch { throw new AdminError('ADMIN_STORAGE_BLOCKED') }
}
export function persistAdminEdit(accountId: string, attempt: AdminEdit): void {
  if (!validEdit(attempt, accountId)) throw new AdminError('INVALID_ADMIN_INPUT')
  const existing = readAdminEdit(accountId), serialized = JSON.stringify(attempt)
  if (existing && JSON.stringify(existing) !== serialized) throw new AdminError('ADMIN_STORAGE_BLOCKED')
  try {
    localStorage.setItem(pendingKey(accountId), serialized)
    if (localStorage.getItem(pendingKey(accountId)) !== serialized) throw new AdminError('ADMIN_STORAGE_BLOCKED')
  } catch { throw new AdminError('ADMIN_STORAGE_BLOCKED') }
}
export function clearAdminEdit(accountId: string, attempt: AdminEdit): void {
  const existing = readAdminEdit(accountId)
  if (existing && JSON.stringify(existing) !== JSON.stringify(attempt)) throw new AdminError('ADMIN_STORAGE_BLOCKED')
  try {
    localStorage.removeItem(pendingKey(accountId))
    if (localStorage.getItem(pendingKey(accountId)) !== null) throw new AdminError('ADMIN_STORAGE_BLOCKED')
  } catch { throw new AdminError('ADMIN_STORAGE_BLOCKED') }
}
export async function sendAdminEdit(apiOrigin: string, token: string, accountId: string, attempt: AdminEdit): Promise<void> {
  persistAdminEdit(accountId, attempt)
  const data = await adminRequest(apiOrigin, `/products/${encodeURIComponent(attempt.productId)}`, token, { method: 'PATCH', body: JSON.stringify(attempt.payload) })
  if (!record(data) || data.productId !== attempt.productId || data.operationId !== attempt.payload.operationId
    || data.revision !== attempt.payload.expectedRevision + 1) throw new AdminError('ADMIN_RESPONSE_INVALID')
}
export function adminMessage(error: unknown): string {
  const code = error instanceof AdminError ? error.code : ''
  switch (code) {
    case 'ADMIN_LOGIN_FAILED': return 'รหัสผ่านไม่ถูกต้อง'
    case 'ADMIN_FORBIDDEN': return 'บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ'
    case 'ADMIN_SESSION_REQUIRED': case 'ADMIN_ACCOUNT_MISMATCH': case 'UNAUTHENTICATED': return 'กรุณาเข้าสู่ระบบผู้ดูแลอีกครั้ง'
    case 'ADMIN_PASSWORD_CHANGE_REQUIRED': return 'เปลี่ยนรหัสผ่านก่อนเข้าใช้งาน'
    case 'ADMIN_RATE_LIMITED': return 'ลองรหัสผิดหลายครั้ง กรุณารอสักครู่แล้วลองใหม่'
    case 'PRODUCT_CONFLICT': return 'สินค้าเปลี่ยนจากอีกหน้าหนึ่งแล้ว กรุณาโหลดข้อมูลล่าสุด'
    case 'OPERATION_CONFLICT': return 'รหัสคำขอนี้มีข้อมูลไม่ตรงกัน กรุณาตรวจสอบก่อนส่งซ้ำ'
    case 'PRODUCT_NOT_FOUND': return 'ไม่พบสินค้านี้'
    case 'INVALID_ADMIN_INPUT': return 'กรุณาตรวจสอบข้อมูลที่กรอก'
    case 'ADMIN_STORAGE_BLOCKED': return 'ยังเก็บคำขอไว้บนเครื่องไม่ได้ จึงยังไม่ส่งคำขอใหม่'
    default: return 'ยังยืนยันผลไม่ได้ กรุณาลองอีกครั้ง'
  }
}
export const adminSessionError = (error: unknown) => error instanceof AdminError && ['ADMIN_SESSION_REQUIRED', 'ADMIN_ACCOUNT_MISMATCH', 'UNAUTHENTICATED'].includes(error.code)
export const definiteAdminEditError = (error: unknown) => error instanceof AdminError && [400, 404, 409].includes(error.status)
  && ['INVALID_ADMIN_INPUT', 'PRODUCT_NOT_FOUND', 'PRODUCT_CONFLICT'].includes(error.code)

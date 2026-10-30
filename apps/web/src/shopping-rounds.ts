import { apiFetch } from './auth-client'
import type { CachedProduct } from './offline'

export type CartLine = { id: string; product: CachedProduct; unitPriceMinor: number; quantity: number; note: string | null }
export type RoundDraft = { key: string; accountId: string; kind: 'draft'; id: string; revision: number; lines: CartLine[] }
export type CheckoutFields = { checkedOutAt: string; storeName: string | null; paymentMethod: 'cash' | 'card' | 'transfer' | 'other'; note: string | null }
export type RoundPayload = CheckoutFields & { operationId: string; accountId: string; lines: { id: string; productId: string; unitPriceMinor: number; quantity: number; note: string | null }[] }
export type ClosedRound = { key: string; accountId: string; kind: 'closed'; id: string; status: 'pending' | 'synced'; payload: RoundPayload; lines: CartLine[] }
type StoredRound = RoundDraft | ClosedRound
export type RoundSummary = { id: string; checkedOutAt: string; storeName: string | null; paymentMethod: string; note: string | null; totalMinor: number; lineCount: number; createdAt: string }
export type RoundReport = RoundSummary & { lines: { id: string; productId: string; productName: string; productSku: string; productUpc: string | null; packageSize: string | null; imageUrl?: string | null; unitPriceMinor: number; quantity: number; totalMinor: number; note: string | null }[] }
export type RoundPage = { month: string; items: RoundSummary[]; nextCursor: string | null; summary: { roundCount: number; totalPaidMinor: number }; legacy: { count: number; totalMinor: number } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const money = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const nullableText = (v: unknown) => v === null || typeof v === 'string'
export function cartTotal(lines: CartLine[]) { return lines.reduce((sum, line) => sum + Math.round(line.unitPriceMinor * line.quantity), 0) }
export function validCartLine(v: unknown): v is CartLine {
  return object(v) && typeof v.id === 'string' && UUID.test(v.id) && object(v.product) && typeof v.product.id === 'string'
    && /^[A-Za-z0-9_-]{1,100}$/.test(v.product.id) && typeof v.product.name === 'string' && nullableText(v.product.upc)
    && money(v.unitPriceMinor) && v.unitPriceMinor > 0 && v.unitPriceMinor <= 100_000_000
    && typeof v.quantity === 'number' && Number.isFinite(v.quantity) && v.quantity > 0 && v.quantity <= 10_000
    && Number.isSafeInteger(Math.round(v.unitPriceMinor * v.quantity)) && Math.round(v.unitPriceMinor * v.quantity) > 0
    && nullableText(v.note) && (typeof v.note !== 'string' || v.note.length <= 500)
}
export function checkoutPayload(draft: RoundDraft, fields: CheckoutFields): RoundPayload {
  if (!UUID.test(draft.id) || !draft.accountId || draft.lines.length === 0 || draft.lines.length > 100 || !draft.lines.every(validCartLine)
    || new Set(draft.lines.map(line => line.id)).size !== draft.lines.length || !Number.isSafeInteger(cartTotal(draft.lines)) || cartTotal(draft.lines) > 100_000_000_000_000
    || !Number.isFinite(Date.parse(fields.checkedOutAt)) || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(fields.checkedOutAt)
    || !['cash', 'card', 'transfer', 'other'].includes(fields.paymentMethod)
    || ![fields.storeName, fields.note].every(value => value === null || (typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)))
    || (fields.storeName?.length ?? 0) > 80 || (fields.note?.length ?? 0) > 500) throw new Error('INVALID_ROUND')
  return { operationId: draft.id, accountId: draft.accountId, checkedOutAt: new Date(fields.checkedOutAt).toISOString(),
    storeName: fields.storeName?.trim() || null, paymentMethod: fields.paymentMethod, note: fields.note?.trim() || null,
    lines: draft.lines.map(line => ({ id: line.id, productId: line.product.id, unitPriceMinor: line.unitPriceMinor, quantity: line.quantity, note: line.note })) }
}
let dbPromise: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('smartcart-shopping-rounds', 1); let abandoned = false
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('rounds', { keyPath: 'key' }); store.createIndex('account', 'accountId') }
    request.onerror = () => { dbPromise = undefined; reject(new Error('ROUND_STORAGE_UNAVAILABLE')) }
    request.onblocked = () => { abandoned = true; dbPromise = undefined; reject(new Error('ROUND_STORAGE_UNAVAILABLE')) }
    request.onsuccess = () => {
      if (abandoned) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close(); dbPromise = undefined }
      resolve(request.result)
    }
  }); return dbPromise
}
const draftKey = (account: string) => `${encodeURIComponent(account)}:draft`
const closedKey = (account: string, id: string) => `${encodeURIComponent(account)}:round:${id}`
function checked(v: unknown, accountId: string): StoredRound {
  if (!object(v) || v.accountId !== accountId || typeof v.key !== 'string' || typeof v.id !== 'string' || !UUID.test(v.id)
    || !Array.isArray(v.lines) || !v.lines.every(validCartLine) || v.lines.length > 100) throw new Error('ROUND_STORAGE_CORRUPT')
  if (v.kind === 'draft' && v.key === draftKey(accountId) && typeof v.revision === 'number' && Number.isSafeInteger(v.revision) && v.revision > 0) return v as RoundDraft
  if (v.kind === 'closed' && v.key === closedKey(accountId, v.id) && ['pending', 'synced'].includes(String(v.status)) && object(v.payload)) {
    const payload = v.payload as RoundPayload
    const expected = checkoutPayload({ key: '', accountId, id: v.id, kind: 'draft', revision: 1, lines: v.lines as CartLine[] }, payload)
    if (JSON.stringify(payload) !== JSON.stringify(expected)) throw new Error('ROUND_STORAGE_CORRUPT')
    return v as ClosedRound
  }
  throw new Error('ROUND_STORAGE_CORRUPT')
}
export async function readLocalRounds(accountId: string): Promise<{ draft: RoundDraft | null; closed: ClosedRound[] }> {
  const db = await open()
  const all = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction('rounds').objectStore('rounds').index('account').getAll(accountId)
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  const entries = all.map(value => checked(value, accountId))
  return { draft: entries.find((v): v is RoundDraft => v.kind === 'draft') ?? null, closed: entries.filter((v): v is ClosedRound => v.kind === 'closed').sort((a, b) => b.payload.checkedOutAt.localeCompare(a.payload.checkedOutAt)) }
}
/** CAS and checkout+outbox movement are one IndexedDB transaction across all tabs. */
export async function writeDraft(accountId: string, expected: RoundDraft | null, lines: CartLine[], checkout?: CheckoutFields): Promise<void> {
  if (!accountId || (expected && expected.accountId !== accountId) || !lines.every(validCartLine) || lines.length > 100 || new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('INVALID_ROUND')
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('rounds', 'readwrite'), store = tx.objectStore('rounds'), get = store.get(draftKey(accountId))
    let failure: unknown
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(failure ?? new Error('ROUND_STORAGE_UNAVAILABLE'))
    tx.onerror = () => { /* onabort rejects only after the transaction rolls back */ }
    get.onsuccess = () => {
      try {
        const current = get.result ? checked(get.result, accountId) : null
        if ((current && current.kind !== 'draft') || (current?.id ?? null) !== (expected?.id ?? null)
          || (current && current.kind === 'draft' ? current.revision : null) !== (expected?.revision ?? null)) throw new Error('ROUND_DRAFT_CONFLICT')
        const draft: RoundDraft = { key: draftKey(accountId), kind: 'draft', accountId, id: current?.id ?? crypto.randomUUID(), revision: (expected?.revision ?? 0) + 1, lines }
        if (checkout) {
          const payload = checkoutPayload(draft, checkout)
          // add(), never put(): a closed round UUID cannot silently overwrite a receipt.
          store.add({ key: closedKey(accountId, draft.id), kind: 'closed', accountId, id: draft.id, status: 'pending', payload, lines } satisfies ClosedRound)
          store.delete(draft.key)
        } else store.put(draft)
      } catch (error) { failure = error; tx.abort() }
    }
  })
  announce(accountId)
}
async function markSynced(round: ClosedRound) {
  const db = await open()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('rounds', 'readwrite'), store = tx.objectStore('rounds'), request = store.get(round.key)
    let failure: unknown
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure ?? new Error('ROUND_STORAGE_UNAVAILABLE'))
    request.onsuccess = () => { try {
      const current = checked(request.result, round.accountId)
      if (current.kind !== 'closed' || JSON.stringify(current.payload) !== JSON.stringify(round.payload)) throw new Error('ROUND_STORAGE_CORRUPT')
      store.put({ ...current, status: 'synced' })
    } catch (error) { failure = error; tx.abort() } }
  }); announce(round.accountId)
}
function announce(accountId: string) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('smartcart-rounds-changed', { detail: accountId }))
  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('smartcart-rounds'); channel.postMessage(accountId); channel.close() }
}
export function roundMessage(code: string) {
  switch (code) {
    case 'ROUND_DRAFT_CONFLICT': return 'รอบนี้เปลี่ยนในอีกแท็บแล้ว โหลดข้อมูลล่าสุดก่อนทำต่อ ข้อมูลในแท็บอื่นจะไม่ถูกเขียนทับ'
    case 'ROUND_ACCOUNT_MISMATCH': case 'UNAUTHENTICATED': return 'เข้าสู่ระบบด้วยบัญชีเจ้าของรอบนี้ก่อนซิงก์'
    case 'ROUND_CONFLICT': return 'รหัสรอบหรือรายการมีข้อมูลไม่ตรงกัน ยังไม่ยืนยันการซิงก์ กรุณาเก็บข้อมูลเว็บไว้เพื่อตรวจสอบ'
    case 'ROUND_PRODUCT_NOT_FOUND': return 'มีสินค้าที่ไม่พบในฐานข้อมูล รอบนี้ยังรอซิงก์และไม่ถูกลบทิ้ง'
    case 'INVALID_ROUND': return 'ข้อมูลรอบยังไม่ถูกต้อง ตรวจราคา จำนวน วันที่ และหมายเหตุ (รอบละไม่เกิน 100 รายการ)'
    case 'ROUND_STORAGE_CORRUPT': return 'ข้อมูลรอบบนอุปกรณ์ผิดรูปแบบ กรุณาอย่าล้างข้อมูลเว็บ ติดต่อผู้ดูแลเพื่อตรวจสอบ'
    case 'ROUND_STORAGE_UNAVAILABLE': return 'ยังเก็บรอบลงอุปกรณ์ไม่ได้ จึงยังไม่เพิ่มหรือจบรอบ กรุณาตรวจพื้นที่เก็บข้อมูล'
    default: return 'ยังยืนยันผลกับ D1 ไม่ได้ รอบที่จบแล้วถูกเก็บไว้รอซิงก์ ระบบจะใช้รหัสเดิมเมื่อส่งซ้ำ'
  }
}
export async function roundRequest(path: string, apiOrigin: string, init: RequestInit = {}, send = apiFetch): Promise<unknown> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('ROUND_TIMEOUT')) }, 20_000) })
  try { return await Promise.race([timeout, (async () => {
    const response = await send(apiOrigin, path, { ...init, signal: controller.signal })
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(object(body) && object(body.error) && typeof body.error.code === 'string' ? body.error.code : 'ROUND_HTTP_ERROR')
    if (!object(body) || !object(body.data)) throw new Error('ROUND_RESPONSE_INVALID')
    return body.data
  })()]) } finally { clearTimeout(timer) }
}
export async function syncClosedRounds(accountId: string, apiOrigin: string, send = apiFetch): Promise<number> {
  const { closed } = await readLocalRounds(accountId); let count = 0
  for (const round of closed.filter(item => item.status === 'pending')) {
    const data = await roundRequest('/api/v1/rounds/checkout', apiOrigin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(round.payload) }, send)
    if (!object(data) || data.id !== round.id || data.operationId !== round.id || data.status !== 'synced'
      || data.totalMinor !== cartTotal(round.lines) || data.lineCount !== round.lines.length) throw new Error('ROUND_RESPONSE_INVALID')
    await markSynced(round); count += 1
  }
  return count
}
export function validRoundSummary(v: unknown): v is RoundSummary {
  return object(v) && typeof v.id === 'string' && UUID.test(v.id) && typeof v.checkedOutAt === 'string' && Number.isFinite(Date.parse(v.checkedOutAt))
    && nullableText(v.storeName) && nullableText(v.note) && typeof v.paymentMethod === 'string' && ['cash','card','transfer','other'].includes(v.paymentMethod)
    && money(v.totalMinor) && v.totalMinor > 0 && money(v.lineCount) && v.lineCount > 0 && v.lineCount <= 100 && typeof v.createdAt === 'string'
}
export function validRoundPage(v: unknown): v is RoundPage {
  return object(v) && typeof v.month === 'string' && Array.isArray(v.items) && v.items.every(validRoundSummary) && nullableText(v.nextCursor)
    && object(v.summary) && money(v.summary.roundCount) && money(v.summary.totalPaidMinor) && object(v.legacy) && money(v.legacy.count) && money(v.legacy.totalMinor)
}
export function validRoundReport(v: unknown): v is RoundReport {
  if (!validRoundSummary(v) || !('lines' in v) || !Array.isArray(v.lines) || v.lines.length !== v.lineCount) return false
  return v.lines.every(line => object(line) && typeof line.id === 'string' && UUID.test(line.id) && typeof line.productId === 'string'
    && typeof line.productName === 'string' && typeof line.productSku === 'string' && nullableText(line.productUpc) && nullableText(line.packageSize)
    && (line.imageUrl === undefined || nullableText(line.imageUrl))
    && money(line.unitPriceMinor) && line.unitPriceMinor > 0 && typeof line.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0
    && money(line.totalMinor) && line.totalMinor === Math.round(line.unitPriceMinor * line.quantity) && nullableText(line.note))
    && v.lines.reduce((sum: number, line: { totalMinor: number }) => sum + line.totalMinor, 0) === v.totalMinor
}

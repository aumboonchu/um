import type { CachedProduct } from './offline'
import { isCroppedProductImage, validCropBounds, type CropBounds, type CroppedProductImage } from './product-image-crop'
import { productImageFailureMessage, productImageFailureReason, type ProductImageFailureReason } from './product-image-errors'

export const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024
export const MAX_IMAGE_EDGE = 1600
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type ImageDraft = {
  name: string | null
  brand: string | null
  packageSize: string | null
  sourcePriceMinor: number | null
  upc: string | null
  retailerCode: string | null
  productImageBounds?: CropBounds
}

export type ImageProductFields = {
  name: string
  brand: string
  packageSize: string
  sourcePrice: string
  upc: string
  retailerCode: string
}

export type ImageImportPayload = Readonly<{
  operationId: string
  confirmed: true
  name: string
  brand: string | null
  packageSize: string | null
  sourcePriceMinor: number | null
  upc: string | null
  retailerCode: string | null
  imageSha256: string | null
  productImage?: CroppedProductImage
}>

export type ImageImportAttempt = Readonly<{ payload: ImageImportPayload }>
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>
type StoredImageAttempt = { version: 1; accountId: string; createdAt: string; payload: ImageImportPayload }
export type ConfirmedImageProduct = CachedProduct & { sku: string }
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number }
type ErrorResult = { status: 'error'; message: string; code?: string; reason?: ProductImageFailureReason; retryable: boolean }
type CancelledResult = { status: 'cancelled' }
export type ExtractionResult =
  | { status: 'success'; draft: ImageDraft; imageSha256: string; warnings: string[] }
  | ErrorResult | CancelledResult
export type ImageSaveResult =
  | { status: 'success'; product: ConfirmedImageProduct }
  | ErrorResult | CancelledResult
  | { status: 'uncertain'; message: string; code?: string }

export const emptyImageFields = (): ImageProductFields => ({ name: '', brand: '', packageSize: '', sourcePrice: '', upc: '', retailerCode: '' })

export function fieldsFromImageDraft(draft: ImageDraft): ImageProductFields {
  return {
    name: draft.name ?? '', brand: draft.brand ?? '', packageSize: draft.packageSize ?? '',
    sourcePrice: draft.sourcePriceMinor === null ? '' : (draft.sourcePriceMinor / 100).toFixed(2),
    upc: draft.upc ?? '', retailerCode: draft.retailerCode ?? '',
  }
}

export function fieldsFromImageImportPayload(payload: ImageImportPayload): ImageProductFields {
  return fieldsFromImageDraft(payload)
}

export function validateSourceImage(file: Pick<Blob, 'size' | 'type'>): string | null {
  if (!IMAGE_TYPES.has(file.type)) return 'รองรับภาพ JPG, PNG หรือ WebP เท่านั้น กรุณาแปลงภาพ HEIC เป็น JPG ก่อน'
  if (file.size === 0) return 'ไฟล์ภาพว่าง กรุณาเลือกภาพใหม่'
  if (file.size > MAX_SOURCE_IMAGE_BYTES) return 'ภาพใหญ่เกิน 10 MB กรุณาครอปเฉพาะสินค้าแล้วเลือกใหม่'
  return null
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Image request cancelled', 'AbortError')
}

async function decodeImage(file: Blob, signal?: AbortSignal): Promise<{ image: CanvasImageSource; width: number; height: number; close: () => void }> {
  abortIfNeeded(signal)
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    if (signal?.aborted) { bitmap.close(); abortIfNeeded(signal) }
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  const source = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        image.onload = null
        image.onerror = null
        signal?.removeEventListener('abort', stop)
        reject(new DOMException('Image request cancelled', 'AbortError'))
      }
      image.onload = () => { signal?.removeEventListener('abort', stop); resolve() }
      image.onerror = () => { signal?.removeEventListener('abort', stop); reject(new Error('อ่านไฟล์ภาพไม่ได้ กรุณาเลือกภาพใหม่')) }
      signal?.addEventListener('abort', stop, { once: true })
      image.src = source
    })
    abortIfNeeded(signal)
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(source) }
  } catch (error) {
    URL.revokeObjectURL(source)
    throw error
  }
}

export async function prepareImageUpload(file: Blob, signal?: AbortSignal): Promise<Blob> {
  const validation = validateSourceImage(file)
  if (validation) throw new Error(validation)
  const decoded = await decodeImage(file, signal)
  try {
    abortIfNeeded(signal)
    if (!decoded.width || !decoded.height) throw new Error('อ่านขนาดภาพไม่ได้ กรุณาเลือกภาพใหม่')
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(decoded.width * scale))
    canvas.height = Math.max(1, Math.round(decoded.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('เบราว์เซอร์นี้ยังเตรียมภาพไม่ได้ กรุณาลอง Safari หรือ Chrome เวอร์ชันใหม่')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height)
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('เตรียมภาพไม่สำเร็จ กรุณาเลือกภาพใหม่')), 'image/jpeg', .85)
    })
    abortIfNeeded(signal)
    if (result.size > MAX_UPLOAD_IMAGE_BYTES) throw new Error('ภาพที่เตรียมแล้วยังใหญ่เกิน 3 MB กรุณาครอปเฉพาะข้อมูลสินค้า')
    return result
  } finally { decoded.close() }
}

export async function imageFingerprint(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizedText(value: string): string { return value.trim().replace(/\s+/g, ' ') }

function validUpc(value: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value) || /^(\d)\1+$/.test(value)) return false
  const digits = [...value].map(Number)
  const check = digits.pop()!
  const total = digits.reverse().reduce((sum, digit, index) => sum + digit * (index % 2 === 0 ? 3 : 1), 0)
  return (10 - total % 10) % 10 === check
}

function priceMinor(value: string): number | null {
  if (!value.trim()) return null
  const normalized = value.trim().replace(/,/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return Number.NaN
  return Math.round(Number(normalized) * 100)
}

export function validateImageProductFields(fields: ImageProductFields): string | null {
  if (!normalizedText(fields.name) || normalizedText(fields.name).length > 200) return 'กรุณาระบุชื่อสินค้า 1–200 ตัวอักษร'
  if (normalizedText(fields.brand).length > 100) return 'แบรนด์ต้องไม่เกิน 100 ตัวอักษร'
  if (normalizedText(fields.packageSize).length > 100) return 'ขนาดบรรจุต้องไม่เกิน 100 ตัวอักษร'
  if (normalizedText(fields.retailerCode).length > 80) return 'รหัสสินค้าบนภาพต้องไม่เกิน 80 ตัวอักษร'
  const price = priceMinor(fields.sourcePrice)
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > 100_000_000)) return 'ราคาอ้างอิงต้องอยู่ระหว่าง 0–1,000,000 บาท และมีทศนิยมไม่เกิน 2 ตำแหน่ง'
  if (fields.upc.trim() && !validUpc(fields.upc.trim())) return 'UPC / EAN ไม่ถูกต้อง ต้องเป็นบาร์โค้ด 8, 12, 13 หรือ 14 หลักที่ตรวจสอบได้ หากภาพไม่มีบาร์โค้ดให้เว้นว่าง'
  return null
}

export function createImageImportAttempt(fields: ImageProductFields, imageSha256: string | null, operationId: string = crypto.randomUUID(), productImage?: CroppedProductImage): ImageImportAttempt {
  const validation = validateImageProductFields(fields)
  if (validation) throw new Error(validation)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('ไม่สามารถสร้างรหัสรายการได้ กรุณาโหลดหน้าใหม่')
  if (imageSha256 !== null && !/^[0-9a-f]{64}$/i.test(imageSha256)) throw new Error('ข้อมูลอ้างอิงภาพไม่ถูกต้อง กรุณาเลือกภาพใหม่')
  if (productImage !== undefined && !isCroppedProductImage(productImage)) throw new Error('รูปสินค้าที่ครอปไม่ถูกต้อง กรุณาครอปใหม่')
  return Object.freeze({ payload: Object.freeze({
    operationId, confirmed: true as const, name: normalizedText(fields.name),
    brand: normalizedText(fields.brand) || null, packageSize: normalizedText(fields.packageSize) || null,
    sourcePriceMinor: priceMinor(fields.sourcePrice), upc: fields.upc.trim() || null,
    retailerCode: normalizedText(fields.retailerCode) || null, imageSha256: imageSha256?.toLowerCase() ?? null,
    ...(productImage ? { productImage: Object.freeze({ ...productImage }) } : {}),
  }) })
}

const PENDING_IMAGE_PREFIX = 'smartcart-image-pending-v1:'
const PENDING_PAYLOAD_KEYS = ['operationId', 'confirmed', 'name', 'brand', 'packageSize', 'sourcePriceMinor', 'upc', 'retailerCode', 'imageSha256']

function accountPrefix(accountId: string): string {
  if (!accountId || accountId.length > 200 || accountId.trim() !== accountId) throw new Error('IMAGE_PENDING_ACCOUNT_INVALID')
  return `${PENDING_IMAGE_PREFIX}${encodeURIComponent(accountId)}:`
}

function pendingStorage(storage?: PendingStorage): PendingStorage {
  if (storage) return storage
  try { return localStorage }
  catch { throw new Error('IMAGE_PENDING_STORAGE_UNAVAILABLE') }
}

function verifiedStoredAttempt(raw: string, accountId: string, key: string): StoredImageAttempt {
  if (raw.length > 196_608) throw new Error('IMAGE_PENDING_INVALID')
  let stored: unknown
  try { stored = JSON.parse(raw) }
  catch { throw new Error('IMAGE_PENDING_INVALID') }
  if (!record(stored) || stored.version !== 1 || stored.accountId !== accountId || typeof stored.createdAt !== 'string'
    || !Number.isFinite(Date.parse(stored.createdAt)) || !record(stored.payload)
    || Object.keys(stored).length !== 4 || Object.keys(stored.payload).length !== PENDING_PAYLOAD_KEYS.length + ('productImage' in stored.payload ? 1 : 0)) throw new Error('IMAGE_PENDING_INVALID')
  const payload = stored.payload
  if (PENDING_PAYLOAD_KEYS.some((field) => !(field in payload))) throw new Error('IMAGE_PENDING_INVALID')
  if (payload.confirmed !== true || typeof payload.operationId !== 'string' || typeof payload.name !== 'string'
    || !nullableText(payload.brand) || !nullableText(payload.packageSize) || !nullableText(payload.upc) || !nullableText(payload.retailerCode)
    || !nullablePrice(payload.sourcePriceMinor) || !(payload.imageSha256 === null || typeof payload.imageSha256 === 'string')
    || 'productImage' in payload && !isCroppedProductImage(payload.productImage)) throw new Error('IMAGE_PENDING_INVALID')
  let attempt: ImageImportAttempt
  try {
    attempt = createImageImportAttempt({
      name: payload.name, brand: payload.brand ?? '', packageSize: payload.packageSize ?? '',
      sourcePrice: payload.sourcePriceMinor === null ? '' : (payload.sourcePriceMinor / 100).toFixed(2),
      upc: payload.upc ?? '', retailerCode: payload.retailerCode ?? '',
    }, payload.imageSha256, payload.operationId, payload.productImage as CroppedProductImage | undefined)
  } catch { throw new Error('IMAGE_PENDING_INVALID') }
  if (PENDING_PAYLOAD_KEYS.some((field) => payload[field] !== attempt.payload[field as keyof ImageImportPayload])
    || JSON.stringify(payload.productImage) !== JSON.stringify(attempt.payload.productImage)
    || key !== `${accountPrefix(accountId)}${attempt.payload.operationId}`) throw new Error('IMAGE_PENDING_INVALID')
  return { version: 1, accountId, createdAt: stored.createdAt, payload: attempt.payload }
}

function storedAccountAttempts(accountId: string, storage: PendingStorage): StoredImageAttempt[] {
  const prefix = accountPrefix(accountId)
  const records: StoredImageAttempt[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix)) continue
    const value = storage.getItem(key)
    if (value !== null) records.push(verifiedStoredAttempt(value, accountId, key))
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.payload.operationId.localeCompare(b.payload.operationId))
}

/** Only confirmed fields, UUID and the final small crop are durable. Never store the original screenshot or preview URL. */
export function loadPendingImageAttempt(accountId: string, storage?: PendingStorage): ImageImportAttempt | null {
  const pending = storedAccountAttempts(accountId, pendingStorage(storage))[0]
  return pending ? Object.freeze({ payload: pending.payload }) : null
}

export function persistPendingImageAttempt(accountId: string, attempt: ImageImportAttempt, storage?: PendingStorage): void {
  const target = pendingStorage(storage)
  const prefix = accountPrefix(accountId)
  const key = `${prefix}${attempt.payload.operationId}`
  const existing = storedAccountAttempts(accountId, target)
  const own = existing.find((entry) => entry.payload.operationId === attempt.payload.operationId)
  if (existing.some((entry) => entry.payload.operationId !== attempt.payload.operationId)) throw new Error('IMAGE_PENDING_OTHER_OPERATION')
  if (own) {
    if (JSON.stringify(own.payload) !== JSON.stringify(attempt.payload)) throw new Error('IMAGE_PENDING_PAYLOAD_CONFLICT')
    return
  }
  const stored: StoredImageAttempt = { version: 1, accountId, createdAt: new Date().toISOString(), payload: attempt.payload }
  const raw = JSON.stringify(stored)
  // Validate the exact whitelist before writing even if a caller bypasses TS.
  verifiedStoredAttempt(raw, accountId, key)
  target.setItem(key, raw)
  if (target.getItem(key) !== raw) throw new Error('IMAGE_PENDING_STORAGE_UNAVAILABLE')
}

export function clearPendingImageAttempt(accountId: string, operationId: string, storage?: PendingStorage): void {
  const target = pendingStorage(storage)
  const key = `${accountPrefix(accountId)}${operationId}`
  const raw = target.getItem(key)
  if (raw === null) return
  const stored = verifiedStoredAttempt(raw, accountId, key)
  if (stored.payload.operationId !== operationId) throw new Error('IMAGE_PENDING_PAYLOAD_CONFLICT')
  target.removeItem(key)
  if (target.getItem(key) !== null) throw new Error('IMAGE_PENDING_STORAGE_UNAVAILABLE')
}

/** A failed storage write throws before transport is called, so an unknown receipt always has a durable UUID. */
export async function requestPersistedImageConfirmation(
  accountId: string, attempt: ImageImportAttempt, send: (init: RequestInit) => Promise<Response>, options: RequestOptions = {}, storage?: PendingStorage,
): Promise<ImageSaveResult> {
  persistPendingImageAttempt(accountId, attempt, storage)
  return requestImageConfirmation(attempt, send, options)
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function nullableText(value: unknown): value is string | null { return value === null || (typeof value === 'string' && value.length <= 2000) }
function nullablePrice(value: unknown): value is number | null { return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000) }
function validDraft(value: unknown): value is ImageDraft {
  return record(value) && nullableText(value.name) && nullableText(value.brand) && nullableText(value.packageSize)
    && nullablePrice(value.sourcePriceMinor) && nullableText(value.upc) && nullableText(value.retailerCode)
}
function confirmedProduct(value: unknown): value is ConfirmedImageProduct {
  return record(value) && typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.sku === 'string' && value.sku.trim().length > 0 && typeof value.name === 'string' && value.name.trim().length > 0
    && nullableText(value.upc) && nullableText(value.brand) && nullableText(value.packageSize) && nullableText(value.imageUrl)
    && (value.source === 'smartcart' || value.source === 'bigc') && nullablePrice(value.sourcePriceMinor) && nullablePrice(value.regularPriceMinor)
    && (value.fetchedAt === null || (typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt))))
}

function errorCode(payload: unknown): string | undefined {
  const code = record(payload) && record(payload.error) ? payload.error.code : undefined
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : undefined
}

const imageErrors: Record<string, { message: string; retryable: boolean }> = {
  IMAGE_TOO_LARGE: { message: 'ภาพใหญ่เกินไป กรุณาครอปเฉพาะสินค้าแล้วเลือกใหม่', retryable: false },
  IMAGE_UNSUPPORTED: { message: 'ไฟล์ภาพนี้ยังไม่รองรับ กรุณาเลือก JPG, PNG หรือ WebP', retryable: false },
  IMAGE_UNREADABLE: { message: 'อ่านข้อมูลจากภาพไม่ได้ กรุณาใช้ภาพที่ชัดขึ้น หรือกดกรอกข้อมูลจากภาพเอง', retryable: true },
  IMAGE_AI_UNAVAILABLE: { message: 'ระบบอ่านภาพยังไม่พร้อม กรุณาลองอีกครั้ง หรือกรอกข้อมูลจากภาพเอง', retryable: true },
  IMAGE_QUOTA_EXCEEDED: { message: 'ถึงโควตาอ่านภาพแล้ว กรุณาลองภายหลัง หรือกรอกข้อมูลจากภาพเอง', retryable: false },
  INVALID_IMAGE_PRODUCT: { message: 'ข้อมูลสินค้ายังไม่ถูกต้อง กรุณาตรวจสอบช่องข้อมูลก่อนยืนยันอีกครั้ง', retryable: false },
  UNAUTHENTICATED: { message: 'กรุณาเข้าสู่ระบบใหม่ก่อนอ่านหรือบันทึกสินค้า', retryable: false },
  UNTRUSTED_ORIGIN: { message: 'ระบบไม่อนุญาตคำขอนี้ กรุณาเปิด SmartCart จากหน้าเว็บหลัก', retryable: false },
}

class RequestStop extends Error { constructor(readonly kind: 'cancelled' | 'timeout') { super(kind) } }

async function sendJson(
  send: (init: RequestInit) => Promise<Response>, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal,
): Promise<{ response: Response; payload: unknown }> {
  if (externalSignal?.aborted) throw new RequestStop('cancelled')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      stop = () => { controller.abort(); reject(new RequestStop('cancelled')) }
      externalSignal?.addEventListener('abort', stop, { once: true })
      timer = setTimeout(() => { controller.abort(); reject(new RequestStop('timeout')) }, timeoutMs)
    })
    const operation = (async () => {
      const response = await send({ ...init, signal: controller.signal })
      const payload: unknown = await response.json()
      return { response, payload }
    })()
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
    if (stop) externalSignal?.removeEventListener('abort', stop)
  }
}

export async function requestImageExtraction(
  blob: Blob, send: (init: RequestInit) => Promise<Response>, options: RequestOptions = {},
): Promise<ExtractionResult> {
  if (!IMAGE_TYPES.has(blob.type) || blob.size > MAX_UPLOAD_IMAGE_BYTES || blob.size === 0) {
    return { status: 'error', code: blob.size > MAX_UPLOAD_IMAGE_BYTES ? 'IMAGE_TOO_LARGE' : 'IMAGE_UNSUPPORTED', message: 'ภาพที่เตรียมแล้วยังไม่ถูกต้อง กรุณาเลือกภาพใหม่', retryable: false }
  }
  try {
    const { response, payload } = await sendJson(send, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob }, options.timeoutMs ?? 60_000, options.signal)
    if (!response.ok) {
      const code = errorCode(payload)
      const known = code ? imageErrors[code] : undefined
      return { status: 'error', code, ...(known ?? { message: 'ยังอ่านภาพไม่สำเร็จ ยังไม่มีการสร้างสินค้า คุณสามารถลองใหม่หรือกรอกข้อมูลเอง', retryable: true }) }
    }
    const data = record(payload) && record(payload.data) ? payload.data : null
    if (!data || !validDraft(data.draft) || typeof data.imageSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(data.imageSha256)
      || !Array.isArray(data.warnings) || data.warnings.some((value) => typeof value !== 'string')) {
      return { status: 'error', message: 'ผลอ่านภาพยังไม่ครบถ้วน กรุณาลองใหม่หรือกรอกข้อมูลจากภาพเอง ยังไม่มีการสร้างสินค้า', retryable: true, code: 'INVALID_RESPONSE' }
    }
    const draft = { ...data.draft }
    if ('productImageBounds' in draft && !validCropBounds(draft.productImageBounds)) delete draft.productImageBounds
    return { status: 'success', draft, imageSha256: data.imageSha256.toLowerCase(), warnings: (data.warnings as string[]).slice(0, 20).map((value) => value.slice(0, 500)) }
  } catch (error) {
    if (error instanceof RequestStop && error.kind === 'cancelled') return { status: 'cancelled' }
    return { status: 'error', message: error instanceof RequestStop
      ? 'รออ่านภาพนานเกินไป ยังไม่มีการสร้างสินค้า ลองอีกครั้งหรือกรอกข้อมูลจากภาพเองได้'
      : 'เชื่อมต่อระบบอ่านภาพไม่สำเร็จ ยังไม่มีการสร้างสินค้า ลองอีกครั้งหรือกรอกข้อมูลจากภาพเองได้', retryable: true, code: error instanceof RequestStop ? 'IMAGE_TIMEOUT' : 'CONNECTION_INTERRUPTED' }
  }
}

export async function requestImageConfirmation(
  attempt: ImageImportAttempt, send: (init: RequestInit) => Promise<Response>, options: RequestOptions = {},
): Promise<ImageSaveResult> {
  try {
    const { response, payload } = await sendJson(send, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt.payload) }, options.timeoutMs ?? 15_000, options.signal)
    if (!response.ok) {
      const code = errorCode(payload)
      // Authentication/origin failures on a retry do not prove an earlier write
      // was rolled back. Keep the durable UUID until its receipt is verified.
      if (response.status === 401 || code === 'UNAUTHENTICATED') return { status: 'uncertain', code: code ?? 'UNAUTHENTICATED', message: 'กรุณาเข้าสู่ระบบด้วยบัญชีเดิม แล้วตรวจสอบด้วยรหัสรายการเดิม สินค้าอาจถูกบันทึกแล้ว' }
      if (response.status === 403 || code === 'UNTRUSTED_ORIGIN') return { status: 'uncertain', code: code ?? 'UNTRUSTED_ORIGIN', message: 'คำขอนี้ไม่ได้รับอนุญาต โปรดเปิด SmartCart จากหน้าเว็บหลัก แล้วตรวจสอบด้วยรหัสรายการเดิม' }
      if (code === 'INVALID_IMAGE_PRODUCT' && (response.status === 400 || response.status === 422)) return { status: 'error', code, ...imageErrors.INVALID_IMAGE_PRODUCT }
      if ((code === 'PRODUCT_IMAGE_INVALID' && response.status === 400) || (code === 'PRODUCT_IMAGE_TOO_LARGE' && response.status === 413)) {
        const error = record(payload) && record(payload.error) ? payload.error : null
        const reason = productImageFailureReason(error?.reason)
        if (error && 'reason' in error && !reason) return { status: 'uncertain', code: 'INVALID_RESPONSE', message: 'ระบบตอบกลับการตรวจรูปไม่สมบูรณ์ ยังยืนยันผลไม่ได้ กรุณาตรวจด้วยรหัสรายการเดิม' }
        return { status: 'error', code, ...(reason ? { reason } : {}), message: productImageFailureMessage(code, reason), retryable: false }
      }
      return { status: 'uncertain', code, message: code === 'IMAGE_IMPORT_CONFLICT'
        ? 'รหัสรายการนี้มีข้อมูลที่ไม่ตรงกัน จึงยังยืนยันผลไม่ได้ ห้ามส่งเป็นสินค้าใหม่ กรุณาตรวจสอบรายการเดิม'
        : 'ระบบตอบกลับไม่สมบูรณ์ สินค้าอาจถูกบันทึกแล้ว กรุณาตรวจสอบด้วยข้อมูลและรหัสรายการเดิม' }
    }
    if (!record(payload) || !confirmedProduct(payload.data)) return { status: 'uncertain', code: 'INVALID_RESPONSE', message: 'ยังไม่ได้รับสินค้าและ SKU ที่ยืนยันได้ สินค้าอาจถูกบันทึกแล้ว กรุณาตรวจสอบรายการเดิม' }
    return { status: 'success', product: payload.data }
  } catch (error) {
    if (error instanceof RequestStop && error.kind === 'cancelled') return { status: 'cancelled' }
    return { status: 'uncertain', code: error instanceof RequestStop ? 'IMAGE_SAVE_TIMEOUT' : 'CONNECTION_INTERRUPTED', message: 'ยังยืนยันผลการบันทึกไม่ได้ สินค้าอาจถูกบันทึกแล้ว กรุณาตรวจสอบด้วยปุ่มเดิม ระบบจะใช้รหัสรายการเดิม' }
  }
}

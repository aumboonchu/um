import type { CachedProduct } from './offline'

export type BigcImportState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; product: { name: string; sku: string } }
  | { status: 'error'; title: string; message: string; code?: string; retryable: boolean }
  | { status: 'uncertain'; message: string; code?: string }

type ImportResult =
  | { status: 'success'; product: CachedProduct & { sku: string } }
  | Extract<BigcImportState, { status: 'error' | 'uncertain' }>

export function validateBigcImportUrl(value: string): string | null {
  if (!value.trim()) return 'กรุณาวางลิงก์หน้าสินค้า Big C ก่อนกดเพิ่มสินค้า'
  if (value.length > 2048) return 'ลิงก์ยาวเกินไป กรุณาคัดลอกลิงก์หน้าสินค้า Big C อีกครั้ง'
  let url: URL
  try { url = new URL(value.trim()) }
  catch { return 'ลิงก์ไม่ถูกต้อง กรุณาวางลิงก์หน้าสินค้า Big C แบบเต็ม' }
  if (url.protocol !== 'https:' || url.hostname !== 'www.bigc.co.th' || url.port || url.username || url.password
    || !/^(?:\/en)?\/product\/[^/]+\.\d+\/?$/.test(url.pathname)) {
    return 'ใช้ลิงก์หน้าสินค้า https://www.bigc.co.th/product/… เท่านั้น ไม่ใช่ลิงก์ค้นหาหรือลิงก์ย่อ'
  }
  return null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function nullablePrice(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function confirmedProduct(value: unknown): value is CachedProduct & { sku: string } {
  return record(value)
    && typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.sku === 'string' && value.sku.trim().length > 0
    && typeof value.name === 'string' && value.name.trim().length > 0
    && nullableString(value.upc) && nullableString(value.brand) && nullableString(value.packageSize)
    && nullableString(value.imageUrl)
    && (value.source === 'bigc' || value.source === 'smartcart')
    && nullablePrice(value.sourcePriceMinor) && nullablePrice(value.regularPriceMinor)
    && (value.fetchedAt === null || (typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt))))
}

function confirmedFailure(status: number, payload: unknown): ImportResult {
  const error = record(payload) && record(payload.error) ? payload.error : null
  const code = error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : undefined
  const messages: Record<string, { message: string; retryable: boolean }> = {
    BIGC_BLOCKED: {
      message: 'Big C ไม่อนุญาตให้ระบบอ่านข้อมูลสินค้า จึงยังไม่ได้สร้าง SKU จากลิงก์นี้ คุณสามารถใช้ UPC / เพิ่มเองแทนได้',
      retryable: false,
    },
    BIGC_PRODUCT_NOT_FOUND: { message: 'ไม่พบสินค้าที่ลิงก์นี้ กรุณาตรวจสอบหรือคัดลอกลิงก์หน้าสินค้าใหม่', retryable: false },
    BIGC_PRODUCT_DATA_MISSING: { message: 'หน้าสินค้ามีข้อมูลไม่เพียงพอให้ยืนยันสินค้า จึงยังไม่บันทึก กรุณาใช้ UPC / เพิ่มเอง', retryable: false },
    BIGC_UPC_CONFLICT: { message: 'ข้อมูลบาร์โค้ดขัดแย้งกับสินค้าในระบบ จึงยังไม่นำเข้า กรุณาตรวจสอบสินค้า', retryable: false },
    BIGC_UNAVAILABLE: { message: 'ยังอ่านข้อมูลจาก Big C ไม่สำเร็จ จึงยังไม่นำเข้า กรุณาลองใหม่ภายหลัง', retryable: true },
    INVALID_BIGC_URL: { message: 'ลิงก์นี้ไม่ใช่หน้าสินค้า Big C ที่รองรับ กรุณาคัดลอกลิงก์หน้าสินค้าแบบเต็ม', retryable: false },
    INVALID_IMPORT: { message: 'ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบลิงก์ก่อนลองใหม่', retryable: false },
  }
  const known = code ? messages[code] : undefined
  if (known) return { status: 'error', title: 'ยังไม่ได้เพิ่มสินค้า', code, ...known }
  if (status === 401) return { status: 'error', title: 'ยังไม่ได้เพิ่มสินค้า', message: 'การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบด้วย Google อีกครั้งก่อนนำเข้า', code: 'LOGIN_REQUIRED', retryable: false }
  if (status === 403) return { status: 'error', title: 'ยังไม่ได้เพิ่มสินค้า', message: 'ระบบไม่อนุญาตคำขอนี้ กรุณาเปิด SmartCart จากหน้าเว็บหลักแล้วลองใหม่', code: 'REQUEST_DENIED', retryable: false }
  if (status === 429) return { status: 'error', title: 'ยังไม่ได้เพิ่มสินค้า', message: 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', code: 'RATE_LIMITED', retryable: true }
  // An unexpected server failure may happen after a write. Do not assert that nothing was saved.
  return { status: 'uncertain', message: 'ระบบตอบกลับไม่สมบูรณ์ จึงยังยืนยันไม่ได้ว่าสินค้าถูกบันทึกหรือไม่ ตรวจสอบด้วยลิงก์เดิมได้โดยระบบจะใช้ SKU เดิม', code }
}

export async function requestBigcImport(
  url: string,
  send: (init: RequestInit) => Promise<Response>,
  timeoutMs = 15_000,
): Promise<ImportResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const operation = (async (): Promise<ImportResult> => {
      const response = await send({
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }), signal: controller.signal,
      })
      const payload: unknown = await response.json()
      if (!response.ok) return confirmedFailure(response.status, payload)
      if (!record(payload) || !confirmedProduct(payload.data)) {
        return { status: 'uncertain', message: 'ระบบยังไม่ได้ส่งข้อมูลสินค้าและ SKU ที่ยืนยันได้ จึงยังไม่แสดงว่าสำเร็จ กรุณาตรวจสอบด้วยลิงก์เดิม', code: 'INVALID_RESPONSE' }
      }
      return { status: 'success', product: payload.data }
    })()
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new Error('IMPORT_TIMEOUT'))
      }, timeoutMs)
    })
    return await Promise.race([operation, deadline])
  } catch {
    return {
      status: 'uncertain',
      message: timedOut
        ? 'รอการตอบกลับนานเกินไป จึงยังยืนยันผลไม่ได้ ลองตรวจสอบด้วยลิงก์เดิม ระบบจะไม่สร้าง SKU ซ้ำสำหรับลิงก์เดิม'
        : 'การเชื่อมต่อขาดหายหรือคำตอบไม่สมบูรณ์ จึงยังยืนยันผลไม่ได้ เมื่อออนไลน์แล้วให้ตรวจสอบด้วยลิงก์เดิม',
      code: timedOut ? 'IMPORT_TIMEOUT' : 'CONNECTION_INTERRUPTED',
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}


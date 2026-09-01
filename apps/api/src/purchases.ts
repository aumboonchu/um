import type { AuthEnv } from './auth'

export type PurchaseInput = {
  productId: string
  unitPriceMinor: number
  quantity: number
  purchasedAt: string
  note: string | null
  storeName: string | null
}

export type Purchase = {
  id: string
  productId: string
  storeId: string | null
  unitPriceMinor: number
  quantity: number
  totalMinor: number
  purchasedAt: string
  note: string | null
}

export class PurchaseInputError extends Error {
  constructor() {
    super('INVALID_PURCHASE')
  }
}

export class PurchaseProductNotFoundError extends Error {
  constructor() {
    super('PRODUCT_NOT_FOUND')
  }
}

export async function createPurchase(
  request: Request,
  userId: string,
  env: AuthEnv,
): Promise<Purchase> {
  return createPurchaseFromInput(parsePurchaseInput(await readJsonBody(request, 10 * 1024)), userId, env)
}

export async function createPurchaseFromPayload(
  payload: unknown,
  userId: string,
  env: AuthEnv,
  purchaseId?: string,
): Promise<Purchase> {
  return createPurchaseFromInput(parsePurchaseInput(payload), userId, env, purchaseId)
}

async function createPurchaseFromInput(
  input: PurchaseInput,
  userId: string,
  env: AuthEnv,
  purchaseId?: string,
): Promise<Purchase> {
  const product = await env.DB.prepare('SELECT id FROM products WHERE id = ? LIMIT 1').bind(input.productId).first()
  if (!product) throw new PurchaseProductNotFoundError()

  const storeId = input.storeName ? await findOrCreateStore(input.storeName, userId, env) : null
  const purchase: Purchase = {
    id: purchaseId ?? crypto.randomUUID(),
    productId: input.productId,
    storeId,
    unitPriceMinor: input.unitPriceMinor,
    quantity: input.quantity,
    totalMinor: Math.round(input.unitPriceMinor * input.quantity),
    purchasedAt: input.purchasedAt,
    note: input.note,
  }

  if (!Number.isSafeInteger(purchase.totalMinor) || purchase.totalMinor <= 0) {
    throw new PurchaseInputError()
  }

  await env.DB.prepare(
    `INSERT INTO purchases
      (id, user_id, product_id, store_id, unit_price_minor, quantity, total_minor, purchased_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      purchase.id,
      userId,
      purchase.productId,
      purchase.storeId,
      purchase.unitPriceMinor,
      purchase.quantity,
      purchase.totalMinor,
      purchase.purchasedAt,
      purchase.note,
    )
    .run()

  return purchase
}

async function findOrCreateStore(name: string, userId: string, env: AuthEnv): Promise<string> {
  const existing = await env.DB.prepare(
    'SELECT id FROM stores WHERE user_id = ? AND name = ? LIMIT 1',
  )
    .bind(userId, name)
    .first<{ id: string }>()
  if (existing) return existing.id

  const storeId = crypto.randomUUID()
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      'INSERT INTO stores (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(storeId, userId, name, now, now)
      .run()
    return storeId
  } catch (error) {
    const concurrentStore = await env.DB.prepare(
      'SELECT id FROM stores WHERE user_id = ? AND name = ? LIMIT 1',
    )
      .bind(userId, name)
      .first<{ id: string }>()
    if (concurrentStore) return concurrentStore.id
    throw error
  }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new PurchaseInputError()
  if (!request.body) throw new PurchaseInputError()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new PurchaseInputError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new PurchaseInputError()
  }
}

function parsePurchaseInput(value: unknown): PurchaseInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PurchaseInputError()
  const record = value as Record<string, unknown>
  const productId = stringValue(record.productId, 36)
  const unitPriceMinor = positiveInteger(record.unitPriceMinor, 1_000_000_00)
  const quantity = positiveNumber(record.quantity, 10_000)
  const purchasedAt = parseDate(record.purchasedAt)
  const note = optionalString(record.note, 500)
  const storeName = optionalString(record.storeName, 80)

  if (!productId || unitPriceMinor === null || quantity === null || !purchasedAt) {
    throw new PurchaseInputError()
  }
  return { productId, unitPriceMinor, quantity, purchasedAt, note, storeName }
}

function stringValue(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= maxLength ? value.trim() : null
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null
  return stringValue(value, maxLength)
}

function positiveInteger(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null
}

function positiveNumber(value: unknown, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum ? value : null
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}


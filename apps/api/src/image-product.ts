import { currentAccount, isTrustedOrigin, type AuthEnv } from './auth'
import type { Product } from './products'

type ConfirmedImageInput = {
  operationId: string
  name: string
  brand: string | null
  packageSize: string | null
  sourcePriceMinor: number | null
  upc: string | null
  retailerCode: string | null
  imageSha256: string | null
}

type ImportReceipt = { payload_hash: string; product_id: string }
type ProductRow = {
  id: string; sku: string; upc: string | null; name: string; brand: string | null
  package_size: string | null; unit: string | null; category: string | null; image_url: string | null
  source: string | null; source_product_id: string | null; source_url: string | null
  source_price_minor: number | null; regular_price_minor: number | null; fetched_at: string | null
}

export class ImageProductError extends Error {
  constructor(
    public readonly code: 'UNAUTHENTICATED' | 'UNTRUSTED_ORIGIN' | 'INVALID_IMAGE_PRODUCT' | 'IMAGE_IMPORT_CONFLICT',
    public readonly status: 400 | 401 | 403 | 409,
    public readonly retryable = false,
  ) { super(code) }
}

/** Only user-confirmed fields reach D1. Extraction itself never calls this function. */
export async function confirmImageProduct(request: Request, env: AuthEnv): Promise<{ product: Product; created: boolean }> {
  if (!isTrustedOrigin(request, env)) throw new ImageProductError('UNTRUSTED_ORIGIN', 403)
  const account = await currentAccount(request, env)
  if (!account) throw new ImageProductError('UNAUTHENTICATED', 401)
  const input = parseInput(await readJson(request))
  // Fixed property order and normalized scalar values make retries deterministic.
  const { operationId: _, ...confirmedFields } = input
  const payloadHash = await sha256Hex(JSON.stringify(confirmedFields))

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const receipt = await findReceipt(account.id, input.operationId, env)
    if (receipt) return replayReceipt(receipt, payloadHash, env)

    const fingerprint = input.imageSha256
      ? await env.DB.prepare(`SELECT product_id FROM product_image_fingerprints
          WHERE user_id = ? AND image_sha256 = ? AND payload_hash = ?`)
        .bind(account.id, input.imageSha256, payloadHash).first<{ product_id: string }>()
      : null
    const existingUpc = !fingerprint && input.upc
      ? await env.DB.prepare('SELECT id FROM products WHERE upc = ? LIMIT 1').bind(input.upc).first<{ id: string }>()
      : null
    const productId = fingerprint?.product_id ?? existingUpc?.id ?? crypto.randomUUID()
    const created = !fingerprint && !existingUpc
    const now = new Date().toISOString()
    const statements: D1PreparedStatement[] = []
    if (created) {
      statements.push(env.DB.prepare(`INSERT INTO products
        (id, sku, upc, name, brand, package_size, unit, category, image_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
        .bind(productId, `IMG-${productId}`, input.upc, input.name, input.brand, input.packageSize, now, now))
    }
    if (input.imageSha256 && !fingerprint) {
      statements.push(env.DB.prepare(`INSERT INTO product_image_fingerprints
        (user_id, image_sha256, payload_hash, product_id) VALUES (?, ?, ?, ?)`)
        .bind(account.id, input.imageSha256, payloadHash, productId))
    }
    statements.push(env.DB.prepare(`INSERT INTO product_image_imports
      (user_id, operation_id, payload_hash, product_id, retailer_code, image_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(account.id, input.operationId, payloadHash, productId, input.retailerCode, input.imageSha256, now))
    if (!fingerprint) {
      // A retailer code shown in a screenshot is NOT a verified Big C URL ID or GTIN.
      // Store that code only in the account's receipt, never a global source mapping.
      statements.push(env.DB.prepare(`INSERT INTO product_source_snapshots
        (id, product_id, source, source_product_id, source_url, source_price_minor,
         regular_price_minor, availability, fetched_at)
        VALUES (?, ?, 'user_image', NULL, NULL, ?, NULL, 'unknown', ?)`)
        .bind(crypto.randomUUID(), productId, input.sourcePriceMinor, now))
    }
    try {
      // Product, fingerprint, receipt and snapshot either commit together or roll back.
      await env.DB.batch(statements)
      return { product: await loadProduct(productId, env), created }
    } catch (error) {
      const concurrentReceipt = await findReceipt(account.id, input.operationId, env)
      if (concurrentReceipt) return replayReceipt(concurrentReceipt, payloadHash, env)
      // A concurrent fingerprint/GTIN insert may have won. Retry only a proven race.
      const concurrentFingerprint = input.imageSha256
        ? await env.DB.prepare(`SELECT product_id FROM product_image_fingerprints
            WHERE user_id = ? AND image_sha256 = ? AND payload_hash = ?`)
          .bind(account.id, input.imageSha256, payloadHash).first()
        : null
      const concurrentUpc = input.upc
        ? await env.DB.prepare('SELECT id FROM products WHERE upc = ? LIMIT 1').bind(input.upc).first()
        : null
      if (attempt === 2 || (!concurrentFingerprint && !concurrentUpc)) throw error
    }
  }
  throw new Error('Image import did not complete')
}

async function findReceipt(userId: string, operationId: string, env: AuthEnv): Promise<ImportReceipt | null> {
  return env.DB.prepare(`SELECT payload_hash, product_id FROM product_image_imports
    WHERE user_id = ? AND operation_id = ?`).bind(userId, operationId).first<ImportReceipt>()
}

async function replayReceipt(receipt: ImportReceipt, payloadHash: string, env: AuthEnv): Promise<{ product: Product; created: false }> {
  if (receipt.payload_hash !== payloadHash) throw new ImageProductError('IMAGE_IMPORT_CONFLICT', 409)
  return { product: await loadProduct(receipt.product_id, env), created: false }
}

async function loadProduct(id: string, env: AuthEnv): Promise<Product> {
  const row = await env.DB.prepare(`SELECT p.id, p.sku, p.upc, p.name, p.brand, p.package_size,
      p.unit, p.category, p.image_url, s.source, s.source_product_id, s.source_url,
      s.source_price_minor, s.regular_price_minor, s.fetched_at
    FROM products p LEFT JOIN product_source_snapshots s ON s.id = (
      SELECT id FROM product_source_snapshots WHERE product_id = p.id
      ORDER BY fetched_at DESC, id DESC LIMIT 1)
    WHERE p.id = ? LIMIT 1`).bind(id).first<ProductRow>()
  if (!row) throw new Error('Confirmed image product could not be loaded')
  return {
    id: row.id, sku: row.sku, upc: row.upc, name: row.name, brand: row.brand,
    packageSize: row.package_size, unit: row.unit, category: row.category, imageUrl: row.image_url,
    source: row.source === 'bigc' ? 'bigc' : 'smartcart',
    sourceProductId: row.source === 'bigc' ? row.source_product_id : null,
    sourceUrl: row.source_url, sourcePriceMinor: row.source_price_minor,
    regularPriceMinor: row.regular_price_minor, fetchedAt: row.fetched_at,
  }
}

function parseInput(value: unknown): ConfirmedImageInput {
  if (!isRecord(value) || value.confirmed !== true) invalid()
  const allowed = new Set(['operationId', 'confirmed', 'name', 'brand', 'packageSize', 'sourcePriceMinor', 'upc', 'retailerCode', 'imageSha256'])
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid()
  const operationId = requiredText(value.operationId, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) invalid()
  const upc = optionalText(value.upc, 14)
  if (upc && !validGtin(upc)) invalid()
  const imageSha256 = optionalText(value.imageSha256, 64)
  if (imageSha256 && !/^[0-9a-f]{64}$/i.test(imageSha256)) invalid()
  const sourcePriceMinor = value.sourcePriceMinor === undefined || value.sourcePriceMinor === null
    ? null : value.sourcePriceMinor
  if (sourcePriceMinor !== null && (typeof sourcePriceMinor !== 'number'
    || !Number.isSafeInteger(sourcePriceMinor) || sourcePriceMinor < 0 || sourcePriceMinor > 100_000_000)) invalid()
  return {
    operationId: operationId.toLowerCase(), name: requiredText(value.name, 200),
    brand: optionalText(value.brand, 100), packageSize: optionalText(value.packageSize, 100),
    sourcePriceMinor, upc, retailerCode: optionalText(value.retailerCode, 80),
    imageSha256: imageSha256?.toLowerCase() ?? null,
  }
}

function validGtin(value: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value) || /^(\d)\1+$/.test(value)) return false
  let sum = 0
  for (let index = value.length - 2, weight = 3; index >= 0; index -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(value[index]) * weight
  }
  return (10 - sum % 10) % 10 === Number(value.at(-1))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value: unknown, limit: number): string {
  const text = optionalText(value, limit)
  if (!text) invalid()
  return text
}

function optionalText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) invalid()
  return value.trim() || null
}

function invalid(): never { throw new ImageProductError('INVALID_IMAGE_PRODUCT', 400) }

async function readJson(request: Request): Promise<unknown> {
  const limit = 10 * 1024
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')
    || Number(request.headers.get('content-length')) > limit || !request.body) invalid()
  const reader = request.body.getReader()
  let size = 0
  let text = ''
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        invalid()
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  try { return JSON.parse(text) } catch { return invalid() }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

import type { AuthEnv } from './auth'

type ProductRow = {
  id: string
  upc: string
  name: string
  brand: string | null
  package_size: string | null
  unit: string | null
  category: string | null
  image_url: string | null
  source: string | null
  source_url: string | null
  source_price_minor: number | null
  regular_price_minor: number | null
  fetched_at: string | null
}

type ProductCandidate = {
  name: string
  brand: string | null
  packageSize: string | null
  unit: string | null
  category: string | null
  imageUrl: string | null
  sourceProductId: string | null
  sourceUrl: string
  sourcePriceMinor: number | null
  regularPriceMinor: number | null
}

export type Product = {
  id: string
  upc: string
  name: string
  brand: string | null
  packageSize: string | null
  unit: string | null
  category: string | null
  imageUrl: string | null
  source: 'smartcart' | 'bigc'
  sourceUrl: string | null
  sourcePriceMinor: number | null
  regularPriceMinor: number | null
  fetchedAt: string | null
}

export class ProductLookupError extends Error {
  constructor(
    public readonly code: 'INVALID_UPC' | 'PRODUCT_NOT_FOUND' | 'BIGC_UNAVAILABLE',
    public readonly status: 400 | 404 | 502,
    public readonly retryable: boolean,
  ) {
    super(code)
  }
}

export class ManualProductInputError extends Error {
  constructor() {
    super('INVALID_PRODUCT')
  }
}

const BIGC_SEARCH_ORIGIN = 'https://www.bigc.co.th'
const BIGC_SEARCH_TIMEOUT_MS = 8_000
const MAX_BIGC_DOCUMENT_BYTES = 512 * 1024

export async function lookupProductByUpc(upc: string, env: AuthEnv): Promise<Product> {
  if (!isValidUpc(upc)) {
    throw new ProductLookupError('INVALID_UPC', 400, false)
  }

  const cached = await findProduct(upc, env)
  if (cached) return cached

  const candidate = await lookupBigC(upc)
  if (!candidate) {
    throw new ProductLookupError('PRODUCT_NOT_FOUND', 404, false)
  }

  try {
    await insertImportedProduct(upc, candidate, env)
  } catch (error) {
    const concurrentProduct = await findProduct(upc, env)
    if (concurrentProduct) return concurrentProduct
    throw error
  }

  const imported = await findProduct(upc, env)
  if (!imported) throw new Error('Imported product could not be loaded')
  return imported
}

export async function createManualProduct(request: Request, env: AuthEnv): Promise<Product> {
  const input = parseManualProductInput(await readJsonBody(request, 10 * 1024))
  const existing = await findProduct(input.upc, env)
  if (existing) return existing

  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      `INSERT INTO products
        (id, upc, name, brand, package_size, unit, category, image_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(crypto.randomUUID(), input.upc, input.name, input.brand, now, now)
      .run()
  } catch (error) {
    const concurrentProduct = await findProduct(input.upc, env)
    if (concurrentProduct) return concurrentProduct
    throw error
  }

  const product = await findProduct(input.upc, env)
  if (!product) throw new Error('Manual product could not be loaded')
  return product
}

export function isValidUpc(value: string): boolean {
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)
}

export function parseBigCProductDocument(document: string, upc: string, searchUrl: string): ProductCandidate | null {
  for (const json of jsonScripts(document)) {
    const candidate = findProductCandidate(json, upc, searchUrl)
    if (candidate) return candidate
  }
  return null
}

async function findProduct(upc: string, env: AuthEnv): Promise<Product | null> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.upc, p.name, p.brand, p.package_size, p.unit, p.category, p.image_url,
            s.source, s.source_url, s.source_price_minor, s.regular_price_minor, s.fetched_at
       FROM products p
       LEFT JOIN product_source_snapshots s ON s.id = (
         SELECT id FROM product_source_snapshots
          WHERE product_id = p.id
          ORDER BY fetched_at DESC, id DESC
          LIMIT 1
       )
      WHERE p.upc = ?
      LIMIT 1`,
  )
    .bind(upc)
    .first<ProductRow>()

  return row ? toProduct(row) : null
}

async function lookupBigC(upc: string): Promise<ProductCandidate | null> {
  const searchUrl = `${BIGC_SEARCH_ORIGIN}/search?q=${encodeURIComponent(upc)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BIGC_SEARCH_TIMEOUT_MS)

  try {
    const response = await fetch(searchUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    })

    if (response.status === 404) return null
    if (!response.ok) throw new ProductLookupError('BIGC_UNAVAILABLE', 502, response.status >= 500)

    const contentType = response.headers.get('content-type') ?? ''
    if (!/text\/html|application\/json/i.test(contentType)) {
      throw new ProductLookupError('BIGC_UNAVAILABLE', 502, true)
    }

    const document = await readBodyWithLimit(response, MAX_BIGC_DOCUMENT_BYTES)
    if (isChallengePage(document)) {
      throw new ProductLookupError('BIGC_UNAVAILABLE', 502, true)
    }

    return parseBigCProductDocument(document, upc, searchUrl)
  } catch (error) {
    if (error instanceof ProductLookupError) throw error
    throw new ProductLookupError('BIGC_UNAVAILABLE', 502, true)
  } finally {
    clearTimeout(timeout)
  }
}

async function insertImportedProduct(upc: string, candidate: ProductCandidate, env: AuthEnv): Promise<void> {
  const productId = crypto.randomUUID()
  const snapshotId = crypto.randomUUID()
  const now = new Date().toISOString()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO products
        (id, upc, name, brand, package_size, unit, category, image_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      productId,
      upc,
      candidate.name,
      candidate.brand,
      candidate.packageSize,
      candidate.unit,
      candidate.category,
      candidate.imageUrl,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO product_source_snapshots
        (id, product_id, source, source_product_id, source_url, source_price_minor,
         regular_price_minor, availability, fetched_at)
       VALUES (?, ?, 'bigc', ?, ?, ?, ?, 'unknown', ?)`,
    ).bind(
      snapshotId,
      productId,
      candidate.sourceProductId,
      candidate.sourceUrl,
      candidate.sourcePriceMinor,
      candidate.regularPriceMinor,
      now,
    ),
  ])
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    upc: row.upc,
    name: row.name,
    brand: row.brand,
    packageSize: row.package_size,
    unit: row.unit,
    category: row.category,
    imageUrl: row.image_url,
    source: row.source === 'bigc' ? 'bigc' : 'smartcart',
    sourceUrl: row.source_url,
    sourcePriceMinor: row.source_price_minor,
    regularPriceMinor: row.regular_price_minor,
    fetchedAt: row.fetched_at,
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ProductLookupError('BIGC_UNAVAILABLE', 502, true)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new ProductLookupError('BIGC_UNAVAILABLE', 502, true)
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
  return new TextDecoder().decode(bytes)
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new ManualProductInputError()
  if (!request.body) throw new ManualProductInputError()

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
        throw new ManualProductInputError()
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
    throw new ManualProductInputError()
  }
}

function jsonScripts(document: string): unknown[] {
  const scripts = document.matchAll(
    /<script[^>]+(?:type=["']application\/(?:ld\+json|json)["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi,
  )
  const values: unknown[] = []
  for (const script of scripts) {
    try {
      values.push(JSON.parse(script[1]))
    } catch {
      // Ignore malformed embedded JSON and continue to the next structured source.
    }
  }
  return values
}

function findProductCandidate(value: unknown, upc: string, searchUrl: string, depth = 0): ProductCandidate | null {
  if (depth > 40 || !value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = findProductCandidate(entry, upc, searchUrl, depth + 1)
      if (candidate) return candidate
    }
    return null
  }

  const record = value as Record<string, unknown>
  if (hasMatchingUpc(record, upc)) {
    const name = firstText(record, ['name', 'productName', 'title'])
    if (name) return toCandidate(record, name, searchUrl)
  }

  for (const child of Object.values(record)) {
    const candidate = findProductCandidate(child, upc, searchUrl, depth + 1)
    if (candidate) return candidate
  }
  return null
}

function hasMatchingUpc(record: Record<string, unknown>, upc: string): boolean {
  const keys = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'barcode', 'upc', 'sku', 'productCode']
  return keys.some((key) => textValue(record[key]) === upc)
}

function toCandidate(record: Record<string, unknown>, name: string, searchUrl: string): ProductCandidate {
  const offers = firstObject(record, ['offers', 'offer', 'priceInfo'])
  const currentPrice = moneyMinor(
    firstValue(offers, ['price', 'salePrice', 'specialPrice']) ?? firstValue(record, ['price', 'salePrice', 'specialPrice']),
  )
  const regularPrice = moneyMinor(
    firstValue(offers, ['highPrice', 'regularPrice', 'listPrice']) ?? firstValue(record, ['regularPrice', 'listPrice']),
  )
  const sourceUrl = safeBigCUrl(firstText(record, ['url', 'canonicalUrl', 'productUrl'])) ?? searchUrl

  return {
    name,
    brand: brandName(record.brand),
    packageSize: firstText(record, ['packageSize', 'size', 'description']),
    unit: firstText(record, ['unit', 'unitName']),
    category: firstText(record, ['category']),
    imageUrl: imageUrl(record.image),
    sourceProductId: firstText(record, ['productID', 'productId', 'id', 'sku']),
    sourceUrl,
    sourcePriceMinor: currentPrice,
    regularPriceMinor: regularPrice,
  }
}

function firstValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return null
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return null
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = textValue(record[key])
    if (value) return value.slice(0, 500)
  }
  return null
}

function firstObject(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  }
  return null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function brandName(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 200)
  if (value && typeof value === 'object' && !Array.isArray(value)) return textValue((value as Record<string, unknown>).name)
  return null
}

function imageUrl(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw, BIGC_SEARCH_ORIGIN)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeBigCUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value, BIGC_SEARCH_ORIGIN)
    return url.origin === BIGC_SEARCH_ORIGIN ? url.toString() : null
  } catch {
    return null
  }
}

function moneyMinor(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/)
  if (!normalized) return null
  const amount = Number(normalized[0])
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null
  return Math.round(amount * 100)
}

function isChallengePage(document: string): boolean {
  return /cf-chl|challenge-platform|enable javascript and cookies to continue/i.test(document)
}

function parseManualProductInput(value: unknown): { upc: string; name: string; brand: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManualProductInputError()
  const record = value as Record<string, unknown>
  const upc = textValue(record.upc)
  const name = textValue(record.name)
  const brand = textValue(record.brand)
  if (!upc || !isValidUpc(upc) || !name || name.length > 200 || (brand && brand.length > 100)) {
    throw new ManualProductInputError()
  }
  return { upc, name, brand }
}


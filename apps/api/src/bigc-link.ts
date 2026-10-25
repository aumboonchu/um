export type BigCLinkCandidate = {
  name: string
  brand: string | null
  packageSize: string | null
  unit: string | null
  category: string | null
  imageUrl: string | null
  sourceProductId: string
  sourceUrl: string
  sourcePriceMinor: number | null
  regularPriceMinor: number | null
  upc: string | null
}

export class BigCLinkError extends Error {
  constructor(
    public readonly code: 'INVALID_BIGC_URL' | 'INVALID_IMPORT' | 'BIGC_BLOCKED' | 'BIGC_UNAVAILABLE'
      | 'BIGC_PRODUCT_NOT_FOUND' | 'BIGC_PRODUCT_DATA_MISSING' | 'BIGC_UPC_CONFLICT',
    public readonly status: 400 | 404 | 409 | 422 | 502,
    public readonly retryable = false,
  ) { super(code) }
}

const ORIGIN = 'https://www.bigc.co.th'
const MAX_BYTES = 512 * 1024

export function normalizeBigCProductUrl(value: string): { url: string; sourceProductId: string } {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) {
    throw new BigCLinkError('INVALID_BIGC_URL', 400)
  }
  try {
    const url = new URL(value.trim())
    if (url.origin !== ORIGIN || url.username || url.password || url.port
      || /%(?:2f|5c|00)/i.test(url.pathname)) throw new Error('invalid origin/path')
    const match = url.pathname.match(/^(?:\/en)?\/product\/[^/]+\.([0-9]{1,20})\/?$/)
    if (!match) throw new Error('not a product link')
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/$/, '')
    return { url: url.toString(), sourceProductId: match[1] }
  } catch {
    throw new BigCLinkError('INVALID_BIGC_URL', 400)
  }
}

export async function readBigCProductLink(value: string): Promise<BigCLinkCandidate> {
  const original = normalizeBigCProductUrl(value)
  let target = original
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await fetch(target.url, {
        headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9' },
        redirect: 'manual', signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || redirects === 2) throw new BigCLinkError('BIGC_UNAVAILABLE', 502)
        try {
          target = normalizeBigCProductUrl(new URL(location, target.url).toString())
        } catch { throw new BigCLinkError('BIGC_UNAVAILABLE', 502) }
        if (target.sourceProductId !== original.sourceProductId) throw new BigCLinkError('BIGC_UNAVAILABLE', 502)
        continue
      }
      if (response.headers.get('cf-mitigated') === 'challenge' || response.status === 403) {
        await response.body?.cancel()
        throw new BigCLinkError('BIGC_BLOCKED', 502)
      }
      if (response.status === 404) {
        await response.body?.cancel()
        throw new BigCLinkError('BIGC_PRODUCT_NOT_FOUND', 404)
      }
      if (!response.ok || !/text\/html|application\/(?:xhtml\+xml|json)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel()
        throw new BigCLinkError('BIGC_UNAVAILABLE', 502, response.status === 429 || response.status >= 500)
      }
      const document = await readLimitedDocument(response)
      if (/<title[^>]*>\s*(?:just a moment|attention required|access denied)/i.test(document)
        || /enable javascript and cookies to continue/i.test(document)) throw new BigCLinkError('BIGC_BLOCKED', 502)
      const candidate = parseBigCLinkDocument(document, original.url)
      if (!candidate) throw new BigCLinkError('BIGC_PRODUCT_DATA_MISSING', 422)
      return candidate
    }
    throw new BigCLinkError('BIGC_UNAVAILABLE', 502)
  } catch (error) {
    if (error instanceof BigCLinkError) throw error
    throw new BigCLinkError('BIGC_UNAVAILABLE', 502, true)
  } finally { clearTimeout(timer) }
}

async function readLimitedDocument(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel()
    throw new BigCLinkError('BIGC_UNAVAILABLE', 502)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let document = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BYTES) {
        await reader.cancel()
        throw new BigCLinkError('BIGC_UNAVAILABLE', 502)
      }
      document += decoder.decode(value, { stream: true })
    }
    return document + decoder.decode()
  } finally { reader.releaseLock() }
}

// Untrusted source content is parsed as JSON, never executed or inserted as HTML.
export function parseBigCLinkDocument(document: string, value: string): BigCLinkCandidate | null {
  const target = normalizeBigCProductUrl(value)
  const scripts = document.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)
  for (const script of scripts) {
    const opening = script[0].slice(0, script[0].indexOf('>') + 1)
    if (!/(?:type\s*=\s*["']application\/(?:ld\+json|json)["']|id\s*=\s*["']__NEXT_DATA__["'])/i.test(opening)) continue
    try {
      const candidate = findCandidate(JSON.parse(script[1]), target, 0)
      if (candidate) return candidate
    } catch { /* Malformed JSON is not a product; inspect other scripts. */ }
  }
  // A JSON response may expose the same public structured product data.
  if (/^\s*[\[{]/.test(document)) {
    try { return findCandidate(JSON.parse(document), target, 0) } catch { return null }
  }
  return null
}

function findCandidate(value: unknown, target: { url: string; sourceProductId: string }, depth: number): BigCLinkCandidate | null {
  if (!value || typeof value !== 'object' || depth > 32) return null
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findCandidate(child, target, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  const identity = firstText(record, ['productID', 'productId', 'product_id', 'id', 'sku'])
  if (identity && identity !== target.sourceProductId) return null
  const rawUrl = firstText(record, ['url', 'canonicalUrl', 'productUrl'])
  let matchesUrl = false
  if (rawUrl) {
    try {
      const link = normalizeBigCProductUrl(new URL(rawUrl, ORIGIN).toString())
      if (link.sourceProductId !== target.sourceProductId) return null
      matchesUrl = true
    } catch { /* This may be an image/organisation URL, not product identity. */ }
  }
  const name = firstText(record, ['name', 'productName', 'product_name', 'title'])
  const type = record['@type']
  const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'))
    || 'productName' in record || 'product_name' in record || 'brand' in record || 'price' in record || 'offers' in record
  if (name && isProduct && (identity === target.sourceProductId || matchesUrl)) {
    const offers = objectValue(Array.isArray(record.offers) ? record.offers[0] : record.offers)
      ?? objectValue(record.offer) ?? objectValue(record.priceInfo)
    const upc = firstText(record, ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'barcode', 'upc'])
    return {
      name: name.slice(0, 200),
      brand: typeof record.brand === 'string' ? record.brand.slice(0, 200) : firstText(objectValue(record.brand), ['name']),
      packageSize: firstText(record, ['packageSize', 'package_size', 'size']),
      unit: firstText(record, ['unit', 'unitName']),
      category: firstText(record, ['category']),
      imageUrl: imageUrl(record.image ?? record.imageUrl ?? record.image_url),
      sourceProductId: target.sourceProductId, sourceUrl: target.url,
      sourcePriceMinor: moneyMinor(firstValue(offers, ['price', 'salePrice', 'specialPrice']) ?? firstValue(record, ['price', 'salePrice', 'specialPrice'])),
      regularPriceMinor: moneyMinor(firstValue(offers, ['highPrice', 'regularPrice', 'listPrice']) ?? firstValue(record, ['regularPrice', 'listPrice'])),
      upc: upc && /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(upc) ? upc : null,
    }
  }
  for (const child of Object.values(record)) {
    const found = findCandidate(child, target, depth + 1)
    if (found) return found
  }
  return null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function firstText(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500)
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  }
  return null
}

function firstValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return null
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]
  return null
}

function imageUrl(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  const text = typeof raw === 'string' ? raw : firstText(objectValue(raw), ['url', 'contentUrl'])
  if (!text) return null
  try {
    const url = new URL(text, ORIGIN)
    const allowedHost = url.hostname === 'bigc.co.th' || url.hostname.endsWith('.bigc.co.th')
      || url.hostname === 'bigc-cs.com' || url.hostname.endsWith('.bigc-cs.com')
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowedHost ? url.toString() : null
  } catch { return null }
}

function moneyMinor(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).replaceAll(',', '').trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) && number > 0 && number <= 1_000_000 ? Math.round(number * 100) : null
}


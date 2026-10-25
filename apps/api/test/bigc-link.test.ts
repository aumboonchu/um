import { SELF, applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BigCLinkError, normalizeBigCProductUrl, parseBigCLinkDocument, readBigCProductLink } from '../src/bigc-link'

const productUrl = 'https://www.bigc.co.th/product/example-product.123456'
const productPath = '/product/example-product.123456'
const sessionToken = 'b'.repeat(43)
const userId = 'bigc-link-test-user'
const headers = { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN, Authorization: `Bearer ${sessionToken}` }

// All embedded documents below are synthetic test fixtures, not captured Big C responses.
function productDocument(extra: Record<string, unknown> = {}) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', sku: '123456', name: 'สินค้าตัวอย่าง 600 มล.',
    brand: { name: 'Test Brand' }, image: 'https://www.bigc.co.th/test-product.jpg',
    offers: { price: '12.50', highPrice: '15.00' }, ...extra,
  })}</script>`
}

function mockDocument(document = productDocument(), path = productPath) {
  fetchMock.get('https://www.bigc.co.th').intercept({ path, method: 'GET' })
    .reply(200, document, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function importLink(url: unknown = productUrl, requestHeaders: Record<string, string> = headers) {
  return SELF.fetch('https://example.com/api/v1/products/import-bigc', {
    method: 'POST', headers: requestHeaders, body: JSON.stringify({ url }),
  })
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').bind(userId, 'Big C import test').run()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionToken)))
  const tokenHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  await env.DB.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .bind('bigc-link-session', userId, tokenHash, new Date(Date.now() + 300_000).toISOString()).run()
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => fetchMock.assertNoPendingInterceptors())
afterAll(() => fetchMock.deactivate())

describe('Big C product URL safety', () => {
  it('removes tracking parameters and fragments while retaining exact product identity', () => {
    expect(normalizeBigCProductUrl(`${productUrl}?utm_source=share#detail`)).toEqual({ url: productUrl, sourceProductId: '123456' })
    expect(normalizeBigCProductUrl('https://www.bigc.co.th/en/product/example.987654')).toEqual({
      url: 'https://www.bigc.co.th/en/product/example.987654', sourceProductId: '987654',
    })
  })

  it.each([
    'http://www.bigc.co.th/product/test.123456',
    'https://www.bigc.co.th.evil.example/product/test.123456',
    'https://bigc.co.th/product/test.123456',
    'https://user:password@www.bigc.co.th/product/test.123456',
    'https://www.bigc.co.th:8443/product/test.123456',
    'https://127.0.0.1/product/test.123456',
    'https://www.bigc.co.th/search?q=8851959129012',
    'https://www.bigc.co.th/product/test.not-a-number',
    'javascript:alert(1)',
  ])('rejects non-product or SSRF input %s', (url) => {
    expect(() => normalizeBigCProductUrl(url)).toThrow(BigCLinkError)
  })
})

describe('verified structured product parsing', () => {
  it('imports the exact Big C SKU without pretending it is a barcode', () => {
    expect(parseBigCLinkDocument(productDocument(), productUrl)).toMatchObject({
      name: 'สินค้าตัวอย่าง 600 มล.', sourceProductId: '123456', upc: null,
      brand: 'Test Brand', sourcePriceMinor: 1250, regularPriceMinor: 1500,
    })
  })

  it('accepts an explicit GTIN separately from retailer SKU', () => {
    expect(parseBigCLinkDocument(productDocument({ gtin13: '8851959129012' }), productUrl)).toMatchObject({
      sourceProductId: '123456', upc: '8851959129012',
    })
  })

  it('supports nested Next data for Thai and English product URLs', () => {
    const document = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { product: { id: 123456, productName: 'Next data test', barcode: '8851959129012' } } },
    })}</script>`
    for (const url of [productUrl, 'https://www.bigc.co.th/en/product/example-product.123456']) {
      expect(parseBigCLinkDocument(document, url)).toMatchObject({ name: 'Next data test', sourceProductId: '123456', upc: '8851959129012' })
    }
  })

  it('selects the requested SKU instead of a different recommended product', () => {
    const document = `${productDocument({ sku: '999999', name: 'Wrong recommended product' })}${productDocument()}`
    expect(parseBigCLinkDocument(document, productUrl)?.name).toBe('สินค้าตัวอย่าง 600 มล.')
    expect(parseBigCLinkDocument(productDocument({ sku: '999999' }), productUrl)).toBeNull()
  })

  it('does not trust an unrelated product URL even when another identity field matches', () => {
    expect(parseBigCLinkDocument(productDocument({ url: 'https://www.bigc.co.th/product/wrong.999999' }), productUrl)).toBeNull()
    expect(parseBigCLinkDocument(productDocument({ sku: '999999', url: productUrl }), productUrl)).toBeNull()
  })

  it('does not expose unsafe image URLs or negative/non-price text', () => {
    const candidate = parseBigCLinkDocument(productDocument({ image: 'javascript:alert(1)', offers: { price: '-12.50', highPrice: 'from 99' } }), productUrl)
    expect(candidate).toMatchObject({ imageUrl: null, sourcePriceMinor: null, regularPriceMinor: null })
  })

  it('requires verified structured data instead of Open Graph guesses', () => {
    expect(parseBigCLinkDocument('<meta property="og:title" content="Unverified product"><meta property="og:image" content="https://www.bigc.co.th/test.jpg">', productUrl)).toBeNull()
    expect(parseBigCLinkDocument('<script type="application/ld+json">{invalid}</script>', productUrl)).toBeNull()
  })
})

describe('bounded fetch and redirect safeguards', () => {
  it('classifies Cloudflare blocks as non-retryable', async () => {
    fetchMock.get('https://www.bigc.co.th').intercept({ path: productPath }).reply(403, '<title>Just a moment...</title>')
    await expect(readBigCProductLink(productUrl)).rejects.toMatchObject({ code: 'BIGC_BLOCKED', status: 502, retryable: false })
  })

  it('detects challenge content even on an HTTP 200 response', async () => {
    mockDocument('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')
    await expect(readBigCProductLink(productUrl)).rejects.toMatchObject({ code: 'BIGC_BLOCKED', retryable: false })
  })

  it.each([
    'https://evil.example/product/example-product.123456',
    'https://www.bigc.co.th/product/different.999999',
    'https://www.bigc.co.th/search?q=123456',
  ])('refuses an unsafe or different-product redirect to %s', async (location) => {
    fetchMock.get('https://www.bigc.co.th').intercept({ path: productPath }).reply(302, '', { headers: { Location: location } })
    await expect(readBigCProductLink(productUrl)).rejects.toBeInstanceOf(BigCLinkError)
  })

  it('follows a validated same-SKU language redirect', async () => {
    const englishPath = '/en/product/example-product.123456'
    fetchMock.get('https://www.bigc.co.th').intercept({ path: productPath }).reply(302, '', { headers: { Location: englishPath } })
    mockDocument(productDocument(), englishPath)
    expect(await readBigCProductLink(productUrl)).toMatchObject({ sourceProductId: '123456', upc: null })
  })

  it('rejects oversized documents even when no Content-Length is supplied', async () => {
    mockDocument(`${'x'.repeat(512 * 1024)}${productDocument()}`)
    await expect(readBigCProductLink(productUrl)).rejects.toMatchObject({ code: 'BIGC_UNAVAILABLE' })
  })

  it('does not parse an unexpected response content type', async () => {
    fetchMock.get('https://www.bigc.co.th').intercept({ path: productPath }).reply(200, productDocument(), { headers: { 'Content-Type': 'image/png' } })
    await expect(readBigCProductLink(productUrl)).rejects.toMatchObject({ code: 'BIGC_UNAVAILABLE' })
  })
})

describe('authenticated import, cache, and purchase integration', () => {
  it('rejects anonymous and cross-origin callers before issuing a Big C fetch', async () => {
    expect((await importLink(productUrl, { 'Content-Type': 'application/json' })).status).toBe(401)
    expect((await importLink(productUrl, { ...headers, Origin: 'https://evil.example' })).status).toBe(403)
    expect(await env.DB.prepare('SELECT COUNT(*) FROM products').first('COUNT(*)')).toBe(0)
  })

  it('validates malformed and oversized import bodies', async () => {
    for (const value of [null, 123, 'https://evil.example/private', 'x'.repeat(5000)]) {
      expect((await importLink(value)).status).toBe(400)
    }
  })

  it('imports without a UPC and serves duplicate/tracked/language links from D1 only', async () => {
    mockDocument()
    const first = await importLink(`${productUrl}?utm_source=share#details`)
    expect([200, 201]).toContain(first.status)
    const { data: product } = await first.json<{ data: { id: string; sku: string; upc: string | null } }>()
    expect(product).toMatchObject({ sku: 'BIGC-123456', upc: null })
    for (const url of [productUrl, `${productUrl}?second=1`, 'https://www.bigc.co.th/en/product/example-product.123456']) {
      const response = await importLink(url)
      expect([200, 201]).toContain(response.status)
      expect(await response.json()).toMatchObject({ data: { id: product.id, sku: product.sku, upc: null } })
    }
    expect(await env.DB.prepare('SELECT COUNT(*) FROM products').first('COUNT(*)')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) FROM product_source_links').first('COUNT(*)')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) FROM product_source_snapshots').first('COUNT(*)')).toBe(1)

    const purchase = await SELF.fetch('https://example.com/api/v1/purchases', {
      method: 'POST', headers,
      body: JSON.stringify({ productId: product.id, unitPriceMinor: 1250, quantity: 2, purchasedAt: '2026-10-25T00:00:00.000Z', storeName: 'Big C' }),
    })
    expect(purchase.status).toBe(201)
    const history = await SELF.fetch('https://example.com/api/v1/purchases', { headers })
    expect(await history.json()).toMatchObject({ data: { items: [{ productSku: product.sku, productUpc: null, totalMinor: 2500 }] } })
  })

  it('reuses an existing product when its explicit UPC is already in D1', async () => {
    await env.DB.prepare('INSERT INTO products (id, sku, upc, name) VALUES (?, ?, ?, ?)')
      .bind('known-upc-product', '8851959129012', '8851959129012', 'Existing UPC product').run()
    mockDocument(productDocument({ gtin13: '8851959129012' }))
    const response = await importLink()
    expect([200, 201]).toContain(response.status)
    expect(await response.json()).toMatchObject({ data: { id: 'known-upc-product', sku: '8851959129012', upc: '8851959129012' } })
    expect(await env.DB.prepare('SELECT COUNT(*) FROM products').first('COUNT(*)')).toBe(1)
    expect(await env.DB.prepare('SELECT product_id FROM product_source_links').first('product_id')).toBe('known-upc-product')
  })

  it('still creates manual UPC products after the SKU migration', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/products', {
      method: 'POST', headers,
      body: JSON.stringify({ upc: '8851959129012', name: 'Manual test product', brand: 'Manual brand' }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ data: { sku: 'UPC-8851959129012', upc: '8851959129012', name: 'Manual test product' } })
    const lookup = await SELF.fetch('https://example.com/api/v1/products/upc/8851959129012')
    expect(lookup.status).toBe(200)
    expect(await lookup.json()).toMatchObject({ data: { sku: 'UPC-8851959129012', upc: '8851959129012' } })
  })

  it('leaves every product table untouched when Big C blocks access', async () => {
    fetchMock.get('https://www.bigc.co.th').intercept({ path: productPath }).reply(403, '<title>Cloudflare challenge</title>')
    const response = await importLink()
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'BIGC_BLOCKED', retryable: false } })
    for (const table of ['products', 'product_source_links', 'product_source_snapshots']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) FROM ${table}`).first('COUNT(*)')).toBe(0)
    }
  })

  it('does not persist unrelated structured data', async () => {
    mockDocument(productDocument({ sku: '999999' }))
    const response = await importLink()
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'BIGC_PRODUCT_DATA_MISSING' } })
    expect(await env.DB.prepare('SELECT COUNT(*) FROM products').first('COUNT(*)')).toBe(0)
  })
})


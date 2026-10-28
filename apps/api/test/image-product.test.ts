import { applyD1Migrations, env, fetchMock } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { confirmImageProduct, ImageProductError } from '../src/image-product'

const userId = 'confirmed-image-user'
const otherUserId = 'other-image-user'
const sessionToken = 'i'.repeat(43)
const otherSessionToken = 'j'.repeat(43)
const operationId = '25b13cc0-7da4-4cc3-9192-437bcf2636d0'
const imageSha256 = 'a'.repeat(64)
const input = {
  operationId, confirmed: true, name: 'โค้ก น้ำอัดลม 1.95 ลิตร', brand: 'Coke',
  packageSize: '1.95 ลิตร', sourcePriceMinor: 3700, upc: null,
  retailerCode: '60560', imageSha256,
}
const headers = { Origin: env.APP_ORIGIN, Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' }

function request(value: unknown = input, requestHeaders: Record<string, string> = headers) {
  return new Request('https://example.com/api/v1/products/import-image', {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(value),
  })
}

async function count(table: 'products' | 'product_image_imports' | 'product_image_fingerprints' | 'product_source_snapshots' | 'product_source_links') {
  return env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>('count')
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  for (const [id, token] of [[userId, sessionToken], [otherUserId, otherSessionToken]]) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    const tokenHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    await env.DB.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').bind(id, 'Image import test').run()
    await env.DB.prepare('INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .bind(`session-${id}`, id, tokenHash, new Date(Date.now() + 300_000).toISOString()).run()
  }
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterAll(() => fetchMock.deactivate())

describe('confirmed image product authentication and input validation', () => {
  it('rejects anonymous callers before consuming the body or writing product data', async () => {
    const anonymous = request(input, { 'Content-Type': 'application/json', Origin: env.APP_ORIGIN })
    await expect(confirmImageProduct(anonymous, env)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 })
    expect(anonymous.bodyUsed).toBe(false)
    expect(await count('products')).toBe(0)
  })

  it('rejects a hostile origin before body processing', async () => {
    const hostile = request(input, { ...headers, Origin: 'https://evil.example' })
    await expect(confirmImageProduct(hostile, env)).rejects.toMatchObject({ code: 'UNTRUSTED_ORIGIN', status: 403 })
    expect(hostile.bodyUsed).toBe(false)
    expect(await count('product_image_imports')).toBe(0)
  })

  it.each([
    null,
    [],
    { ...input, confirmed: false },
    { ...input, confirmed: undefined },
    { ...input, operationId: 'not-a-uuid' },
    { ...input, operationId: '25b13cc0-7da4-4cc3-1192-437bcf2636d0' },
    { ...input, name: '' },
    { ...input, name: 'x'.repeat(201) },
    { ...input, name: 'bad\u0000name' },
    { ...input, brand: 'x'.repeat(101) },
    { ...input, packageSize: 123 },
    { ...input, retailerCode: 'x'.repeat(81) },
    { ...input, sourcePriceMinor: -1 },
    { ...input, sourcePriceMinor: 12.5 },
    { ...input, sourcePriceMinor: '3700' },
    { ...input, sourcePriceMinor: 100_000_001 },
    { ...input, upc: '60560' },
    { ...input, upc: '8851959129013' },
    { ...input, upc: '0000000000000' },
    { ...input, upc: 8851959129012 },
    { ...input, imageSha256: 'not-a-sha256' },
    { ...input, sourceProductId: '60560' },
    { ...input, imageUrl: 'https://evil.example/private' },
  ])('rejects unconfirmed, malformed, or unsupported fields %# without inserting anything', async (value) => {
    await expect(confirmImageProduct(request(value), env)).rejects.toMatchObject({ code: 'INVALID_IMAGE_PRODUCT', status: 400 })
    expect(await count('products')).toBe(0)
    expect(await count('product_image_imports')).toBe(0)
  })

  it('bounds the actual streamed body without trusting Content-Length', async () => {
    const oversized = request({ ...input, name: 'x'.repeat(12 * 1024) })
    await expect(confirmImageProduct(oversized, env)).rejects.toBeInstanceOf(ImageProductError)
    const malformed = new Request('https://example.com/api/v1/products/import-image', { method: 'POST', headers, body: '{bad JSON' })
    await expect(confirmImageProduct(malformed, env)).rejects.toMatchObject({ code: 'INVALID_IMAGE_PRODUCT' })
    const wrongType = request(input, { ...headers, 'Content-Type': 'text/plain' })
    await expect(confirmImageProduct(wrongType, env)).rejects.toMatchObject({ code: 'INVALID_IMAGE_PRODUCT' })
    expect(await count('products')).toBe(0)
  })
})

describe('confirmed image persistence and SKU identity', () => {
  it('saves a confirmed Makro Pro pack as one SKU, preserving pack price and a separate retailer Code on replay', async () => {
    const makro = { ...input, name: 'OREO Sandwich Cookies with Vanilla Flavored Cream 24.6 g x 12',
      brand: 'OREO', packageSize: '24.6 g x 12', sourcePriceMinor: 4500, retailerCode: '197584' }
    const first = await confirmImageProduct(request(makro), env)
    const retry = await confirmImageProduct(request(makro), env)
    expect(first.created).toBe(true)
    expect(first.product).toMatchObject({ name: makro.name, brand: 'OREO', packageSize: '24.6 g x 12',
      sourcePriceMinor: 4500, upc: null, sourceProductId: null, source: 'smartcart' })
    expect(retry.product.id).toBe(first.product.id)
    expect(retry.created).toBe(false)
    expect(await env.DB.prepare('SELECT retailer_code FROM product_image_imports').first('retailer_code')).toBe('197584')
    expect(await count('products')).toBe(1)
    expect(await count('product_source_links')).toBe(0)
  })

  it('saves a new IMG SKU only after confirmation and never promotes the shown code to UPC/Big C identity', async () => {
    const result = await confirmImageProduct(request(), env)
    expect(result.created).toBe(true)
    expect(result.product).toMatchObject({
      name: input.name, brand: 'Coke', packageSize: '1.95 ลิตร', upc: null,
      source: 'smartcart', sourceProductId: null, sourceUrl: null, imageUrl: null,
      sourcePriceMinor: 3700, regularPriceMinor: null,
    })
    expect(result.product.sku).toBe(`IMG-${result.product.id}`)
    expect(await env.DB.prepare('SELECT retailer_code, image_sha256 FROM product_image_imports').first()).toEqual({ retailer_code: '60560', image_sha256: imageSha256 })
    expect(await env.DB.prepare('SELECT source, source_product_id, source_url FROM product_source_snapshots').first()).toEqual({ source: 'user_image', source_product_id: null, source_url: null })
    expect(await count('product_source_links')).toBe(0)
    expect(await count('products')).toBe(1)
  })

  it('returns the same product for an exact UUID retry without another snapshot', async () => {
    const first = await confirmImageProduct(request(), env)
    const retry = await confirmImageProduct(request(), env)
    expect(retry.created).toBe(false)
    expect(retry.product).toEqual(first.product)
    expect(await count('products')).toBe(1)
    expect(await count('product_image_imports')).toBe(1)
    expect(await count('product_source_snapshots')).toBe(1)
  })

  it('normalizes scalar text/case consistently across immutable receipt retries', async () => {
    const first = await confirmImageProduct(request(), env)
    const normalized = { ...input, operationId: operationId.toUpperCase(), imageSha256: imageSha256.toUpperCase(), name: ` ${input.name} ` }
    expect((await confirmImageProduct(request(normalized), env)).product.id).toBe(first.product.id)
    expect(await count('products')).toBe(1)
  })

  it('rejects changing confirmed fields under a UUID that has already committed', async () => {
    await confirmImageProduct(request(), env)
    await expect(confirmImageProduct(request({ ...input, sourcePriceMinor: 3800 }), env)).rejects.toMatchObject({ code: 'IMAGE_IMPORT_CONFLICT', status: 409 })
    expect(await env.DB.prepare('SELECT source_price_minor FROM product_source_snapshots').first('source_price_minor')).toBe(3700)
    expect(await count('products')).toBe(1)
  })

  it('deduplicates the same confirmed image under a new UUID but keeps a receipt for each UUID', async () => {
    const first = await confirmImageProduct(request(), env)
    const second = await confirmImageProduct(request({ ...input, operationId: crypto.randomUUID() }), env)
    expect(second.created).toBe(false)
    expect(second.product.id).toBe(first.product.id)
    expect(await count('products')).toBe(1)
    expect(await count('product_image_imports')).toBe(2)
    expect(await count('product_image_fingerprints')).toBe(1)
    expect(await count('product_source_snapshots')).toBe(1)
  })

  it('does not overwrite an earlier product when a user corrects fields on the same image', async () => {
    const first = await confirmImageProduct(request(), env)
    const corrected = await confirmImageProduct(request({ ...input, operationId: crypto.randomUUID(), name: 'ชื่อสินค้าที่แก้ไข' }), env)
    expect(corrected.created).toBe(true)
    expect(corrected.product.id).not.toBe(first.product.id)
    expect(await env.DB.prepare('SELECT name FROM products WHERE id = ?').bind(first.product.id).first('name')).toBe(input.name)
    expect(await count('products')).toBe(2)
  })

  it('scopes UUIDs and image fingerprints to the authenticated account', async () => {
    const first = await confirmImageProduct(request(), env)
    const second = await confirmImageProduct(request(input, { ...headers, Authorization: `Bearer ${otherSessionToken}` }), env)
    expect(second.created).toBe(true)
    expect(second.product.id).not.toBe(first.product.id)
    expect(await count('product_image_imports')).toBe(2)
    expect(await count('product_image_fingerprints')).toBe(2)
  })

  it('uses a verified GTIN to reuse an existing product without overwriting historical product data', async () => {
    await env.DB.prepare('INSERT INTO products (id, sku, upc, name) VALUES (?, ?, ?, ?)')
      .bind('legacy-coke', 'UPC-8851959129012', '8851959129012', 'Existing historic name').run()
    const result = await confirmImageProduct(request({ ...input, upc: '8851959129012' }), env)
    expect(result.created).toBe(false)
    expect(result.product).toMatchObject({ id: 'legacy-coke', sku: 'UPC-8851959129012', upc: '8851959129012', name: 'Existing historic name', sourcePriceMinor: 3700 })
    expect(await count('products')).toBe(1)
    expect(await count('product_image_imports')).toBe(1)
  })

  it('accepts deliberately absent optional data and zero reference price', async () => {
    const result = await confirmImageProduct(request({ operationId, confirmed: true, name: 'สินค้าที่ยืนยันเอง', sourcePriceMinor: 0 }), env)
    expect(result.product).toMatchObject({ upc: null, brand: null, packageSize: null, sourcePriceMinor: 0 })
  })

  it.each(['96385074', '036000291452', '8851959129012', '08851959129012'])('preserves a valid GTIN including leading zeroes: %s', async (upc) => {
    const result = await confirmImageProduct(request({ ...input, upc }), env)
    expect(result.product.upc).toBe(upc)
    expect(result.product.sourceProductId).toBeNull()
  })
})

describe('atomic concurrent image confirmations', () => {
  it('creates one product and snapshot for concurrent retries with one UUID', async () => {
    const results = await Promise.all([confirmImageProduct(request(), env), confirmImageProduct(request(), env)])
    expect(new Set(results.map((result) => result.product.id)).size).toBe(1)
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(await count('products')).toBe(1)
    expect(await count('product_source_snapshots')).toBe(1)
    expect(await count('product_image_imports')).toBe(1)
  })

  it('deduplicates concurrent new UUIDs for one confirmed image without orphan rows', async () => {
    const results = await Promise.all([
      confirmImageProduct(request(), env),
      confirmImageProduct(request({ ...input, operationId: crypto.randomUUID() }), env),
    ])
    expect(new Set(results.map((result) => result.product.id)).size).toBe(1)
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(await count('products')).toBe(1)
    expect(await count('product_source_snapshots')).toBe(1)
    expect(await count('product_image_imports')).toBe(2)
    expect(await count('product_image_fingerprints')).toBe(1)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('serializes conflicting simultaneous uses of the same UUID without silently updating a product', async () => {
    const results = await Promise.allSettled([
      confirmImageProduct(request(), env),
      confirmImageProduct(request({ ...input, name: 'Different confirmed name' }), env),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ code: 'IMAGE_IMPORT_CONFLICT' })
    expect(await count('products')).toBe(1)
    expect(await count('product_image_imports')).toBe(1)
  })

  it('reuses the same explicit GTIN when different confirmed images arrive simultaneously', async () => {
    const results = await Promise.all([
      confirmImageProduct(request({ ...input, upc: '8851959129012' }), env),
      confirmImageProduct(request({ ...input, upc: '8851959129012', imageSha256: 'b'.repeat(64), operationId: crypto.randomUUID() }), env),
    ])
    expect(new Set(results.map((result) => result.product.id)).size).toBe(1)
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(await count('products')).toBe(1)
    expect(await count('product_image_imports')).toBe(2)
    expect(await count('product_image_fingerprints')).toBe(2)
    expect(await count('product_source_snapshots')).toBe(2)
  })
})

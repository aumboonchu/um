import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestBigcImport, validateBigcImportUrl } from '../src/bigc-import'
import type { CachedProduct } from '../src/offline'

const productUrl = 'https://www.bigc.co.th/product/example-product.123456'
const product: CachedProduct = {
  id: '12345678-1234-4123-8123-123456789abc',
  sku: 'BIGC-123456',
  upc: null,
  sourceProductId: '123456',
  name: 'สินค้าทดสอบ 600 มล.',
  brand: 'Test Brand',
  packageSize: '600 มล.',
  imageUrl: null,
  source: 'bigc',
  sourcePriceMinor: 1250,
  regularPriceMinor: null,
  fetchedAt: '2026-10-25T12:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Big C import URL validation feedback', () => {
  it.each([
    productUrl,
    `${productUrl}?utm_source=share#details`,
    'https://www.bigc.co.th/en/product/example-product.123456',
  ])('accepts a supported product URL: %s', (url) => {
    expect(validateBigcImportUrl(url)).toBeNull()
  })

  it.each([
    '',
    'not a URL',
    'http://www.bigc.co.th/product/example.123456',
    'https://www.bigc.co.th/search?q=8851959129012',
    'https://www.bigc.co.th.evil.example/product/example.123456',
    'https://user:password@www.bigc.co.th/product/example.123456',
    'https://www.bigc.co.th:8443/product/example.123456',
  ])('explains invalid input before submission: %s', (url) => {
    const message = validateBigcImportUrl(url)
    expect(message).toBeTypeOf('string')
    expect(message?.trim().length).toBeGreaterThan(0)
  })
})

describe('confirmed Big C import outcomes', () => {
  it('reports success only with the confirmed server product and sends JSON with an abort signal', async () => {
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockResolvedValue(jsonResponse({ data: product }, 201))
    expect(await requestBigcImport(productUrl, send)).toEqual({ status: 'success', product })
    expect(send).toHaveBeenCalledTimes(1)
    const init = send.mock.calls[0][0]
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ url: productUrl })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('also accepts an existing deduplicated SKU instead of claiming a second item was created', async () => {
    const existing = { ...product, id: 'existing-product-id', sku: 'UPC-8851959129012', upc: '8851959129012' }
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockResolvedValue(jsonResponse({ data: existing }))
    expect(await requestBigcImport(productUrl, send)).toEqual({ status: 'success', product: existing })
  })

  it.each([
    ['BIGC_BLOCKED', 502, false, 'BIGC_BLOCKED'],
    ['BIGC_PRODUCT_NOT_FOUND', 404, false, 'BIGC_PRODUCT_NOT_FOUND'],
    ['BIGC_PRODUCT_DATA_MISSING', 422, false, 'BIGC_PRODUCT_DATA_MISSING'],
    ['BIGC_UPC_CONFLICT', 409, false, 'BIGC_UPC_CONFLICT'],
    ['INVALID_BIGC_URL', 400, false, 'INVALID_BIGC_URL'],
    ['INVALID_IMPORT', 400, false, 'INVALID_IMPORT'],
    ['UNAUTHENTICATED', 401, false, 'LOGIN_REQUIRED'],
    ['UNTRUSTED_ORIGIN', 403, false, 'REQUEST_DENIED'],
    ['RATE_LIMITED', 429, true, 'RATE_LIMITED'],
    ['BIGC_UNAVAILABLE', 502, true, 'BIGC_UNAVAILABLE'],
  ] as const)('reports a confirmed %s failure without selecting a product', async (code, status, retryable, expectedCode) => {
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockResolvedValue(
      jsonResponse({ error: { code, message: 'ข้อความผิดพลาดจากระบบ', retryable } }, status),
    )
    const result = await requestBigcImport(productUrl, send)
    expect(result).toMatchObject({ status: 'error', code: expectedCode, retryable })
    expect(result).not.toHaveProperty('product')
    if (result.status === 'error') {
      expect(result.title.length).toBeGreaterThan(0)
      expect(result.message.length).toBeGreaterThan(0)
    }
  })
})

describe('uncertain outcomes must never claim the product was not added', () => {
  it('returns uncertain after a network failure because D1 may already have committed', async () => {
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await requestBigcImport(productUrl, send)
    expect(result).toMatchObject({ status: 'uncertain' })
    expect(result).not.toHaveProperty('product')
  })

  it('returns uncertain for a malformed JSON success response', async () => {
    const result = await requestBigcImport(productUrl, async () => new Response('{bad JSON', { status: 201 }))
    expect(result).toMatchObject({ status: 'uncertain' })
  })

  it.each([
    null,
    {},
    { data: null },
    { data: {} },
    { data: { ...product, id: '' } },
    { data: { ...product, id: 123456 } },
    { data: { ...product, name: '' } },
    { data: { ...product, name: null } },
    { data: { ...product, sku: '' } },
    { data: { ...product, sku: undefined } },
    { error: { code: 'BIGC_BLOCKED', message: 'Unexpected error in a 2xx response' } },
  ])('does not show success for an unverified 2xx payload %#', async (body) => {
    const result = await requestBigcImport(productUrl, async () => jsonResponse(body))
    expect(result).toMatchObject({ status: 'uncertain' })
    expect(result).not.toHaveProperty('product')
  })

  it('treats an unknown server error as uncertain instead of claiming a rollback', async () => {
    const result = await requestBigcImport(productUrl, async () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } }, 500))
    expect(result).toMatchObject({ status: 'uncertain' })
  })

  it('handles non-JSON proxy errors as uncertain', async () => {
    const result = await requestBigcImport(productUrl, async () => new Response('<html>Bad gateway</html>', { status: 502 }))
    expect(result).toMatchObject({ status: 'uncertain' })
  })

  it('settles after the default 15-second timeout even if the transport ignores cancellation', async () => {
    vi.useFakeTimers()
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockImplementation(() => new Promise(() => {}))
    let settled = false
    const resultPromise = requestBigcImport(productUrl, send)
    void resultPromise.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await resultPromise).toMatchObject({ status: 'uncertain' })
    expect(send.mock.calls[0][0].signal?.aborted).toBe(true)
  })

  it('keeps a late success from changing an already timed-out result', async () => {
    vi.useFakeTimers()
    let complete!: (response: Response) => void
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const resultPromise = requestBigcImport(productUrl, send, 50)
    await vi.advanceTimersByTimeAsync(50)
    const timedOut = await resultPromise
    expect(timedOut.status).toBe('uncertain')
    complete(jsonResponse({ data: product }, 201))
    await Promise.resolve()
    expect(await resultPromise).toEqual(timedOut)
  })

  it('applies the timeout to reading the response body, not just opening the request', async () => {
    vi.useFakeTimers()
    const body = new ReadableStream<Uint8Array>({ start() { /* Server never completes the response body. */ } })
    const resultPromise = requestBigcImport(productUrl, async () => new Response(body, { status: 201 }), 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await resultPromise).toMatchObject({ status: 'uncertain', code: 'IMPORT_TIMEOUT' })
  })
})


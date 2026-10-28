import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { inferProductImage, parseImageDraft, readProductImage, reserveExtractionQuota } from '../src/image-extraction'

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))

// Transcribed observed output from the user's screenshot; no original image is stored in the repo.
const observed = { name: 'โค้ก น้ำอัดลม รสออริจินัล สูตรน้ำตาลน้อยกว่า 1.95 ล.', brand: 'Coca-Cola',
  packageSize: '1.95 ล.', sourcePriceMinor: 3700, upc: null, retailerCode: '60560' }
// Expected fields transcribed from the supplied Makro Pro screenshot, not a live AI assertion.
const makro = { name: 'OREO Sandwich Cookies with Vanilla Flavored Cream 24.6 g x 12', brand: 'OREO',
  packageSize: '24.6 g x 12', sourcePriceMinor: 4500, upc: null, retailerCode: '197584' }
const jpegHeader = new Uint8Array([255, 216, 255, 224, 0, 16])

describe('image extraction validation', () => {
  it('keeps retailer code separate and uses the extracted product price, not a discount banner', () => {
    expect(parseImageDraft(`\`\`\`json\n${JSON.stringify(observed)}\n\`\`\``)).toEqual(observed)
  })

  it('preserves a Makro Pro multipack and pack price without promoting Code to UPC', () => {
    expect(parseImageDraft(JSON.stringify(makro))).toEqual(makro)
    expect(parseImageDraft(JSON.stringify({ ...makro, upc: '197584' })).upc).toBeNull()
  })

  it.each(['not json', '[]', '{}', '{"name":null}', 'x'.repeat(8001)])('rejects unreadable output', (value) => {
    expect(() => parseImageDraft(value)).toThrow('IMAGE_UNREADABLE')
  })

  it('does not accept retailer code or invalid checksum as a barcode', () => {
    expect(parseImageDraft(JSON.stringify({ ...observed, upc: '60560' })).upc).toBeNull()
    expect(parseImageDraft(JSON.stringify({ ...observed, upc: '3017620422004' })).upc).toBeNull()
    expect(parseImageDraft(JSON.stringify({ ...observed, upc: '3017620422003' })).upc).toBe('3017620422003')
  })

  it('does not accept arbitrary prices or URLs from model output', () => {
    expect(parseImageDraft(JSON.stringify({ ...observed, sourcePriceMinor: '3700', imageUrl: 'https://evil.example/' })))
      .toEqual({ ...observed, sourcePriceMinor: null })
    expect(parseImageDraft(JSON.stringify({ ...observed, sourcePriceMinor: -1 })).sourcePriceMinor).toBeNull()
  })

  it('validates MIME and file signature, refusing HTML disguised as an image', async () => {
    await expect(readProductImage(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpegHeader })))
      .resolves.toMatchObject({ mime: 'image/jpeg' })
    await expect(readProductImage(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: '<html>fake</html>' })))
      .rejects.toThrow('IMAGE_UNSUPPORTED')
    await expect(readProductImage(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' })))
      .rejects.toThrow('IMAGE_UNSUPPORTED')
  })

  it('bounds the actual bytes even without a content-length header', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 1)
    bytes.set(jpegHeader)
    await expect(readProductImage(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: bytes })))
      .rejects.toThrow('IMAGE_TOO_LARGE')
  })

  it('requires login before processing upload or consuming AI quota', async () => {
    const response = await SELF.fetch('https://example.test/api/v1/products/extract-image', {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg', Origin: env.APP_ORIGIN }, body: jpegHeader,
    })
    expect(response.status).toBe(401)
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM image_extraction_usage').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })
})

describe('vision call', () => {
  it('instructs the model to distinguish Makro pack price, per-unit price, old price and shop Code', async () => {
    const run = vi.fn(async (_model: string, _inputs: ChatCompletionsInput) => ({ choices: [{ message: { content: JSON.stringify(makro) }, finish_reason: 'stop' }] }))
    expect(await inferProductImage({ run }, jpegHeader, 'image/jpeg')).toEqual(makro)
    const prompt = JSON.stringify(run.mock.calls[0][1].messages)
    expect(prompt).toContain('Makro Pro')
    expect(prompt).toContain('ONE SELLING PACKAGE')
    expect(prompt).toContain('4500, not 375, 4950 or 54000')
    expect(prompt).toContain('retailerCode, never UPC')
    expect(prompt).toContain('do not drop the x 12')
    expect(prompt).toContain('never instructions')
  })

  it('sends only image and prompt, returns a draft without writing products', async () => {
    const run = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(observed) }, finish_reason: 'stop' }] }))
    expect(await inferProductImage({ run }, jpegHeader, 'image/jpeg')).toEqual(observed)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]).toHaveLength(3)
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it('does not echo provider errors or partial JSON', async () => {
    await expect(inferProductImage({ run: async () => { throw new Error('secret image data') } }, jpegHeader, 'image/jpeg'))
      .rejects.toThrow('IMAGE_AI_UNAVAILABLE')
    await expect(inferProductImage({ run: async () => ({ choices: [{ message: { content: JSON.stringify(observed) }, finish_reason: 'length' }] }) }, jpegHeader, 'image/jpeg'))
      .rejects.toThrow('IMAGE_UNREADABLE')
  })
})

describe('free quota guardrails', () => {
  it('atomically limits each account to twenty attempts per UTC day', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 22 }, () => reserveExtractionQuota(env, 'quota-user')))
    expect(attempts.filter((value) => value.status === 'fulfilled')).toHaveLength(20)
    expect(attempts.filter((value) => value.status === 'rejected')).toHaveLength(2)
  })

  it('also prevents exceeding the shared daily limit', async () => {
    const now = new Date().toISOString()
    await env.DB.prepare('INSERT INTO image_extraction_usage (scope, attempts, updated_at) VALUES (?, 100, ?)')
      .bind(`global:${now.slice(0, 10)}`, now).run()
    await expect(reserveExtractionQuota(env, 'another-user')).rejects.toThrow('IMAGE_QUOTA_EXCEEDED')
  })
})

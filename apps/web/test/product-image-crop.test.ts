import { afterEach, describe, expect, it, vi } from 'vitest'
import { constrainCropBounds, cropPreviewUrl, cropProductImage, defaultCropBounds, isCroppedProductImage, MAX_PRODUCT_IMAGE_BYTES, validCropBounds } from '../src/product-image-crop'
import { createImageImportAttempt, fieldsFromImageDraft, loadPendingImageAttempt, persistPendingImageAttempt, requestImageConfirmation, requestImageExtraction } from '../src/image-import'

const bytes = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217])
const image = { data: '/9j/4AAC/9k=', sha256: 'cd'.repeat(32), width: 320, height: 480 }
const fields = fieldsFromImageDraft({ name: 'สินค้า', brand: null, packageSize: null, sourcePriceMinor: null, upc: null, retailerCode: null })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function canvasFixture(blobs = [new Blob([bytes], { type: 'image/jpeg' })]) {
  const close = vi.fn(), drawImage = vi.fn(), fillRect = vi.fn()
  const bitmap = { width: 1600, height: 1200, close }
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, fillRect, fillStyle: '' }), toBlob: vi.fn((callback: BlobCallback) => callback(blobs.shift() ?? null)) }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap)); vi.stubGlobal('document', { createElement: () => canvas })
  return { close, drawImage, fillRect, canvas, bitmap }
}
describe('product-only crop geometry and JPEG encoding', () => {
  it('starts inside the product photo area of tall screenshots instead of selecting the entire screen', () => {
    const box = defaultCropBounds(590, 1280)
    expect(validCropBounds(box)).toBe(true)
    expect(box.y).toBeGreaterThan(.1); expect(box.y + box.height).toBeLessThan(.65)
    expect(box.width * box.height).toBeLessThan(.5)
    expect(defaultCropBounds(800, 600)).toEqual({ x: .08, y: .08, width: .84, height: .84 })
  })
  it.each([{ x: -1, y: 0, width: .5, height: .5 }, { x: 0, y: 0, width: 1.1, height: .5 }, { x: 0, y: 0, width: 0, height: .5 }, { x: 0, y: Number.NaN, width: .5, height: .5 }])('rejects invalid crop bounds %#', async box => {
    expect(validCropBounds(box)).toBe(false)
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    await expect(cropProductImage(new Blob(['source'], { type: 'image/jpeg' }), box)).rejects.toThrow('กรอบรูป')
    expect(decode).not.toHaveBeenCalled()
  })
  it('keeps movement and resize bounds inside the image', () => {
    expect(constrainCropBounds({ x: -1, y: 2, width: .5, height: .5 })).toEqual({ x: 0, y: .5, width: .5, height: .5 })
    const box = constrainCropBounds({ x: Infinity, y: NaN, width: -2, height: 4 })
    expect(validCropBounds(box)).toBe(true)
  })
  it('draws only selected source pixels, retains aspect ratio, caps the large edge and hashes the re-encoded JPEG', async () => {
    const { canvas, bitmap, drawImage, fillRect, close } = canvasFixture()
    const result = await cropProductImage(new Blob(['original screenshot metadata'], { type: 'image/png' }), { x: .25, y: .125, width: .5, height: .5 })
    expect([canvas.width, canvas.height]).toEqual([640, 480])
    expect(drawImage).toHaveBeenCalledWith(bitmap, 400, 150, 800, 600, 0, 0, 640, 480)
    expect(fillRect).toHaveBeenCalledWith(0, 0, 640, 480)
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', .88)
    expect(result.data).toBe(btoa(String.fromCharCode(...bytes)))
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
    expect(result.sha256).toBe(hash); expect(Object.isFrozen(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('original screenshot metadata')
    expect(close).toHaveBeenCalledTimes(1); expect(isCroppedProductImage(result)).toBe(true)
  })
  it('reduces quality and dimensions when the first JPEG exceeds the bounded payload', async () => {
    const { canvas, close } = canvasFixture([new Blob([new Uint8Array(MAX_PRODUCT_IMAGE_BYTES + 1)], { type: 'image/jpeg' }), new Blob([bytes], { type: 'image/jpeg' })])
    const result = await cropProductImage(new Blob(['source'], { type: 'image/jpeg' }), { x: 0, y: 0, width: 1, height: 1 })
    expect(canvas.toBlob).toHaveBeenCalledTimes(2); expect([result.width, result.height]).toEqual([512, 384]); expect(close).toHaveBeenCalledTimes(1)
  })
  it('refuses too-small crops and releases decoded image resources on failure', async () => {
    const { close } = canvasFixture()
    await expect(cropProductImage(new Blob(['source'], { type: 'image/jpeg' }), { x: 0, y: 0, width: .001, height: .001 })).rejects.toThrow('เล็กเกินไป')
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('rejects an extremely narrow crop instead of stretching it after downscaling', async () => {
    const { close, drawImage } = canvasFixture()
    await expect(cropProductImage(new Blob(['source'], { type: 'image/jpeg' }), { x: 0, y: 0, width: .01, height: 1 })).rejects.toThrow('กรอบแคบ')
    expect(drawImage).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1)
  })
  it('does not decode an already aborted crop or keep a result when cancelled during encoding', async () => {
    const controller = new AbortController(); controller.abort()
    const fixture = canvasFixture()
    await expect(cropProductImage(new Blob(['source'], { type: 'image/jpeg' }), { x: 0, y: 0, width: 1, height: 1 }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(createImageBitmap).not.toHaveBeenCalled()
    const second = new AbortController()
    fixture.canvas.toBlob.mockImplementation(callback => { second.abort(); callback(new Blob([bytes], { type: 'image/jpeg' })) })
    await expect(cropProductImage(new Blob(['source'], { type: 'image/jpeg' }), { x: 0, y: 0, width: 1, height: 1 }, second.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.close).toHaveBeenCalledTimes(1)
  })
  it('rejects unsupported original formats and malformed crop payloads', () => {
    expect(isCroppedProductImage(image)).toBe(true)
    for (const value of [{ ...image, width: 641 }, { ...image, height: 15 }, { ...image, sha256: 'wrong' }, { ...image, data: 'data:image/jpeg;base64,x' }, { ...image, extra: true }, { ...image, data: 'a'.repeat(200000) }]) expect(isCroppedProductImage(value)).toBe(false)
    expect(cropPreviewUrl(image)).toBe(`data:image/jpeg;base64,${image.data}`)
  })
})
describe('crop confirmation keeps existing import retry safety', () => {
  function storageFixture() {
    const data = new Map<string, string>()
    return { data, get length() { return data.size }, key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  }
  it('keeps a legacy payload byte-compatible and freezes only the explicitly supplied crop', () => {
    const uuid = crypto.randomUUID(), sourceHash = 'ab'.repeat(32)
    const legacy = createImageImportAttempt(fields, sourceHash, uuid)
    expect(Object.keys(legacy.payload)).toHaveLength(9); expect(legacy.payload).not.toHaveProperty('productImage')
    const crop = createImageImportAttempt(fields, sourceHash, uuid, image)
    expect(crop.payload.productImage).toEqual(image); expect(Object.isFrozen(crop.payload.productImage)).toBe(true)
    expect(() => createImageImportAttempt(fields, sourceHash, uuid, { ...image, width: 900 })).toThrow('ครอป')
  })
  it('persists only the final bounded crop with its same UUID and blocks an altered crop under that UUID', () => {
    const storage = storageFixture(), attempt = createImageImportAttempt(fields, 'ab'.repeat(32), undefined, image)
    persistPendingImageAttempt('owner', attempt, storage)
    expect(loadPendingImageAttempt('owner', storage)).toEqual(attempt)
    expect(loadPendingImageAttempt('other', storage)).toBeNull()
    const altered = createImageImportAttempt(fields, 'ab'.repeat(32), attempt.payload.operationId, { ...image, width: 300 })
    expect(() => persistPendingImageAttempt('owner', altered, storage)).toThrow('PAYLOAD_CONFLICT')
    const raw = [...storage.data.values()][0]
    expect(raw).not.toContain('blob:'); expect(raw).not.toContain('data:image'); expect(JSON.parse(raw).payload.productImage).toEqual(image)
  })
  it('rejects stored original screenshot or arbitrary payload keys rather than silently dropping unknown bytes', () => {
    const storage = storageFixture(), attempt = createImageImportAttempt(fields, 'ab'.repeat(32), undefined, image)
    persistPendingImageAttempt('owner', attempt, storage)
    const key = storage.key(0)!, raw = JSON.parse(storage.getItem(key)!)
    raw.payload.productImage.originalScreenshot = 'sensitive original'
    storage.setItem(key, JSON.stringify(raw))
    expect(() => loadPendingImageAttempt('owner', storage)).toThrow('INVALID')
  })
  it.each([['PRODUCT_IMAGE_INVALID', 400], ['PRODUCT_IMAGE_TOO_LARGE', 413]] as const)('only unlocks a known definite invalid-crop response %s', async (code, status) => {
    const attempt = createImageImportAttempt(fields, 'ab'.repeat(32), undefined, image)
    const response = () => Promise.resolve(new Response(JSON.stringify({ error: { code } }), { status }))
    expect(await requestImageConfirmation(attempt, response)).toMatchObject({ status: 'error', code })
    expect(await requestImageConfirmation(attempt, () => Promise.resolve(new Response(JSON.stringify({ error: { code } }), { status: 500 })))).toMatchObject({ status: 'uncertain' })
  })
  it('accepts optional AI bounds without an additional request and ignores malformed ones', async () => {
    const draft = { name: 'สินค้า', brand: null, packageSize: null, sourcePriceMinor: null, upc: null, retailerCode: null }
    const send = (bounds: unknown) => async () => new Response(JSON.stringify({ data: { draft: { ...draft, productImageBounds: bounds }, imageSha256: 'ab'.repeat(32), warnings: [] } }))
    const box = { x: .1, y: .2, width: .5, height: .3 }
    expect(await requestImageExtraction(new Blob(['source'], { type: 'image/jpeg' }), send(box))).toMatchObject({ status: 'success', draft: { productImageBounds: box } })
    const bad = await requestImageExtraction(new Blob(['source'], { type: 'image/jpeg' }), send({ x: -1 }))
    expect(bad).toMatchObject({ status: 'success' }); if (bad.status === 'success') expect(bad.draft).not.toHaveProperty('productImageBounds')
  })
})

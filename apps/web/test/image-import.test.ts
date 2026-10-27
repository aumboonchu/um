import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImageImport } from '../src/ImageImport'
import {
  clearPendingImageAttempt, createImageImportAttempt, emptyImageFields, fieldsFromImageDraft, imageFingerprint,
  loadPendingImageAttempt, persistPendingImageAttempt, requestPersistedImageConfirmation,
  MAX_SOURCE_IMAGE_BYTES, MAX_UPLOAD_IMAGE_BYTES, prepareImageUpload,
  requestImageConfirmation, requestImageExtraction, validateImageProductFields, validateSourceImage,
  type ImageDraft,
} from '../src/image-import'

const hash = 'ab'.repeat(32)
const operationId = '12345678-1234-4123-8123-123456789abc'
const draft: ImageDraft = {
  name: 'สินค้าจากภาพ', brand: 'แบรนด์ทดสอบ', packageSize: '600 มล.',
  sourcePriceMinor: 1250, upc: null, retailerCode: '60560',
}
const fields = fieldsFromImageDraft(draft)
const product = {
  id: 'product-confirmed', sku: `IMG-${operationId}`, upc: null, sourceProductId: null,
  name: 'สินค้าจากภาพ', brand: 'แบรนด์ทดสอบ', packageSize: '600 มล.', imageUrl: null,
  source: 'smartcart', sourcePriceMinor: 1250, regularPriceMinor: null, fetchedAt: null,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('source image and upload preparation', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts supported source type %s', (type) => {
    expect(validateSourceImage({ type, size: MAX_SOURCE_IMAGE_BYTES })).toBeNull()
  })

  it.each([
    { type: 'image/heic', size: 100 },
    { type: 'text/plain', size: 100 },
    { type: 'image/png', size: 0 },
    { type: 'image/png', size: MAX_SOURCE_IMAGE_BYTES + 1 },
  ])('explains unsupported or oversized source %#', (source) => {
    expect(validateSourceImage(source)).toBeTypeOf('string')
  })

  it('resizes to a longest edge of 1600 and encodes JPEG at .85 on a white background', async () => {
    const close = vi.fn()
    const drawImage = vi.fn()
    const fillRect = vi.fn()
    const context = { fillStyle: '', drawImage, fillRect }
    const result = new Blob(['prepared JPEG'], { type: 'image/jpeg' })
    const toBlob = vi.fn((callback: BlobCallback) => callback(result))
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob }
    const bitmap = { width: 3200, height: 1600, close }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    expect(await prepareImageUpload(new Blob(['source'], { type: 'image/png' }))).toBe(result)
    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(800)
    expect(context.fillStyle).toBe('#fff')
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1600, 800)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1600, 800)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', .85)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not enlarge small images and rejects a prepared upload over 3 MiB', async () => {
    const close = vi.fn()
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array(MAX_UPLOAD_IMAGE_BYTES + 1)], { type: 'image/jpeg' })) }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 400, height: 200, close }))
    vi.stubGlobal('document', { createElement: () => canvas })
    await expect(prepareImageUpload(new Blob(['source'], { type: 'image/png' }))).rejects.toThrow('3 MB')
    expect([canvas.width, canvas.height]).toEqual([400, 200])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stops before decoding an already cancelled image', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const controller = new AbortController()
    controller.abort()
    await expect(prepareImageUpload(new Blob(['source'], { type: 'image/png' }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('fingerprints the actual prepared bytes without persisting the image', async () => {
    const first = await imageFingerprint(new Blob(['prepared image']))
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await imageFingerprint(new Blob(['prepared image']))).toBe(first)
    expect(await imageFingerprint(new Blob(['different image']))).not.toBe(first)
  })
})

describe('image extraction is read-only and requires human review', () => {
  it('posts the exact prepared raw blob with its image Content-Type, never confirmation JSON', async () => {
    const blob = new Blob(['prepared'], { type: 'image/jpeg' })
    const send = vi.fn<(init: RequestInit) => Promise<Response>>().mockResolvedValue(json({ data: { draft, imageSha256: hash, warnings: ['ตรวจสอบราคา'] } }))
    const result = await requestImageExtraction(blob, send)
    expect(result).toEqual({ status: 'success', draft, imageSha256: hash, warnings: ['ตรวจสอบราคา'] })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].body).toBe(blob)
    expect(send.mock.calls[0][0].method).toBe('POST')
    expect(new Headers(send.mock.calls[0][0].headers).get('Content-Type')).toBe('image/jpeg')
    expect(result).not.toHaveProperty('product')
  })

  it('never converts the visible retailer code into UPC', () => {
    expect(fields.retailerCode).toBe('60560')
    expect(fields.upc).toBe('')
    expect(fields.sourcePrice).toBe('12.50')
    expect(fieldsFromImageDraft({ ...draft, sourcePriceMinor: null, name: null }).name).toBe('')
  })

  it.each(['IMAGE_UNREADABLE', 'IMAGE_AI_UNAVAILABLE', 'IMAGE_QUOTA_EXCEEDED', 'IMAGE_TOO_LARGE', 'IMAGE_UNSUPPORTED', 'UNAUTHENTICATED'])('explains extraction failure %s without creating a SKU', async (code) => {
    const result = await requestImageExtraction(new Blob(['prepared'], { type: 'image/jpeg' }), async () => json({ error: { code } }, 422))
    expect(result).toMatchObject({ status: 'error', code })
    expect(result).not.toHaveProperty('product')
  })

  it('rejects malformed extraction success rather than silently generating a product', async () => {
    const result = await requestImageExtraction(new Blob(['prepared'], { type: 'image/jpeg' }), async () => json({ data: { draft, imageSha256: 'invalid', warnings: [] } }))
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_RESPONSE' })
    expect(result).not.toHaveProperty('product')
  })

  it('does not send oversized prepared bytes', async () => {
    const send = vi.fn()
    const blob = new Blob([new Uint8Array(MAX_UPLOAD_IMAGE_BYTES + 1)], { type: 'image/jpeg' })
    expect(await requestImageExtraction(blob, send)).toMatchObject({ status: 'error', code: 'IMAGE_TOO_LARGE' })
    expect(send).not.toHaveBeenCalled()
  })

  it('settles on timeout even if transport ignores abort, without claiming a write occurred', async () => {
    vi.useFakeTimers()
    const pending = requestImageExtraction(new Blob(['prepared'], { type: 'image/jpeg' }), () => new Promise(() => {}), { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await pending).toMatchObject({ status: 'error', code: 'IMAGE_TIMEOUT' })
  })
})

describe('confirmed product fields and immutable retry identities', () => {
  it('requires a product name and validates price, field limits and actual UPC checksum', () => {
    expect(validateImageProductFields(emptyImageFields())).toContain('ชื่อสินค้า')
    expect(validateImageProductFields({ ...fields, upc: '60560' })).toContain('UPC')
    expect(validateImageProductFields({ ...fields, upc: '00000000' })).toContain('UPC')
    expect(validateImageProductFields({ ...fields, upc: '8851959129013' })).toContain('UPC')
    expect(validateImageProductFields({ ...fields, upc: '8851959129012' })).toBeNull()
    expect(validateImageProductFields({ ...fields, sourcePrice: '-1' })).toContain('ราคา')
    expect(validateImageProductFields({ ...fields, sourcePrice: '12.345' })).toContain('ราคา')
    expect(validateImageProductFields({ ...fields, sourcePrice: '1000000.01' })).toContain('ราคา')
    expect(validateImageProductFields({ ...fields, retailerCode: 'x'.repeat(81) })).toContain('80')
  })

  it('builds a frozen explicit confirmation with distinct retailer code and no image bytes', () => {
    const result = createImageImportAttempt({ ...fields, name: '  สินค้า\n จากภาพ  ', sourcePrice: '1,234.50' }, hash.toUpperCase(), operationId)
    expect(result.payload).toEqual({
      operationId, confirmed: true, name: 'สินค้า จากภาพ', brand: draft.brand, packageSize: draft.packageSize,
      sourcePriceMinor: 123450, upc: null, retailerCode: '60560', imageSha256: hash,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.payload)).toBe(true)
    expect(Object.keys(result.payload)).not.toContain('image')
    expect(result.payload).not.toHaveProperty('sourceProductId')
    expect(() => { (result.payload as { name: string }).name = 'changed' }).toThrow()
  })

  it('retains exact operation UUID and payload when retrying an uncertain save', async () => {
    const editable = { ...fields }
    const pending = createImageImportAttempt(editable, hash, operationId)
    const send = vi.fn<(init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Network disconnected'))
      .mockResolvedValueOnce(json({ data: product }, 201))
    expect(await requestImageConfirmation(pending, send)).toMatchObject({ status: 'uncertain' })
    editable.name = 'A later edit must not change the attempted write'
    expect(await requestImageConfirmation(pending, send)).toEqual({ status: 'success', product })
    expect(send.mock.calls[0][0].body).toBe(send.mock.calls[1][0].body)
    expect(JSON.parse(String(send.mock.calls[1][0].body))).toMatchObject({ operationId, name: draft.name, confirmed: true })
  })

  it.each([
    [json({ data: { ...product, sku: undefined } }), 'INVALID_RESPONSE'],
    [json({ error: { code: 'INTERNAL_ERROR' } }, 500), 'INTERNAL_ERROR'],
    [json({ error: { code: 'IMAGE_IMPORT_CONFLICT' } }, 409), 'IMAGE_IMPORT_CONFLICT'],
  ])('treats unconfirmed save response %# as uncertain, never success or rollback', async (response, code) => {
    expect(await requestImageConfirmation(createImageImportAttempt(fields, hash, operationId), async () => response)).toMatchObject({ status: 'uncertain', code })
  })

  it('keeps definitive validation failures editable rather than claiming success', async () => {
    const result = await requestImageConfirmation(createImageImportAttempt(fields, hash, operationId), async () => json({ error: { code: 'INVALID_IMAGE_PRODUCT' } }, 400))
    expect(result).toMatchObject({ status: 'error', code: 'INVALID_IMAGE_PRODUCT' })
    expect(result).not.toHaveProperty('product')
  })

  it('cancels an in-flight confirmation even if transport never resolves', async () => {
    const controller = new AbortController()
    const pending = requestImageConfirmation(createImageImportAttempt(fields, hash, operationId), () => new Promise(() => {}), { signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ status: 'cancelled' })
  })

  it('does not accept a late successful save after timeout', async () => {
    vi.useFakeTimers()
    let resolve!: (response: Response) => void
    const send = () => new Promise<Response>((done) => { resolve = done })
    const pending = requestImageConfirmation(createImageImportAttempt(fields, hash, operationId), send, { timeoutMs: 30 })
    await vi.advanceTimersByTimeAsync(30)
    const timedOut = await pending
    expect(timedOut).toMatchObject({ status: 'uncertain', code: 'IMAGE_SAVE_TIMEOUT' })
    resolve(json({ data: product }, 201))
    await Promise.resolve()
    expect(await pending).toEqual(timedOut)
  })
})

describe('durable pending image confirmations', () => {
  function storageFixture() {
    const data = new Map<string, string>()
    return {
      data,
      get length() { return data.size },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      removeItem: (key: string) => { data.delete(key) },
    }
  }

  it('restores exactly the confirmed fields and UUID after navigation/reload, never image bytes', async () => {
    const storage = storageFixture()
    const first = createImageImportAttempt(fields, hash, operationId)
    const bodies: unknown[] = []
    const send = vi.fn(async (init: RequestInit) => { bodies.push(init.body); throw new TypeError('offline') })
    expect(await requestPersistedImageConfirmation('account-a', first, send, {}, storage)).toMatchObject({ status: 'uncertain' })
    const restored = loadPendingImageAttempt('account-a', storage)!
    expect(restored).toEqual(first)
    expect(Object.isFrozen(restored.payload)).toBe(true)
    await requestPersistedImageConfirmation('account-a', restored, send, {}, storage)
    expect(bodies[0]).toBe(bodies[1])
    const saved = JSON.parse([...storage.data.values()][0])
    expect(Object.keys(saved)).toEqual(['version', 'accountId', 'createdAt', 'payload'])
    expect(Object.keys(saved.payload)).toEqual(Object.keys(first.payload))
    expect(JSON.stringify(saved)).not.toContain('data:image')
  })

  it('isolates accounts and only clears the exact account/operation receipt', () => {
    const storage = storageFixture()
    const first = createImageImportAttempt(fields, hash, operationId)
    persistPendingImageAttempt('account-a', first, storage)
    expect(loadPendingImageAttempt('account-b', storage)).toBeNull()
    persistPendingImageAttempt('account-b', first, storage)
    clearPendingImageAttempt('account-a', crypto.randomUUID(), storage)
    expect(loadPendingImageAttempt('account-a', storage)).toEqual(first)
    clearPendingImageAttempt('account-a', operationId, storage)
    expect(loadPendingImageAttempt('account-a', storage)).toBeNull()
    expect(loadPendingImageAttempt('account-b', storage)).toEqual(first)
  })

  it('does not send a confirmation when durable storage fails or silently drops writes', async () => {
    const first = createImageImportAttempt(fields, hash, operationId)
    for (const setItem of [() => { throw new Error('quota') }, () => {}]) {
      const storage = { ...storageFixture(), setItem }
      const send = vi.fn()
      await expect(requestPersistedImageConfirmation('account-a', first, send, {}, storage)).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('blocks replacement with a new UUID or edited payload while a pending confirmation exists', () => {
    const storage = storageFixture()
    const first = createImageImportAttempt(fields, hash, operationId)
    persistPendingImageAttempt('account-a', first, storage)
    expect(() => persistPendingImageAttempt('account-a', createImageImportAttempt(fields, hash), storage)).toThrow('OTHER_OPERATION')
    expect(() => persistPendingImageAttempt('account-a', createImageImportAttempt({ ...fields, name: 'changed' }, hash, operationId), storage)).toThrow('PAYLOAD_CONFLICT')
    expect(loadPendingImageAttempt('account-a', storage)).toEqual(first)
  })

  it.each([401, 403, 409, 500])('retains the durable operation after HTTP %s, including expired login on retry', async (status) => {
    const storage = storageFixture()
    const first = createImageImportAttempt(fields, hash, operationId)
    const result = await requestPersistedImageConfirmation('account-a', first, async () => json({ error: { code: 'TEST_ERROR' } }, status), {}, storage)
    expect(result.status).toBe('uncertain')
    expect(loadPendingImageAttempt('account-a', storage)).toEqual(first)
  })

  it('fails closed on corrupt data rather than forgetting its operation', async () => {
    const storage = storageFixture()
    const first = createImageImportAttempt(fields, hash, operationId)
    persistPendingImageAttempt('account-a', first, storage)
    const key = storage.key(0)!
    storage.setItem(key, '{corrupt')
    expect(() => loadPendingImageAttempt('account-a', storage)).toThrow('INVALID')
    const send = vi.fn()
    await expect(requestPersistedImageConfirmation('account-a', first, send, {}, storage)).rejects.toThrow('INVALID')
    expect(send).not.toHaveBeenCalled()
    expect(storage.getItem(key)).toBe('{corrupt')
  })

  it('does not report local receipt cleared if the storage silently retains it', () => {
    const storage = storageFixture()
    persistPendingImageAttempt('account-a', createImageImportAttempt(fields, hash, operationId), storage)
    storage.removeItem = () => {}
    expect(() => clearPendingImageAttempt('account-a', operationId, storage)).toThrow('STORAGE_UNAVAILABLE')
  })
})

describe('initial screenshot import UI', () => {
  it('explains Cloudflare AI image handling and does not present an automatic save action', () => {
    const onProduct = vi.fn()
    const html = renderToStaticMarkup(createElement(ImageImport, { accountId: 'account-a', apiOrigin: 'http://localhost:8787', canImport: true, onProduct }))
    expect(html).toContain('Cloudflare AI')
    expect(html).toContain('ไม่บันทึกภาพต้นฉบับลงฐานข้อมูล')
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"')
    expect(html).not.toContain('ยืนยันและบันทึกสินค้าเป็น SKU')
    expect(html).not.toContain('type="checkbox"')
    expect(onProduct).not.toHaveBeenCalled()
  })

  it('disables image selection when the user is not signed in or online', () => {
    const html = renderToStaticMarkup(createElement(ImageImport, { accountId: null, apiOrigin: 'http://localhost:8787', canImport: false, onProduct: vi.fn() }))
    expect(html.match(/<input[^>]+type="file"[^>]+>/)?.[0]).toContain('disabled=""')
    expect(html).toContain('เข้าสู่ระบบด้วย Google และเชื่อมต่ออินเทอร์เน็ต')
  })
})

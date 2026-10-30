import { describe, expect, it } from 'vitest'
import { stripJpegMetadata } from '../../web/src/jpeg-metadata'
import { parseProductImage } from '../src/product-images'

// Real 32×32 solid-color JPEG generated locally with an encoder. No user image or screenshot.
const jpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDQooor648MKKKKACiiigAooooA/9k='
const bytes = Uint8Array.from(atob(jpeg), c => c.charCodeAt(0))
async function payload(data: Uint8Array<ArrayBuffer>) {
  return { data: btoa(String.fromCharCode(...data)), sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join(''), width: 32, height: 32 }
}
describe('real encoded JPEG from client normalization through Worker validation', () => {
  it('accepts a normal encoded crop without changing its hash or bytes', async () => {
    const normalized = stripJpegMetadata(bytes)
    expect(normalized).toEqual(bytes)
    expect((await parseProductImage(await payload(normalized))).bytes).toEqual(bytes)
  })
  it.each([0xe1, 0xed, 0xfe])('reproduces rejection of browser ancillary segment %i then accepts metadata-free output', async marker => {
    const metadata = new TextEncoder().encode('Exif\0\0PRIVATE GPS / comment')
    const generated = Uint8Array.from([255, 216, 255, marker, 0, metadata.length + 2, ...metadata, ...bytes.slice(2)])
    await expect(parseProductImage(await payload(generated))).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' })
    const normalized = stripJpegMetadata(generated)
    expect(normalized).toEqual(bytes)
    const image = await parseProductImage(await payload(normalized))
    expect(image.bytes).toEqual(bytes)
    expect(image.sha256).toBe((await payload(bytes)).sha256)
  })
})

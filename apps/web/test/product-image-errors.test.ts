import { describe, expect, it } from 'vitest'
import { productImageFailureMessage, productImageFailureReason } from '../src/product-image-errors'

describe('bounded product image diagnostics', () => {
  it.each(['INVALID_PAYLOAD', 'INVALID_BASE64', 'INVALID_JPEG', 'UNSUPPORTED_JPEG', 'INVALID_DIMENSIONS', 'HASH_MISMATCH', 'IMAGE_TOO_LARGE', 'REQUEST_TOO_LARGE', 'JPEG_METADATA'])('recognizes only the known reason %s', reason => {
    expect(productImageFailureReason(reason)).toBe(reason)
    const message = productImageFailureMessage('PRODUCT_IMAGE_INVALID', reason)
    expect(message).toContain('ยังบันทึกรูปไม่ได้:')
    expect(message).toContain(`PRODUCT_IMAGE_INVALID / ${reason}`)
    expect(message).not.toContain('ครอปใหม่')
    expect(message).not.toContain('รูปยังไม่ถูกต้อง')
  })
  it.each([null, undefined, {}, ['INVALID_JPEG'], 'INVALID_JPEG\nsecret-image', 'RAW_DATA_/9j/secret', 'INVALID_JPEG'.repeat(100)])('does not display arbitrary diagnostic input: %j', reason => {
    expect(productImageFailureReason(reason)).toBeUndefined()
    const message = productImageFailureMessage('PRODUCT_IMAGE_INVALID', reason)
    expect(message).toContain('PRODUCT_IMAGE_INVALID)')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('/9j/')
  })
  it('distinguishes byte limits from JPEG parsing and dimensions without blaming the crop', () => {
    expect(productImageFailureMessage('PRODUCT_IMAGE_TOO_LARGE', 'IMAGE_TOO_LARGE')).toContain('128 KB')
    expect(productImageFailureMessage('PRODUCT_IMAGE_INVALID', 'INVALID_JPEG')).toContain('อ่านไฟล์ JPEG')
    expect(productImageFailureMessage('PRODUCT_IMAGE_INVALID', 'INVALID_DIMENSIONS')).toContain('16–640')
    expect(productImageFailureMessage('PRODUCT_IMAGE_INVALID', 'HASH_MISMATCH')).toContain('ไม่ตรงกับไฟล์ที่ส่ง')
  })
})

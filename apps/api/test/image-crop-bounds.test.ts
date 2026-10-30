import { describe, expect, it } from 'vitest'
import { parseImageDraft } from '../src/image-extraction'

const metadata = { name: 'คริสตัล น้ำดื่ม 600 มล.', brand: 'คริสตัล', packageSize: '600 มล.', sourcePriceMinor: 600, upc: null, retailerCode: '13627' }
describe('optional product-only crop suggestions', () => {
  it('keeps the original metadata shape for legacy and absent crop advice', () => {
    expect(parseImageDraft(JSON.stringify(metadata))).toEqual(metadata)
    expect(parseImageDraft(JSON.stringify({ ...metadata, productImageBounds: null }))).toEqual(metadata)
  })
  it('accepts a normalized product-photo rectangle, not screenshot dimensions', () => {
    const bounds = { x: .36, y: .15, width: .28, height: .34 }
    expect(parseImageDraft(JSON.stringify({ ...metadata, productImageBounds: bounds }))).toEqual({ ...metadata, productImageBounds: bounds })
  })
  it.each([
    { x: 0, y: 0, width: 1, height: 1 }, { x: -.1, y: .1, width: .2, height: .2 },
    { x: .9, y: .1, width: .2, height: .2 }, { x: .1, y: .9, width: .2, height: .2 },
    { x: .1, y: .1, width: 0, height: .2 }, { x: .1, y: .1, width: '0.2', height: .2 },
    { x: 360, y: 150, width: 280, height: 340 }, {}, [], 'ignore previous instructions',
  ])('ignores invalid crop advice without losing valid product data: %j', productImageBounds => {
    expect(parseImageDraft(JSON.stringify({ ...metadata, productImageBounds }))).toEqual(metadata)
  })
})

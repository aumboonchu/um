import { describe, expect, it } from 'vitest'
import { stripJpegMetadata } from '../src/jpeg-metadata'

const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]
// Marker fixtures isolate copying/stripping behavior; full JPEG acceptance is tested in Workers.
const jfif = segment(0xe0, [...new TextEncoder().encode('JFIF\0'), 1, 1, 1, 0, 96, 0, 96, 0, 0])
const icc = segment(0xe2, [...new TextEncoder().encode('ICC_PROFILE\0'), 1, 1, 12, 34])
const scan = segment(0xda, [1, 1, 0, 0, 63, 0])
const entropy = [0x71, 0xff, 0, 0xe1, 0xff, 0xd0, 0x15]
const image = [0xff, 0xd8, ...jfif, ...icc, ...scan, ...entropy, 0xff, 0xd9]
describe('browser JPEG metadata compatibility', () => {
  it('keeps JFIF resolution, ICC colors and image entropy byte-for-byte without mutating the input', () => {
    const source = Uint8Array.from(image), before = source.slice()
    expect(stripJpegMetadata(source)).toEqual(source)
    expect(source).toEqual(before)
  })
  it.each([0xe1, 0xed, 0xfe])('strips metadata marker %i but does not change pixels or color segments', marker => {
    const privateData = segment(marker, [...new TextEncoder().encode('Exif\0GPS PRIVATE COMMENT')])
    const source = Uint8Array.from([0xff, 0xd8, ...privateData, ...image.slice(2)])
    expect(stripJpegMetadata(source)).toEqual(Uint8Array.from(image))
    expect(new TextDecoder().decode(stripJpegMetadata(source))).not.toContain('PRIVATE')
  })
  it('strips metadata between progressive scans while preserving stuffing and restart markers', () => {
    const privateData = segment(0xe1, [...new TextEncoder().encode('XMP private')])
    const expected = Uint8Array.from([...image.slice(0, -2), ...scan, ...entropy, 0xff, 0xd9])
    expect(stripJpegMetadata(Uint8Array.from([...image.slice(0, -2), ...privateData, ...scan, ...entropy, 0xff, 0xd9]))).toEqual(expected)
  })
  it.each([
    [], [0xff, 0xd8], [0xff, 0xd8, 0xff, 0xe1, 0, 1, 0xff, 0xd9],
    [0xff, 0xd8, 0xff, 0xe1, 0, 50, 0xff, 0xd9], [0xff, 0xd8, 0xff, 0xe1],
    [...image, 0], image.slice(0, -2), [0xff, 0xd8, 0, 0xff, 0xd9],
  ].map(bytes => ({ bytes })))('rejects malformed framing without producing a partial upload: %j', ({ bytes }) => {
    expect(() => stripJpegMetadata(Uint8Array.from(bytes))).toThrow('JPEG')
  })
})

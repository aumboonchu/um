/** Remove privacy-bearing JPEG segments without decoding or changing image/color data.
 * Canvas encoders differ by browser: re-encoding does not imply metadata-free output.
 * This bounded marker walk is not a replacement for server-side JPEG validation.
 */
export function stripJpegMetadata(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const malformed = (): never => { throw new Error('เตรียมไฟล์ JPEG ไม่สำเร็จ กรุณาเลือกรูปอีกครั้ง') }
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) return malformed()
  const kept: Uint8Array[] = [source.subarray(0, 2)]
  let position = 2, scanning = false, total = 2
  const keep = (start: number, end: number) => { kept.push(source.subarray(start, end)); total += end - start }
  while (position < source.length) {
    if (scanning) {
      const start = position
      while (position < source.length) {
        if (source[position] !== 0xff) { position += 1; continue }
        const markerStart = position
        while (source[position] === 0xff) position += 1
        const marker = source[position]
        if (marker === 0 || marker >= 0xd0 && marker <= 0xd7) { position += 1; continue }
        position = markerStart
        break
      }
      keep(start, position); scanning = false
      if (position === source.length) return malformed()
    }
    const start = position
    if (source[position++] !== 0xff) return malformed()
    while (source[position] === 0xff) position += 1
    const marker = source[position++]
    if (marker === 0xd9) {
      if (position !== source.length) return malformed()
      keep(start, position)
      const result = new Uint8Array(total); let offset = 0
      for (const part of kept) { result.set(part, offset); offset += part.length }
      return result
    }
    if (marker === undefined || marker === 0 || marker === 1 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7
      || position + 2 > source.length) return malformed()
    const length = source[position] * 256 + source[position + 1]
    if (length < 2 || position + length > source.length) return malformed()
    position += length
    // Keep JFIF, ICC and Adobe color-transform information. Strip EXIF/XMP, Photoshop and comments.
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) keep(start, position)
    if (marker === 0xda) scanning = true
  }
  return malformed()
}

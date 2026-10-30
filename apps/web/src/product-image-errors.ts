const PRODUCT_IMAGE_FAILURE_REASONS = [
  'INVALID_PAYLOAD', 'INVALID_BASE64', 'INVALID_JPEG', 'UNSUPPORTED_JPEG',
  'INVALID_DIMENSIONS', 'HASH_MISMATCH', 'IMAGE_TOO_LARGE', 'REQUEST_TOO_LARGE', 'JPEG_METADATA',
] as const

export type ProductImageFailureReason = typeof PRODUCT_IMAGE_FAILURE_REASONS[number]

/** Only bounded, known reason codes are displayable; never echo provider text or image bytes. */
export function productImageFailureReason(value: unknown): ProductImageFailureReason | undefined {
  return PRODUCT_IMAGE_FAILURE_REASONS.find(reason => value === reason)
}

export function productImageFailureMessage(code: 'PRODUCT_IMAGE_INVALID' | 'PRODUCT_IMAGE_TOO_LARGE', rawReason?: unknown): string {
  const reason = productImageFailureReason(rawReason)
  const details: Record<ProductImageFailureReason, string> = {
    INVALID_PAYLOAD: 'ข้อมูลไฟล์รูปไม่ครบ กรุณาเลือกภาพเดิมอีกครั้ง',
    INVALID_BASE64: 'ข้อมูลไฟล์รูปส่งมาไม่ครบ กรุณาลองบันทึกอีกครั้ง',
    INVALID_JPEG: 'ระบบอ่านไฟล์ JPEG นี้ไม่ได้ กรุณาเลือกภาพเดิมอีกครั้ง',
    UNSUPPORTED_JPEG: 'รูปแบบ JPEG นี้ยังไม่รองรับ กรุณาเลือกภาพอื่น',
    INVALID_DIMENSIONS: 'ขนาดรูปไม่ตรงตามที่ระบบรับได้ (ด้านละ 16–640 พิกเซล) กรุณาเลือกภาพเดิมอีกครั้ง',
    HASH_MISMATCH: 'ข้อมูลรูปไม่ตรงกับไฟล์ที่ส่ง กรุณาลองบันทึกอีกครั้ง',
    IMAGE_TOO_LARGE: 'ไฟล์รูปเกิน 128 KB กรุณาเลือกภาพเดิมเพื่อให้ระบบย่อใหม่',
    REQUEST_TOO_LARGE: 'ข้อมูลที่ส่งใหญ่เกินขนาดที่ระบบรับได้ กรุณาเลือกภาพเดิมอีกครั้ง',
    JPEG_METADATA: 'ไฟล์รูปมีข้อมูลเสริมที่ระบบไม่รับ กรุณาเลือกและยืนยันรูปอีกครั้ง',
  }
  const detail = reason ? details[reason] : code === 'PRODUCT_IMAGE_TOO_LARGE'
    ? 'ไฟล์รูปใหญ่เกินขนาดที่ระบบรับได้ กรุณาเลือกภาพเดิมเพื่อให้ระบบย่อใหม่'
    : 'ระบบตรวจไฟล์รูปไม่ผ่าน กรุณาเลือกภาพเดิมอีกครั้ง'
  return `ยังบันทึกรูปไม่ได้: ${detail} (รหัส: ${code}${reason ? ` / ${reason}` : ''})`
}

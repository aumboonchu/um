import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImportFeedback, type ImportFeedbackProps } from '../src/ImportFeedback'
import type { BigcImportState } from '../src/bigc-import'

function render(state: BigcImportState, options: Partial<ImportFeedbackProps> = {}) {
  return renderToStaticMarkup(createElement(ImportFeedback, {
    state,
    onRetry: vi.fn(),
    onEdit: vi.fn(),
    onManual: vi.fn(),
    canRetry: true,
    canManual: true,
    ...options,
  }))
}

function buttonMarkup(html: string, label: string): string | undefined {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((match) => match[0]).find((button) => button.includes(label))
}

describe('Big C import state feedback markup', () => {
  it('does not display feedback before an import begins', () => {
    expect(render({ status: 'idle' })).toBe('')
  })

  it('announces loading without implying that saving already succeeded', () => {
    const html = render({ status: 'loading' })
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('กำลังตรวจสอบลิงก์และบันทึกสินค้า')
    expect(html).toContain('ยังไม่ยืนยันว่าการเพิ่มสินค้าสำเร็จ')
    expect(html).not.toContain('เพิ่มสินค้าเข้าฐานข้อมูลแล้ว')
    expect(html).not.toContain('<button')
  })

  it('shows confirmed name and SKU while distinguishing a product from a saved purchase', () => {
    const html = render({ status: 'success', product: { name: 'สินค้า 600 มล.', sku: 'BIGC-123456' } })
    expect(html).toContain('role="status"')
    expect(html).toContain('เพิ่มสินค้าเข้าฐานข้อมูลแล้ว')
    expect(html).toContain('สินค้า 600 มล.')
    expect(html).toContain('BIGC-123456')
    expect(html).toContain('ยังไม่ได้บันทึกรายการซื้อ')
    expect(html).toContain('กรอกราคาที่ซื้อจริงและจำนวน')
    expect(html).toContain('บันทึกรายการซื้อ')
    expect(html).not.toContain('role="alert"')
  })

  it('escapes product data rather than injecting untrusted HTML', () => {
    const html = render({ status: 'success', product: { name: '<img src=x onerror=alert(1)>', sku: '<script>bad()</script>' } })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<script>bad()')
    expect(html).not.toContain('<img src=x')
  })

  it('prominently reports a blocked import, error code, and alternatives without automatic retry', () => {
    const html = render({ status: 'error', title: 'ยังไม่ได้เพิ่มสินค้า', message: 'Big C ไม่อนุญาตให้อ่านข้อมูล', code: 'BIGC_BLOCKED', retryable: false })
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('ยังไม่ได้เพิ่มสินค้า')
    expect(html).toContain('Big C ไม่อนุญาตให้อ่านข้อมูล')
    expect(html).toContain('BIGC_BLOCKED')
    expect(buttonMarkup(html, 'ลองนำเข้าอีกครั้ง')).toBeUndefined()
    expect(buttonMarkup(html, 'แก้ไขลิงก์')).toContain('type="button"')
    expect(buttonMarkup(html, 'ใช้ UPC / เพิ่มเอง')).toContain('type="button"')
    expect(html).not.toContain('เพิ่มสินค้าเข้าฐานข้อมูลแล้ว')
  })

  it('offers an explicit retry only for retryable failures and respects availability', () => {
    const state: BigcImportState = { status: 'error', title: 'ยังไม่ได้เพิ่มสินค้า', message: 'ลองใหม่ภายหลัง', code: 'BIGC_UNAVAILABLE', retryable: true }
    expect(buttonMarkup(render(state), 'ลองนำเข้าอีกครั้ง')).not.toContain('disabled')
    expect(buttonMarkup(render(state, { canRetry: false }), 'ลองนำเข้าอีกครั้ง')).toContain('disabled=""')
  })

  it('reports uncertainty honestly and offers verification with the same link', () => {
    const html = render({ status: 'uncertain', message: 'การเชื่อมต่อขาดหาย', code: 'CONNECTION_INTERRUPTED' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('ยังยืนยันผลการเพิ่มไม่ได้')
    expect(html).toContain('สินค้าอาจถูกบันทึกแล้ว')
    expect(html).toContain('CONNECTION_INTERRUPTED')
    expect(buttonMarkup(html, 'ตรวจสอบด้วยลิงก์เดิม')).toContain('type="button"')
    expect(html).not.toContain('ยังไม่ได้เพิ่มสินค้า')
    expect(html).not.toContain('เพิ่มสินค้าเข้าฐานข้อมูลแล้ว')
  })

  it('disables uncertain verification and manual alternatives when unavailable', () => {
    const html = render({ status: 'uncertain', message: 'รอการตอบกลับนานเกินไป' }, { canRetry: false, canManual: false })
    expect(buttonMarkup(html, 'ตรวจสอบด้วยลิงก์เดิม')).toContain('disabled=""')
    expect(buttonMarkup(html, 'ใช้ UPC / เพิ่มเอง')).toContain('disabled=""')
    expect(buttonMarkup(html, 'แก้ไขลิงก์')).not.toContain('disabled')
  })

  it('remains focusable for client-side feedback focus and names its announcement', () => {
    const html = render({ status: 'error', title: 'กรุณาตรวจสอบลิงก์', message: 'ลิงก์ไม่ถูกต้อง', retryable: false })
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-atomic="true"')
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(labelledBy).toBeTruthy()
    expect(html).toContain(`id="${labelledBy}"`)
  })
})


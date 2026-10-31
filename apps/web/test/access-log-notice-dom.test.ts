// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AccessLogNotice } from '../src/AccessLogNotice'

afterEach(cleanup)
describe('access-log privacy notice', () => {
  it('explains the limited security purpose, retention and recipients without a consent checkbox', () => {
    const { container } = render(createElement(AccessLogNotice))
    expect(container.querySelector('summary')?.textContent).toContain('ประวัติเข้าใช้งาน')
    expect(container.textContent).toContain('ประโยชน์โดยชอบด้วยกฎหมาย')
    expect(container.textContent).toContain('90 วัน')
    expect(container.textContent).toContain('รอบรายวัน')
    expect(container.textContent).toContain('Cloudflare Workers/D1')
    expect(container.querySelector('input')).toBeNull()
  })
  it('provides a rights contact and distinguishes logs from Google or necessary local storage', () => {
    const { container } = render(createElement(AccessLogNotice))
    expect(screen.getByRole('link').getAttribute('href')).toBe('mailto:a41s0165@gmail.com')
    expect(container.textContent).toContain('คัดค้าน')
    expect(container.textContent).toContain('ไม่เก็บรหัสผ่าน โทเคน คุกกี้ IP ดิบ')
    expect(container.textContent).toContain('การเข้าสู่ Google อยู่ภายใต้นโยบายของ Google')
    expect(container.textContent).toContain('รายการออฟไลน์ยังใช้พื้นที่เก็บข้อมูล')
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProductThumb } from '../src/ui'

afterEach(() => { cleanup(); document.body.style.overflow = ''; vi.restoreAllMocks() })
describe('cropped product thumbnail viewer', () => {
  it('opens only the same product image in a body portal without triggering the row action', () => {
    const action = vi.fn(), url = 'https://example.test/product-images/id/crop.jpg'
    const view = render(createElement('article', { onClick: action }, createElement(ProductThumb, { imageUrl: url })))
    const trigger = screen.getByRole('button', { name: 'ดูรูปสินค้า' })
    trigger.focus(); fireEvent.click(trigger.querySelector('img')!)
    const dialog = screen.getByRole('dialog', { name: 'รูปสินค้า' })
    expect(view.container.contains(dialog)).toBe(false)
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(url)
    expect(dialog.querySelectorAll('img')).toHaveLength(1)
    expect(dialog.textContent).toBe('×')
    expect(action).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'ปิดรูปสินค้า' }))
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'ปิดรูปสินค้า' }))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger)
    expect(action).not.toHaveBeenCalled(); expect(document.body.style.overflow).toBe('')
  })
  it('supports keyboard, traps focus, Escape and backdrop close', () => {
    render(createElement('div', null, createElement('button', null, 'outside'), createElement(ProductThumb, { imageUrl: 'https://example.test/crop.jpg' })))
    const trigger = screen.getByRole('button', { name: 'ดูรูปสินค้า' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const close = screen.getByRole('button', { name: 'ปิดรูปสินค้า' })
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(close)
    screen.getByRole('button', { name: 'outside' }).focus(); expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(trigger, { key: ' ' }); fireEvent.click(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('retains icon fallback on load failure and closes a stale viewer when the source changes', () => {
    const view = render(createElement(ProductThumb, { imageUrl: 'https://example.test/first.jpg' }))
    fireEvent.click(screen.getByRole('button', { name: 'ดูรูปสินค้า' }))
    view.rerender(createElement(ProductThumb, { imageUrl: 'https://example.test/second.jpg' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.error(view.container.querySelector('.product-photo')!)
    expect(screen.queryByRole('button', { name: 'ดูรูปสินค้า' })).toBeNull()
    expect(view.container.querySelector('.sc-icon')).toBeTruthy()
    view.rerender(createElement(ProductThumb, { imageUrl: null }))
    expect(view.container.querySelector('.sc-icon')).toBeTruthy()
  })
})

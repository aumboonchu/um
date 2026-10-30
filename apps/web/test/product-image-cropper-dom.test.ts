// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProductImageCropper } from '../src/ProductImageCropper'
const transport = vi.hoisted(() => ({ crop: vi.fn() }))
vi.mock('../src/product-image-crop', async importActual => ({ ...await importActual<typeof import('../src/product-image-crop')>(), cropProductImage: transport.crop }))
const image = { data: '/9j/4AAC/9k=', sha256: 'cd'.repeat(32), width: 320, height: 480 }
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:crop-source'); URL.revokeObjectURL = vi.fn()
  transport.crop.mockReset().mockResolvedValue(image)
  vi.stubGlobal('PointerEvent', MouseEvent)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function sourceLoaded() {
  const source = screen.getByAltText('ภาพต้นฉบับสำหรับเลือกกรอบสินค้า') as HTMLImageElement
  Object.defineProperties(source, { naturalWidth: { value: 590, configurable: true }, naturalHeight: { value: 1280, configurable: true } })
  fireEvent.load(source)
}
describe('mobile crop controls', () => {
  it('waits for image readiness and explicit confirmation, then emits only a bounded crop', async () => {
    const source = new Blob(['source'], { type: 'image/jpeg' }), onConfirm = vi.fn()
    render(createElement(ProductImageCropper, { source, onConfirm, onCancel: vi.fn() }))
    const button = screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }) as HTMLButtonElement
    expect(button.disabled).toBe(true); expect(onConfirm).not.toHaveBeenCalled()
    sourceLoaded(); expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(image))
    expect(transport.crop.mock.calls[0][0]).toBe(source)
    expect(transport.crop.mock.calls[0][1]).toEqual({ x: .12, y: .16, width: .76, height: .36 })
  })
  it('uses validated suggested bounds but still requires confirmation and permits accessible adjustments', async () => {
    const onConfirm = vi.fn(), initialBounds = { x: .2, y: .15, width: .5, height: .4 }
    render(createElement(ProductImageCropper, { source: new Blob(['source'], { type: 'image/jpeg' }), initialBounds, onConfirm, onCancel: vi.fn() }))
    sourceLoaded()
    fireEvent.change(screen.getByRole('slider', { name: 'กรอบด้านซ้าย', hidden: true }), { target: { value: '30' } })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(transport.crop.mock.calls[0][1]).toEqual({ ...initialBounds, x: .3 })
  })
  it('moves and resizes the selection with pointer controls without leaving the source image', () => {
    const view = render(createElement(ProductImageCropper, { source: new Blob(['source'], { type: 'image/jpeg' }), onConfirm: vi.fn(), onCancel: vi.fn() }))
    sourceLoaded()
    const surface = view.container.querySelector('.crop-surface') as HTMLDivElement, selection = view.container.querySelector('.crop-selection') as HTMLDivElement
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 600))
    fireEvent.pointerDown(selection, { clientX: 50, clientY: 100, button: 0 })
    fireEvent.pointerMove(surface, { clientX: 350, clientY: 700 })
    expect(selection.style.left).toBe('24%'); expect(selection.style.top).toBe('64%')
    fireEvent.pointerUp(surface)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ปรับขนาดกรอบรูป' }), { clientX: 250, clientY: 500, button: 0 })
    fireEvent.pointerMove(surface, { clientX: 150, clientY: 300 })
    expect(parseFloat(selection.style.width)).toBeLessThan(76)
  })
  it('cancels without emitting a crop and releases the source preview on unmount', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn()
    const view = render(createElement(ProductImageCropper, { source: new Blob(['source'], { type: 'image/jpeg' }), onConfirm, onCancel }))
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกครอป' }))
    expect(onCancel).toHaveBeenCalledTimes(1); expect(onConfirm).not.toHaveBeenCalled()
    view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:crop-source')
  })
  it('does not emit a late crop after unmount and aborts the active encoder', async () => {
    let finish!: (value: typeof image) => void, signal: AbortSignal | undefined
    transport.crop.mockImplementation((_source: Blob, _bounds: unknown, next: AbortSignal) => { signal = next; return new Promise(resolve => { finish = resolve }) })
    const onConfirm = vi.fn(), view = render(createElement(ProductImageCropper, { source: new Blob(['source'], { type: 'image/jpeg' }), onConfirm, onCancel: vi.fn() }))
    sourceLoaded(); fireEvent.click(screen.getByRole('button', { name: 'ใช้รูปที่ครอป' })); view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { finish(image); await Promise.resolve() })
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

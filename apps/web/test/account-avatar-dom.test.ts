// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AccountAvatar, AccountPhotoContext, PageHeader } from '../src/ui'

afterEach(cleanup)
const photo = 'https://lh3.googleusercontent.com/a/test-avatar=s96-c'
function header(avatarUrl: string | null, onAccount = vi.fn()) {
  return createElement(AccountPhotoContext.Provider, { value: avatarUrl }, createElement(PageHeader, { title: 'ซื้อสินค้า', onAccount }))
}
describe('Google account avatar', () => {
  it('fills the same account button with a circular-size photo and keeps its accessible action', () => {
    const onAccount = vi.fn()
    render(header(photo, onAccount))
    const button = screen.getByRole('button', { name: 'บัญชี' })
    const image = button.querySelector('.account-photo')
    expect(image?.getAttribute('src')).toBe(photo)
    expect(image?.getAttribute('width')).toBe('48')
    expect(image?.getAttribute('height')).toBe('48')
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(image?.getAttribute('alt')).toBe('')
    fireEvent.click(button)
    expect(onAccount).toHaveBeenCalledOnce()
  })
  it('uses the existing icon for absent photos or broken image loads', () => {
    const view = render(header(null))
    const button = screen.getByRole('button', { name: 'บัญชี' })
    expect(button.querySelector('.account-photo')).toBeNull()
    expect(button.querySelector('.sc-icon')).not.toBeNull()
    view.rerender(header(photo))
    fireEvent.error(button.querySelector('.account-photo')!)
    expect(button.querySelector('.account-photo')).toBeNull()
    expect(button.querySelector('.sc-icon')).not.toBeNull()
  })
  it('retries a new photo URL and clears the previous account image on account change', () => {
    const view = render(header(photo))
    const button = screen.getByRole('button', { name: 'บัญชี' })
    fireEvent.error(button.querySelector('.account-photo')!)
    const next = 'https://lh3.googleusercontent.com/a/different-account'
    view.rerender(header(next))
    expect(button.querySelector('.account-photo')?.getAttribute('src')).toBe(next)
    view.rerender(header(null))
    expect(button.querySelector('.account-photo')).toBeNull()
  })
  it('uses the same photo at the account identity size', () => {
    render(createElement(AccountPhotoContext.Provider, { value: photo }, createElement('div', { role: 'region', 'aria-label': 'ข้อมูลบัญชี' }, createElement(AccountAvatar, { large: true }))))
    const region = screen.getByRole('region', { name: 'ข้อมูลบัญชี' })
    const image = region.querySelector('.account-photo')
    expect(image?.getAttribute('width')).toBe('56')
    expect(image?.getAttribute('height')).toBe('56')
    expect(within(region).queryByRole('button')).toBeNull()
  })
})

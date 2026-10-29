import { createContext, useContext, useEffect, useState, type ReactNode, type Ref } from 'react'

export const AccountPhotoContext = createContext<string | null>(null)

const files = import.meta.glob<string>('./assets/figma/*.svg', { eager: true, query: '?url', import: 'default' })
// Exact exported Figma assets. Intrinsic dimensions are intentionally preserved.
export const iconAssets = {
  scan: ['b6029.svg', 24, 24], scanMuted: ['c33dd.svg', 24, 24], scanWhite: ['2b4e0.svg', 24, 24], scanHero: ['1d43f.svg', 56, 56],
  report: ['39115.svg', 24, 24], reportActive: ['7b8b5.svg', 24, 24], boxMuted: ['36ba1.svg', 24, 24], boxActive: ['6ce5f.svg', 24, 24],
  box: ['dc493.svg', 24, 24], boxLarge: ['77f9c.svg', 36, 36], boxWarning: ['5fcfa.svg', 18, 18],
  user: ['edf1f.svg', 24, 24], userLarge: ['02e5e.svg', 28, 28], basket: ['e00bd.svg', 24, 24], basketSmall: ['1bdb4.svg', 18, 18],
  barcode: ['61ddd.svg', 24, 24], image: ['43681.svg', 24, 24], imageLarge: ['ebd22.svg', 32, 32],
  back: ['c0066.svg', 24, 24], backWhite: ['c38f4.svg', 24, 24], down: ['d9fd0.svg', 24, 24],
  plus: ['05e4c.svg', 24, 24], plusGreen: ['c75e6.svg', 24, 24], minus: ['81b6c.svg', 24, 24],
  cash: ['6ece6.svg', 24, 24], card: ['50c4d.svg', 24, 24], transfer: ['c6b4f.svg', 24, 24],
  check: ['88cae.svg', 44, 44], checkSmall: ['c1187.svg', 18, 18], offline: ['1684b.svg', 44, 44],
  offlineWhite: ['40bc9.svg', 24, 24], clock: ['f0332.svg', 18, 18], flash: ['7fd95.svg', 24, 24],
  share: ['22146.svg', 24, 24], export: ['88c8e.svg', 24, 24], search: ['11911.svg', 24, 24], searchWhite: ['7a9c2.svg', 24, 24],
  scanExample: ['01925.svg', 320, 180],
} as const
export type IconName = keyof typeof iconAssets
export function Icon({ name }: { name: IconName }) {
  const [file, width, height] = iconAssets[name]
  return <img className="sc-icon" src={files[`./assets/figma/${file}`]} width={width} height={height} alt="" aria-hidden="true" draggable={false} />
}
export function AccountAvatar({ large = false }: { large?: boolean }) {
  const avatarUrl = useContext(AccountPhotoContext)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  return avatarUrl && avatarUrl !== failedUrl
    ? <img className="account-photo" src={avatarUrl} alt="" width={large ? 56 : 48} height={large ? 56 : 48} referrerPolicy="no-referrer" onError={() => setFailedUrl(avatarUrl)} />
    : <Icon name={large ? 'userLarge' : 'user'} />
}
export function PageHeader({ title, id, headingRef, onBack, onAccount, trailing }: { title: string; id?: string; headingRef?: Ref<HTMLHeadingElement>; onBack?: () => void; onAccount?: () => void; trailing?: ReactNode }) {
  return <header className={`page-header${onBack ? ' page-header-back' : ''}`}>
    {onBack ? <button className="icon-button" type="button" aria-label="กลับ" onClick={onBack}><Icon name="back" /></button> : null}
    <h1 id={id} ref={headingRef} tabIndex={-1}>{title}</h1>
    {onAccount ? <button className="icon-button tonal" type="button" aria-label="บัญชี" onClick={onAccount}><AccountAvatar /></button> : null}
    {trailing}
  </header>
}
export function ProductThumb({ imageUrl, large = false }: { imageUrl?: string | null; large?: boolean }) {
  return <span className={`product-thumb${large ? ' product-thumb-large' : ''}`}>
    {imageUrl ? <img className="product-photo" src={imageUrl} alt="" loading="lazy" /> : <Icon name={large ? 'boxLarge' : 'box'} />}
  </span>
}
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      const height = viewport?.height ?? window.innerHeight
      const keyboard = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0))
      document.documentElement.style.setProperty('--sc-viewport-height', `${height}px`)
      document.documentElement.style.setProperty('--sc-keyboard-inset', `${keyboard > 100 ? keyboard : 0}px`)
      document.documentElement.dataset.keyboard = keyboard > 100 ? 'open' : 'closed'
    }
    update(); viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update); window.addEventListener('resize', update)
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [])
}

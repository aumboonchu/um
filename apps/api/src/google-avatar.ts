/** Optional display data, never an identity key or a server-side fetch destination. */
export function googleAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value.trim())
    const googleCdn = ['googleusercontent.com', 'ggpht.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    if (url.protocol !== 'https:' || !googleCdn || url.username || url.password || url.port) return null
    return url.href
  } catch { return null }
}

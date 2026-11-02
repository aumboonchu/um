// Widen generated literal configuration values for validation without hand-writing runtime bindings.
type FrontendEnv = { [Key in keyof Pick<Env, 'APP_URL' | 'APP_ORIGIN' | 'ADDITIONAL_APP_URLS'>]: string }

function appBase(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\\*]/.test(value)) return null
  try {
    const url = new URL(value)
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !localHttp || url.username || url.password || url.search || url.hash
      || !url.pathname.endsWith('/') || url.href !== value) return null
    return url
  } catch { return null }
}

/** Deployment-controlled, exact frontend URLs; no wildcard origins or path-prefix matches. */
export function appUrls(env: FrontendEnv): URL[] {
  const primary = appBase(env.APP_URL)
  if (!primary || primary.origin !== env.APP_ORIGIN) return []
  const result = [primary]
  const raw = env.ADDITIONAL_APP_URLS
  if (!raw || raw.length > 8192) return result
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return result }
  if (!Array.isArray(parsed) || parsed.length > 8) return result
  const additional = parsed.map(appBase)
  // A malformed list grants no additional access, while preserving the original configured frontend.
  if (additional.some(url => url === null)) return result
  for (const url of additional) if (url && !result.some(existing => existing.href === url.href)) result.push(url)
  return result
}

export function isAppOrigin(origin: string | null | undefined, env: FrontendEnv): boolean {
  return typeof origin === 'string' && appUrls(env).some(url => url.origin === origin)
}

export function safeAppReturnTo(returnTo: string | null, env: FrontendEnv): string {
  if (!returnTo || returnTo.length > 4096 || /[\u0000-\u0020\\]/.test(returnTo)) return env.APP_URL
  try {
    const candidate = new URL(returnTo)
    if (!candidate.username && !candidate.password
      && appUrls(env).some(app => candidate.origin === app.origin && candidate.pathname === app.pathname)) return candidate.toString()
  } catch { /* Invalid or unapproved URLs use the original app destination. */ }
  return env.APP_URL
}

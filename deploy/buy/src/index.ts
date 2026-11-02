/// <reference path="../worker-configuration.d.ts" />

/** Mount public SmartCart assets only at /buy/. The private Area origin remains untouched. */
export default {
  async fetch(request: Request, env: BuyHostEnv): Promise<Response> {
    const url = new URL(request.url)
    // The route's trailing wildcard also catches query strings and /buyer. Preserve those other paths.
    if (url.pathname !== '/buy' && !url.pathname.startsWith('/buy/')) {
      return url.hostname === 'aumboonchu.com' ? fetch(request) : new Response('Not found', { status: 404 })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } })
    }
    if (url.pathname === '/buy' || url.pathname === '/buy/index.html' || url.protocol !== 'https:') {
      url.protocol = 'https:'
      if (url.pathname === '/buy' || url.pathname === '/buy/index.html') url.pathname = '/buy/'
      return new Response(null, { status: 308, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } })
    }
    // Strip the mount prefix only for the in-process static binding, never for an external request.
    const assetUrl = new URL(url)
    assetUrl.pathname = url.pathname === '/buy/' ? '/index.html' : url.pathname.slice('/buy'.length)
    assetUrl.search = ''
    // Only documented public files are in the Vite artifact; unknown paths remain 404, not private-site HTML.
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request))
    const headers = new Headers(asset.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('X-Frame-Options', 'DENY')
    headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    headers.set('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()')
    headers.set('Cache-Control', url.pathname.startsWith('/buy/assets/') && asset.ok
      ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (url.pathname === '/buy/sw.js') headers.set('Service-Worker-Allowed', '/buy/')
    return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, statusText: asset.statusText, headers })
  },
} satisfies ExportedHandler<BuyHostEnv>

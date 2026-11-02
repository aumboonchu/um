import { afterEach, describe, expect, it, vi } from 'vitest'
import buy from '../../../deploy/buy/src/index'

function fixture(status = 200) {
  const fetchAsset = vi.fn(async (_request: RequestInfo | URL) => new Response('asset bytes', {
    status, headers: { 'Content-Type': 'application/javascript' },
  }))
  const env: BuyHostEnv = { ASSETS: { fetch: fetchAsset, connect: () => { throw new Error('Unused socket') } } }
  return { env, fetchAsset }
}
afterEach(() => vi.unstubAllGlobals())
describe('path-scoped SmartCart static host', () => {
  it.each(['/buy', '/buy/index.html'])('canonicalizes %s with query intact', async path => {
    const { env, fetchAsset } = fixture()
    const response = await buy.fetch(new Request(`https://aumboonchu.com${path}?auth=failed&x=1`), env)
    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe('https://aumboonchu.com/buy/?auth=failed&x=1')
    expect(fetchAsset).not.toHaveBeenCalled()
  })
  it('upgrades http without losing asset path/query', async () => {
    const { env } = fixture()
    const response = await buy.fetch(new Request('http://aumboonchu.com/buy/assets/a.js?q=1'), env)
    expect(response.headers.get('Location')).toBe('https://aumboonchu.com/buy/assets/a.js?q=1')
  })
  it('maps only the mount root to index.html and does not forward its query', async () => {
    const { env, fetchAsset } = fixture()
    const response = await buy.fetch(new Request('https://aumboonchu.com/buy/?auth=failed'), env)
    const request = fetchAsset.mock.calls[0][0]
    expect(request instanceof Request && request.url).toBe('https://aumboonchu.com/index.html')
    expect(await response.text()).toBe('asset bytes')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
  })
  it.each(['/buyer', '/buy-other/', '/', '/signin-with-chatgpt'])('passes %s unchanged to existing Area origin', async path => {
    const { env, fetchAsset } = fixture()
    const request = new Request(`https://aumboonchu.com${path}?keep=1`, { method: 'POST', body: 'untouched' })
    const origin = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe(request)
      return new Response('existing private site', { status: 401, headers: { 'X-Area': 'preserved' } })
    })
    vi.stubGlobal('fetch', origin)
    const response = await buy.fetch(request, env)
    expect(response.status).toBe(401); expect(response.headers.get('X-Area')).toBe('preserved')
    expect(await response.text()).toBe('existing private site')
    expect(fetchAsset).not.toHaveBeenCalled()
  })
  it('does not recursively fetch the workers.dev preview outside /buy/', async () => {
    const { env } = fixture(), origin = vi.fn()
    vi.stubGlobal('fetch', origin)
    expect((await buy.fetch(new Request('https://smartcart-buy.example.workers.dev/'), env)).status).toBe(404)
    expect(origin).not.toHaveBeenCalled()
  })
  it.each(['POST', 'PUT', 'DELETE'])('rejects %s to /buy/ without touching data or Area', async method => {
    const { env, fetchAsset } = fixture(), origin = vi.fn()
    vi.stubGlobal('fetch', origin)
    const response = await buy.fetch(new Request('https://aumboonchu.com/buy/', { method }), env)
    expect(response.status).toBe(405); expect(response.headers.get('Allow')).toBe('GET, HEAD')
    expect(fetchAsset).not.toHaveBeenCalled(); expect(origin).not.toHaveBeenCalled()
  })
  it('serves hashed assets with MIME preserved and camera allowed only for self', async () => {
    const { env, fetchAsset } = fixture()
    const response = await buy.fetch(new Request('https://aumboonchu.com/buy/assets/index-abc.js'), env)
    const request = fetchAsset.mock.calls[0][0]
    expect(request instanceof Request && request.url).toBe('https://aumboonchu.com/assets/index-abc.js')
    expect(response.headers.get('Content-Type')).toBe('application/javascript')
    expect(response.headers.get('Cache-Control')).toContain('immutable')
    expect(response.headers.get('Permissions-Policy')).toContain('camera=(self)')
    expect(response.headers.has('Set-Cookie')).toBe(false)
  })
  it('restricts service worker scope and prevents stale worker caching', async () => {
    const { env } = fixture()
    const response = await buy.fetch(new Request('https://aumboonchu.com/buy/sw.js'), env)
    expect(response.headers.get('Service-Worker-Allowed')).toBe('/buy/')
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
  })
  it('preserves missing asset status instead of serving a login page or SPA fallback', async () => {
    const { env } = fixture(404)
    const response = await buy.fetch(new Request('https://aumboonchu.com/buy/missing.js'), env)
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).not.toContain('immutable')
  })
  it('supports HEAD without a response body', async () => {
    const { env } = fixture()
    const response = await buy.fetch(new Request('https://aumboonchu.com/buy/', { method: 'HEAD' }), env)
    expect(response.status).toBe(200); expect(await response.text()).toBe('')
  })
})

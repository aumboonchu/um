import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function worker() {
  const handlers: Record<string, (event: any) => void> = {}
  const cache = { addAll: vi.fn(async () => {}), put: vi.fn(async () => {}), match: vi.fn(async (_key: unknown): Promise<Response | undefined> => undefined) }
  const caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => ['smartcart-shell-v3', 'smartcart-shell-v4', 'unrelated-user-cache']), delete: vi.fn(async () => true) }
  const clients = { claim: vi.fn(async () => {}) }, fetch = vi.fn(async (_request: unknown): Promise<Response> => new Response('ok'))
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { URL, caches, fetch, self: { location: { origin: 'https://smartcart.test' }, clients, skipWaiting: vi.fn(), addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler } } })
  return { handlers, cache, caches, clients, fetch }
}
describe('mobile app shell upgrade safety', () => {
  it('cleans only outdated SmartCart shell caches, without accessing IndexedDB or unrelated caches', async () => {
    const w = worker(); let pending!: Promise<unknown>
    w.handlers.activate({ waitUntil: (value: Promise<unknown>) => { pending = value } }); await pending
    expect(w.caches.delete.mock.calls).toEqual([['smartcart-shell-v3']]); expect(w.clients.claim).toHaveBeenCalledOnce()
  })
  it('does not intercept or cache cross-origin account/API requests', () => {
    const w = worker(), respondWith = vi.fn()
    w.handlers.fetch({ request: { method: 'GET', url: 'https://api.smartcart.test/auth/me' }, respondWith })
    expect(respondWith).not.toHaveBeenCalled(); expect(w.caches.open).not.toHaveBeenCalled()
  })
  it('uses only the current-version cached shell during an offline navigation', async () => {
    const w = worker(); w.fetch.mockRejectedValue(new TypeError('offline'))
    w.cache.match.mockImplementation(async key => key === './' ? new Response('current mobile shell') : undefined)
    let pending!: Promise<Response>
    w.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://smartcart.test/um/' }, respondWith: (value: Promise<Response>) => { pending = value } })
    expect(await (await pending).text()).toBe('current mobile shell'); expect(w.caches.open).toHaveBeenCalledWith('smartcart-shell-v4')
  })
  it('does not replace a working offline shell with an unsuccessful HTML response', async () => {
    const w = worker(); w.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }))
    let pending!: Promise<Response>
    w.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://smartcart.test/um/' }, respondWith: (value: Promise<Response>) => { pending = value } })
    expect((await pending).status).toBe(503); expect(w.cache.put).not.toHaveBeenCalled()
  })
})

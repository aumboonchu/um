const CACHE_NAME = 'smartcart-shell-v3'
const APP_SHELL = ['./']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Only disposable app-shell caches; never clear IndexedDB, auth or outboxes.
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('smartcart-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== self.location.origin) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    if (event.request.mode === 'navigate') {
      try {
        const response = await fetch(event.request)
        if (response.ok) await cache.put(event.request, response.clone())
        return response
      } catch {
        return (await cache.match(event.request)) ?? (await cache.match('./'))
      }
    }

    const cached = await cache.match(event.request)
    if (cached) return cached
    const response = await fetch(event.request)
    if (response.ok) {
      await cache.put(event.request, response.clone())
    }
    return response
  })())
})

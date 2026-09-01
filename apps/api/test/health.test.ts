import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('health endpoint', () => {
  it('returns the current environment', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('permissions-policy')).toBe('camera=(), geolocation=(), microphone=()')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-site')
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'ok', environment: 'local' },
    })
  })

  it('reports an anonymous visitor without requiring a session cookie', async () => {
    const response = await SELF.fetch('https://example.com/auth/me')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: { authenticated: false, account: null },
    })
  })

  it('requires an account before recording a purchase', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(401)
  })

  it('requires an account before allowing manual product creation', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upc: '8851959129012', name: 'สินค้าใหม่' }),
    })

    expect(response.status).toBe(401)
  })

  it('requires an account before syncing offline operations', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: crypto.randomUUID(), operations: [] }),
    })

    expect(response.status).toBe(401)
  })
})


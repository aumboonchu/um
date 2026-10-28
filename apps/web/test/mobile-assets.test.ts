import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { iconAssets } from '../src/ui'

describe('approved mobile design assets', () => {
  it.each(Object.entries(iconAssets))('keeps %s local, non-empty and at its exported intrinsic dimensions', (_name, [file, width, height]) => {
    const path = new URL(`../src/assets/figma/${file}`, import.meta.url)
    expect(statSync(path).size).toBeGreaterThan(0)
    const descriptor = openSync(path, 'r'), header = Buffer.alloc(512)
    try {
      const bytes = readSync(descriptor, header, 0, header.length, 0)
      const root = header.toString('utf8', 0, bytes).match(/<svg\b[^>]*>/)?.[0]
      expect(root).toBeTruthy()
      expect(Number(root?.match(/\bwidth="([\d.]+)"/)?.[1])).toBe(width)
      expect(Number(root?.match(/\bheight="([\d.]+)"/)?.[1])).toBe(height)
    } finally { closeSync(descriptor) }
  })
})

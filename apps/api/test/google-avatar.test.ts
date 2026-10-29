import { describe, expect, it } from 'vitest'
import { googleAvatarUrl } from '../src/google-avatar'

describe('optional Google avatar URLs', () => {
  it.each(['https://lh3.googleusercontent.com/a/test=s96-c', 'https://lh5.googleusercontent.com/a-/test',
    'https://yt3.ggpht.com/test', '  https://lh3.googleusercontent.com/a/test  '])('accepts Google HTTPS image URLs: %s', value => {
    expect(googleAvatarUrl(value)).toBe(value.trim())
  })
  it.each([null, undefined, 123, '', 'not a URL', 'http://lh3.googleusercontent.com/a/test',
    'https://googleusercontent.com.evil.example/a/test', 'https://evil.example/googleusercontent.com/a/test',
    'https://evilgoogleusercontent.com/a/test', 'https://user:secret@lh3.googleusercontent.com/a/test',
    'https://lh3.googleusercontent.com:8443/a/test', 'javascript:alert(1)', 'data:image/svg+xml,test',
    'https://lh3.googleusercontent.com/a/\ntest', `https://lh3.googleusercontent.com/${'a'.repeat(2048)}`])('ignores an absent or unsafe avatar without breaking login: %#', value => {
    expect(googleAvatarUrl(value)).toBeNull()
  })
})

import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminPasswordHash, adminSha, type AdminAccess } from '../src/admin'
import { confirmImageProduct } from '../src/image-product'
import { changeAdminProductImage, croppedImageUrl, MAX_PRODUCT_IMAGE_BYTES, parseProductImage, readProductImageAsset, type ProductImagePayload } from '../src/product-images'

// Synthetic JPEG marker fixture tests the bounded framing validator (not a photo or user screenshot).
function jpeg(width = 32, height = 32, content = 0x71): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0xff, 0xd8,
    0xff, 0xdb, 0, 4, 0, 1, 0xff, 0xc4, 0, 4, 0, 1,
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    0xff, 0xda, 0, 12, 3, 1, 0, 2, 0, 3, 0, 0, 63, 0, content, 0xff, 0xd9])
}
const sha = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('')
async function image(bytes = jpeg(), width = 32, height = 32): Promise<ProductImagePayload> {
  return { data: btoa(String.fromCharCode(...bytes)), sha256: await sha(bytes), width, height }
}
const owner = 'crop-owner', member = 'crop-member', googleToken = 'c'.repeat(43), adminToken = 'd'.repeat(43)
let access: AdminAccess, sample: ProductImagePayload
const headers = { Authorization: `Bearer ${googleToken}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }
const request = (body: unknown) => new Request('https://example.test/api/v1/products/import-image', { method: 'POST', headers, body: JSON.stringify(body) })
const importBody = (extra: Record<string, unknown> = {}) => ({ operationId: crypto.randomUUID(), confirmed: true,
  name: 'สินค้าเฉพาะภาพครอป', brand: null, packageSize: '1 ขวด', sourcePriceMinor: 600, upc: null, retailerCode: '13627', imageSha256: 'a'.repeat(64), ...extra })
const editBody = (extra: Record<string, unknown> = {}) => ({ accountId: owner, operationId: crypto.randomUUID(), expectedRevision: 0, productImage: sample, ...extra })
const change = (body: unknown = editBody(), product = 'crop-existing') => changeAdminProductImage(request(body), product, access, env)
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); sample = await image() })
beforeEach(async () => {
  for (const id of [owner, member]) await env.DB.prepare('INSERT INTO users(id) VALUES (?)').bind(id).run()
  await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
    .bind('crop-google-session', owner, await adminSha(googleToken), '2099-01-01T00:00:00.000Z').run()
  const salt = 'a1'.repeat(32)
  await env.DB.prepare(`INSERT INTO admin_accounts(user_id,password_hash,password_salt,password_iterations,must_change_password,created_at,updated_at)
    VALUES (?,?,?,100000,0,?,?)`).bind(owner, await adminPasswordHash('password-123', salt), salt, '2026-10-30', '2026-10-30').run()
  await env.DB.prepare('INSERT INTO admin_sessions(token_hash,user_id,auth_session_id,credential_revision,expires_at) VALUES (?,?,?,1,?)')
    .bind(await adminSha(adminToken), owner, 'crop-google-session', '2099-01-01T00:00:00.000Z').run()
  access = { userId: owner, authSessionId: 'crop-google-session', tokenHash: await adminSha(adminToken), credentialRevision: 1, mustChangePassword: false }
  await env.DB.prepare('INSERT INTO products(id,sku,upc,name) VALUES (?,?,?,?)').bind('crop-existing', 'IMG-EXISTING', '8851959129012', 'ชื่อเดิม').run()
})

describe('cropped JPEG bounded validation', () => {
  it('accepts declared dimensions only when they match the JPEG SOF and SHA256', async () => {
    const valid = await parseProductImage(sample)
    expect(valid.width).toBe(32); expect(valid.height).toBe(32); expect(valid.bytes).toEqual(jpeg())
    await expect(parseProductImage({ ...sample, width: 64 })).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID', reason: 'INVALID_DIMENSIONS' })
    await expect(parseProductImage({ ...sample, sha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID', reason: 'HASH_MISMATCH' })
  })
  it('rejects malformed objects, noncanonical base64, wrong types and extra keys', async () => {
    for (const value of [null, [], { ...sample, original: 'screenshot' }, { ...sample, data: `data:image/jpeg;base64,${sample.data}` },
      { ...sample, data: ' ' + sample.data }, { ...sample, data: '!!!!' }, { ...sample, height: '32' }]) {
      await expect(parseProductImage(value)).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID', status: 400 })
    }
  })
  it('rejects SVG, oversized pixel dimensions, too-small crops, truncated or trailing JPEG data', async () => {
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
    for (const payload of [await image(svg), await image(jpeg(641), 641), await image(jpeg(15), 15),
      await image(jpeg().slice(0, -2)), await image(Uint8Array.from([...jpeg(), 0]))]) {
      await expect(parseProductImage(payload)).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' })
    }
  })
  it('rejects common EXIF/XMP, Photoshop and comment metadata instead of retaining it', async () => {
    for (const marker of [0xe1, 0xed, 0xfe]) {
      const original = jpeg(), bytes = Uint8Array.from([...original.slice(0, 2), 0xff, marker, 0, 4, 0, 1, ...original.slice(2)])
      await expect(parseProductImage(await image(bytes))).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID', reason: 'JPEG_METADATA' })
    }
  })
  it('rejects excessive encoded/decoded image bytes before database writes', async () => {
    await expect(parseProductImage({ ...sample, data: 'A'.repeat(Math.ceil(MAX_PRODUCT_IMAGE_BYTES / 3) * 4 + 4) }))
      .rejects.toMatchObject({ code: 'PRODUCT_IMAGE_TOO_LARGE', status: 413 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(0)
  })
})

describe('cropped photo on confirmed image import', () => {
  it('atomically saves a crop with the SKU and exposes only that JPEG through the photo URL', async () => {
    const payload = importBody({ productImage: sample }), result = await confirmImageProduct(request(payload), env)
    const expected = croppedImageUrl(result.product.id, sample.sha256, env)
    expect(result.created).toBe(true); expect(result.product.imageUrl).toBe(expected)
    const asset = await readProductImageAsset(result.product.id, sample.sha256, env)
    expect(asset.status).toBe(200); expect(asset.headers.get('Content-Type')).toBe('image/jpeg')
    expect(asset.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin')
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(jpeg())
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM purchases').first('n')).toBe(0)
    const replay = await confirmImageProduct(request(payload), env)
    expect(replay.created).toBe(false); expect(replay.product.imageUrl).toBe(expected)
  })
  it('retains old no-photo payload shape and exact UUID receipts', async () => {
    const payload = importBody(), first = await confirmImageProduct(request(payload), env)
    expect(first.product.imageUrl).toBeNull()
    expect((await confirmImageProduct(request(payload), env)).product).toEqual(first.product)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(0)
  })
  it('rejects an invalid photo before creating any product, import receipt or snapshot', async () => {
    await expect(confirmImageProduct(request(importBody({ productImage: { ...sample, sha256: 'f'.repeat(64) } })), env))
      .rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first('n')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_image_imports').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_source_snapshots').first('n')).toBe(0)
  })
  it('fills a missing photo on an existing UPC but never replaces an existing catalog photo', async () => {
    const first = await confirmImageProduct(request(importBody({ upc: '8851959129012', productImage: sample })), env)
    expect(first.product.id).toBe('crop-existing'); expect(first.product.name).toBe('ชื่อเดิม')
    const other = await image(jpeg(32, 32, 0x72))
    const second = await confirmImageProduct(request(importBody({ upc: '8851959129012', productImage: other })), env)
    expect(second.product.imageUrl).toBe(first.product.imageUrl)
    expect(await env.DB.prepare('SELECT sha256 FROM product_images WHERE product_id = ?').bind('crop-existing').first('sha256')).toBe(sample.sha256)
  })
  it('does not overwrite an existing external photo during a normal image import', async () => {
    await env.DB.prepare('UPDATE products SET image_url = ? WHERE id = ?').bind('https://example.test/product.jpg', 'crop-existing').run()
    const result = await confirmImageProduct(request(importBody({ upc: '8851959129012', productImage: sample })), env)
    expect(result.product.imageUrl).toBe('https://example.test/product.jpg')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(0)
  })
  it('deduplicates simultaneous UUID retries with no orphan images', async () => {
    const payload = importBody({ productImage: sample })
    const results = await Promise.all([confirmImageProduct(request(payload), env), confirmImageProduct(request(payload), env)])
    expect(new Set(results.map(v => v.product.id)).size).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_image_imports').first('n')).toBe(1)
  })
  it('rejects changing a crop under an already committed import UUID', async () => {
    const payload = importBody({ productImage: sample }); await confirmImageProduct(request(payload), env)
    await expect(confirmImageProduct(request({ ...payload, productImage: await image(jpeg(32, 32, 0x72)) }), env))
      .rejects.toMatchObject({ code: 'IMAGE_IMPORT_CONFLICT', status: 409 })
  })
  it('rolls the product, fingerprint, receipt and snapshot back if storing the crop fails', async () => {
    await env.DB.exec("CREATE TRIGGER reject_crop BEFORE INSERT ON product_images BEGIN SELECT RAISE(ABORT, 'CROP_TEST_ONLY'); END;")
    await expect(confirmImageProduct(request(importBody({ productImage: sample })), env)).rejects.toThrow()
    for (const table of ['product_images', 'product_image_imports', 'product_image_fingerprints', 'product_source_snapshots']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(0)
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first('n')).toBe(1)
  })
})

describe('admin cropped catalog photos', () => {
  it('sets a photo with optimistic revision, audit and original acknowledgement on UUID replay', async () => {
    const payload = editBody(), first = await change(payload)
    expect(first).toEqual({ operationId: payload.operationId, productId: 'crop-existing', revision: 1, imageUrl: croppedImageUrl('crop-existing', sample.sha256, env) })
    expect(await change(payload)).toEqual(first)
    const next = await image(jpeg(32, 32, 0x72))
    await change(editBody({ expectedRevision: 1, productImage: next }))
    expect(await change(payload)).toEqual(first)
    expect((await readProductImageAsset('crop-existing', sample.sha256, env)).status).toBe(404)
    expect((await readProductImageAsset('crop-existing', next.sha256, env)).status).toBe(200)
    expect(await env.DB.prepare('SELECT catalog_revision FROM products WHERE id = ?').bind('crop-existing').first('catalog_revision')).toBe(2)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(2)
  })
  it('rejects stale revisions, changed UUID payloads and wrong account IDs without overwriting', async () => {
    const payload = editBody(); await change(payload)
    await expect(change(editBody())).rejects.toMatchObject({ code: 'PRODUCT_CONFLICT', status: 409 })
    await expect(change({ ...payload, productImage: await image(jpeg(32, 32, 0x72)) })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    await expect(change(editBody({ accountId: member }))).rejects.toMatchObject({ code: 'ADMIN_ACCOUNT_MISMATCH' })
    expect(await env.DB.prepare('SELECT sha256 FROM product_images').first('sha256')).toBe(sample.sha256)
  })
  it('serializes simultaneous new image edits and deduplicates simultaneous UUID retries', async () => {
    const payload = editBody()
    const retries = await Promise.all([change(payload), change(payload)])
    expect(retries[0]).toEqual(retries[1])
    const results = await Promise.allSettled([change(editBody({ expectedRevision: 1 })), change(editBody({ expectedRevision: 1, productImage: await image(jpeg(32, 32, 0x72)) }))])
    expect(results.filter(v => v.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(v => v.status === 'rejected')).toHaveLength(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(2)
  })
  it('rechecks live admin/Google authorization inside the write transaction', async () => {
    await env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), 'crop-google-session').run()
    await expect(change()).rejects.toMatchObject({ code: 'PRODUCT_CONFLICT' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(0)
  })
  it('does not change product identity, metadata, personal overrides or purchase financial rows', async () => {
    await env.DB.prepare(`INSERT INTO product_profiles(user_id,product_id,name,brand,package_size,unit,category,revision,last_operation_id,updated_at)
      VALUES (?,?,'ส่วนตัว',NULL,NULL,NULL,NULL,1,?,?)`).bind(member, 'crop-existing', crypto.randomUUID(), '2026-10-30').run()
    await env.DB.prepare(`INSERT INTO purchases(id,user_id,product_id,unit_price_minor,quantity,total_minor,purchased_at)
      VALUES ('crop-purchase',?,?,600,1,600,?)`).bind(member, 'crop-existing', '2026-10-30').run()
    const profile = await env.DB.prepare('SELECT * FROM product_profiles').first(), purchase = await env.DB.prepare('SELECT * FROM purchases').first()
    await change()
    expect(await env.DB.prepare('SELECT sku,upc,name FROM products WHERE id = ?').bind('crop-existing').first())
      .toEqual({ sku: 'IMG-EXISTING', upc: '8851959129012', name: 'ชื่อเดิม' })
    expect(await env.DB.prepare('SELECT * FROM product_profiles').first()).toEqual(profile)
    expect(await env.DB.prepare('SELECT * FROM purchases').first()).toEqual(purchase)
  })
  it('bounds bodies and rejects unknown keys and missing products', async () => {
    await expect(change(editBody({ imageUrl: 'https://example.test/photo.jpg' }))).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_INVALID' })
    await expect(change(editBody({ productImage: { ...sample, data: 'a'.repeat(200_000) } }))).rejects.toMatchObject({ code: 'PRODUCT_IMAGE_TOO_LARGE' })
    await expect(change(editBody(), 'missing-product')).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(0)
  })
  it('never serves an unknown product/hash or malformed asset path', async () => {
    await change()
    for (const [id, hash] of [['missing', sample.sha256], ['crop-existing', 'f'.repeat(64)], ['../private', sample.sha256], ['crop-existing', 'bad']])
      expect((await readProductImageAsset(id, hash, env)).status).toBe(404)
  })
  it('rolls the admin audit and revision back if storing the replacement crop fails', async () => {
    await env.DB.exec("CREATE TRIGGER reject_admin_crop BEFORE INSERT ON product_images BEGIN SELECT RAISE(ABORT, 'CROP_ADMIN_TEST_ONLY'); END;")
    await expect(change()).rejects.toThrow()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT catalog_revision,image_url FROM products WHERE id = ?').bind('crop-existing').first())
      .toEqual({ catalog_revision: 0, image_url: null })
  })
})

describe('photo HTTP integration', () => {
  it('serves only JPEG product crops for cross-origin IMG elements without a browser session', async () => {
    const result = await change(), response = await SELF.fetch(result.imageUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg())
    expect((await SELF.fetch(result.imageUrl.replace(/\.jpg$/, '.svg'))).status).toBe(404)
    const health = await SELF.fetch('https://example.test/api/v1/health')
    expect(health.headers.get('Cross-Origin-Resource-Policy')).toBe('same-site')
  })
  it('rejects anonymous, missing/forged Origin, bootstrap and foreign-account image changes before writes', async () => {
    const path = 'https://example.test/api/v1/admin/products/crop-existing/image'
    const h = { ...headers, 'X-SmartCart-Admin': adminToken }
    const call = (requestHeaders: HeadersInit) => SELF.fetch(path, { method: 'PATCH', headers: requestHeaders, body: JSON.stringify(editBody()) })
    expect((await call({ Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' })).status).toBe(401)
    for (const origin of [null, 'https://evil.example']) {
      const requestHeaders = new Headers(h); requestHeaders.delete('Origin'); if (origin) requestHeaders.set('Origin', origin)
      expect((await call(requestHeaders)).status).toBe(403)
    }
    await env.DB.prepare('UPDATE admin_accounts SET must_change_password = 1 WHERE user_id = ?').bind(owner).run()
    expect((await call(h)).status).toBe(403)
    await env.DB.prepare('UPDATE admin_accounts SET must_change_password = 0 WHERE user_id = ?').bind(owner).run()
    const foreignToken = 'e'.repeat(43)
    await env.DB.prepare('INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
      .bind('crop-member-session', member, await adminSha(foreignToken), '2099-01-01T00:00:00.000Z').run()
    expect((await call({ ...h, Authorization: `Bearer ${foreignToken}` })).status).toBe(403)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM product_images').first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_catalog_mutations').first('n')).toBe(0)
  })
  it('returns bounded validation errors for a signed-in admin without leaking submitted bytes', async () => {
    const response = await SELF.fetch('https://example.test/api/v1/admin/products/crop-existing/image', {
      method: 'PATCH', headers: { ...headers, 'X-SmartCart-Admin': adminToken },
      body: JSON.stringify(editBody({ productImage: { ...sample, sha256: 'f'.repeat(64) } })),
    })
    expect(response.status).toBe(400)
    const raw = await response.text(); expect(raw).toContain('PRODUCT_IMAGE_INVALID'); expect(raw).not.toContain(sample.data)
    expect(JSON.parse(raw)).toMatchObject({ error: { code: 'PRODUCT_IMAGE_INVALID', reason: 'HASH_MISMATCH' } })
    expect(raw).not.toContain(sample.sha256)
    expect(raw).not.toContain('ครอปใหม่')
  })
})

import type { AuthEnv } from './auth'
import { ADMIN_LIVE, AdminError, adminSha, type AdminAccess } from './admin'

export const MAX_PRODUCT_IMAGE_BYTES = 128 * 1024
export const MAX_PRODUCT_IMAGE_BODY = 192 * 1024
export type ProductImagePayload = { data: string; sha256: string; width: number; height: number }
export type ProductImage = ProductImagePayload & { bytes: Uint8Array<ArrayBuffer> }
export type ProductImageFailureReason = 'INVALID_PAYLOAD' | 'INVALID_BASE64' | 'INVALID_JPEG' | 'UNSUPPORTED_JPEG'
  | 'INVALID_DIMENSIONS' | 'HASH_MISMATCH' | 'IMAGE_TOO_LARGE' | 'REQUEST_TOO_LARGE' | 'JPEG_METADATA'
export class ProductImageError extends Error {
  constructor(readonly code: 'PRODUCT_IMAGE_INVALID' | 'PRODUCT_IMAGE_TOO_LARGE', readonly status: 400 | 413,
    readonly reason: ProductImageFailureReason = code === 'PRODUCT_IMAGE_TOO_LARGE' ? 'IMAGE_TOO_LARGE' : 'INVALID_PAYLOAD') { super(code) }
}
const invalid = (reason: ProductImageFailureReason = 'INVALID_PAYLOAD'): never => { throw new ProductImageError('PRODUCT_IMAGE_INVALID', 400, reason) }
const tooLarge = (reason: 'IMAGE_TOO_LARGE' | 'REQUEST_TOO_LARGE' = 'IMAGE_TOO_LARGE'): never => { throw new ProductImageError('PRODUCT_IMAGE_TOO_LARGE', 413, reason) }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validate bounded JPEG framing/dimensions, not AI semantics. User confirms the product-only crop. */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 30 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return invalid('INVALID_JPEG')
  let position = 2, width = 0, height = 0, components = 0, quantization = false, huffman = false, scans = 0, entropy = 0
  while (position < bytes.length) {
    if (bytes[position++] !== 0xff) return invalid('INVALID_JPEG')
    while (bytes[position] === 0xff) position += 1
    const marker = bytes[position++]
    if (marker === 0xd9) {
      if (position !== bytes.length || !width || !height || !quantization || !huffman || !scans || !entropy) return invalid('INVALID_JPEG')
      return { width, height }
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 1 || marker >= 0xd0 && marker <= 0xd7 || position + 2 > bytes.length) return invalid('INVALID_JPEG')
    const length = bytes[position] * 256 + bytes[position + 1]
    if (length < 2 || position + length > bytes.length) return invalid('INVALID_JPEG')
    // New canvas crops strip these before hashing. Reject unsanitized/legacy payloads here.
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) return invalid('JPEG_METADATA')
    if (marker === 0xdb) quantization = true
    if (marker === 0xc4) huffman = true
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (width || length < 8) return invalid('INVALID_JPEG')
      if (![0xc0, 0xc2].includes(marker) || bytes[position + 2] !== 8) return invalid('UNSUPPORTED_JPEG')
      height = bytes[position + 3] * 256 + bytes[position + 4]
      width = bytes[position + 5] * 256 + bytes[position + 6]
      components = bytes[position + 7]
      if (![1, 3].includes(components)) return invalid('UNSUPPORTED_JPEG')
      if (length !== 8 + components * 3) return invalid('INVALID_JPEG')
      if (width < 16 || height < 16 || width > 640 || height > 640) return invalid('INVALID_DIMENSIONS')
    }
    if (marker !== 0xda) { position += length; continue }
    const scanComponents = bytes[position + 2]
    if (!width || !quantization || !huffman || scanComponents < 1 || scanComponents > components || length !== 6 + scanComponents * 2) return invalid('INVALID_JPEG')
    scans += 1
    position += length
    while (position < bytes.length) {
      if (bytes[position] !== 0xff) { entropy += 1; position += 1; continue }
      const markerStart = position
      while (bytes[position] === 0xff) position += 1
      const escaped = bytes[position]
      if (escaped === 0 || escaped >= 0xd0 && escaped <= 0xd7) { position += 1; entropy += 1; continue }
      position = markerStart
      break
    }
  }
  return invalid('INVALID_JPEG')
}

export async function parseProductImage(value: unknown): Promise<ProductImage> {
  if (!record(value) || Object.keys(value).length !== 4 || !['data', 'sha256', 'width', 'height'].every(k => k in value)
    || typeof value.data !== 'string' || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)
    || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return invalid()
  if (value.data.length > Math.ceil(MAX_PRODUCT_IMAGE_BYTES / 3) * 4) return tooLarge()
  if (!value.data.length || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return invalid('INVALID_BASE64')
  let binary: string
  try { binary = atob(value.data) } catch { return invalid('INVALID_BASE64') }
  if (btoa(binary) !== value.data) return invalid('INVALID_BASE64')
  if (binary.length > MAX_PRODUCT_IMAGE_BYTES) return tooLarge()
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), dimensions = jpegDimensions(bytes)
  if (dimensions.width !== value.width || dimensions.height !== value.height) return invalid('INVALID_DIMENSIONS')
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  if (sha256 !== value.sha256.toLowerCase()) return invalid('HASH_MISMATCH')
  return { data: value.data, sha256, ...dimensions, bytes }
}

export function croppedImageUrl(id: string, sha256: string, env: Pick<AuthEnv, 'API_ORIGIN'>): string {
  return `${env.API_ORIGIN.replace(/\/$/, '')}/api/v1/product-images/${encodeURIComponent(id)}/${sha256}.jpg`
}

export async function readProductImageAsset(id: string, sha256: string, env: AuthEnv): Promise<Response> {
  const notFound = () => Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^[0-9a-f]{64}$/.test(sha256)) return notFound()
  const row = await env.DB.prepare('SELECT jpeg FROM product_images WHERE product_id = ? AND sha256 = ?')
    .bind(id, sha256).first<{ jpeg: ArrayBuffer | number[] }>()
  if (!row) return notFound()
  const bytes = Array.isArray(row.jpeg) ? Uint8Array.from(row.jpeg) : new Uint8Array(row.jpeg)
  if (bytes.byteLength > MAX_PRODUCT_IMAGE_BYTES) return notFound()
  return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' } })
}

export async function readProductImageBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '') || !request.body) return invalid()
  if (Number(request.headers.get('Content-Length')) > MAX_PRODUCT_IMAGE_BODY) return tooLarge('REQUEST_TOO_LARGE')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength; if (size > MAX_PRODUCT_IMAGE_BODY) { await reader.cancel(); return tooLarge('REQUEST_TOO_LARGE') }
    chunks.push(value)
  } } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return invalid() }
}

type ImageReceipt = { product_id: string; payload_hash: string; result_revision: number; after_json: string }
const receipt = (userId: string, operationId: string, env: AuthEnv) => env.DB.prepare(`SELECT product_id,payload_hash,result_revision,after_json
  FROM admin_catalog_mutations WHERE user_id = ? AND operation_id = ?`).bind(userId, operationId).first<ImageReceipt>()
function replay(row: ImageReceipt, hash: string, operationId: string) {
  if (row.payload_hash !== hash) throw new AdminError('OPERATION_CONFLICT', 409)
  const after: unknown = JSON.parse(row.after_json)
  if (!record(after) || typeof after.imageUrl !== 'string') throw new Error('Invalid image receipt')
  return { operationId, productId: row.product_id, revision: row.result_revision, imageUrl: after.imageUrl }
}

export async function changeAdminProductImage(request: Request, id: string, access: AdminAccess, env: AuthEnv) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return invalid()
  const body = await readProductImageBody(request)
  if (!record(body) || Object.keys(body).length !== 4 || Object.keys(body).some(k => !['accountId', 'operationId', 'expectedRevision', 'productImage'].includes(k))
    || typeof body.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)
    || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision >= 1_000_000_000) return invalid()
  if (body.accountId !== access.userId) throw new AdminError('ADMIN_ACCOUNT_MISMATCH', 403)
  const image = await parseProductImage(body.productImage), operationId = body.operationId.toLowerCase(), revision = body.expectedRevision
  const hash = await adminSha(JSON.stringify({ action: 'product-image', id, revision, sha256: image.sha256, width: image.width, height: image.height }))
  const saved = await receipt(access.userId, operationId, env); if (saved) return replay(saved, hash, operationId)
  const now = new Date().toISOString(), imageUrl = croppedImageUrl(id, image.sha256, env)
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO admin_catalog_mutations (user_id,operation_id,product_id,payload_hash,result_revision,before_json,after_json,created_at)
        SELECT ?, ?, p.id, ?, p.catalog_revision + 1, json_object('imageUrl',p.image_url), ?, ? FROM products p
        WHERE p.id = ? AND p.catalog_revision = ? AND ${ADMIN_LIVE}`)
        .bind(access.userId, operationId, hash, JSON.stringify({ imageUrl, sha256: image.sha256, width: image.width, height: image.height }), now,
          id, revision, access.tokenHash, now, now),
      env.DB.prepare(`INSERT INTO product_images (product_id,jpeg,sha256,width,height,created_at,updated_at)
        SELECT p.id, ?, ?, ?, ?, ?, ? FROM products p WHERE p.id = ? AND p.catalog_revision = ? AND ${ADMIN_LIVE}
          AND EXISTS (SELECT 1 FROM admin_catalog_mutations WHERE user_id = ? AND operation_id = ? AND product_id = p.id AND payload_hash = ?)
        ON CONFLICT(product_id) DO UPDATE SET jpeg = excluded.jpeg, sha256 = excluded.sha256, width = excluded.width,
          height = excluded.height, updated_at = excluded.updated_at`)
        .bind(image.bytes.buffer, image.sha256, image.width, image.height, now, now, id, revision, access.tokenHash, now, now, access.userId, operationId, hash),
      env.DB.prepare(`UPDATE products SET image_url = ?, catalog_revision = catalog_revision + 1, catalog_operation_id = ?, updated_at = ?
        WHERE id = ? AND catalog_revision = ? AND ${ADMIN_LIVE}
          AND EXISTS (SELECT 1 FROM admin_catalog_mutations WHERE user_id = ? AND operation_id = ? AND product_id = products.id AND payload_hash = ?)`)
        .bind(imageUrl, operationId, now, id, revision, access.tokenHash, now, now, access.userId, operationId, hash),
    ])
    if (results.some(result => !result.meta.changes)) {
      const concurrent = await receipt(access.userId, operationId, env); if (concurrent) return replay(concurrent, hash, operationId)
      if (!await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first()) throw new AdminError('PRODUCT_NOT_FOUND', 404)
      throw new AdminError('PRODUCT_CONFLICT', 409)
    }
  } catch (error) {
    const concurrent = await receipt(access.userId, operationId, env); if (concurrent) return replay(concurrent, hash, operationId)
    throw error
  }
  return { operationId, productId: id, revision: revision + 1, imageUrl }
}

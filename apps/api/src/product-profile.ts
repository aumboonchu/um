import type { AuthEnv } from './auth'

type Fields = { name: string; brand: string | null; packageSize: string | null; unit: string | null; category: string | null }
type Profile = Fields & { profileRevision: number }
type Receipt = { product_id: string; payload_hash: string; result_revision: number }
export class ProductProfileError extends Error {
  constructor(readonly code: 'INVALID_PRODUCT_CHANGE' | 'PRODUCT_NOT_FOUND' | 'PRODUCT_CONFLICT' | 'OPERATION_CONFLICT' | 'PRODUCT_ACCOUNT_MISMATCH', readonly status: 400 | 403 | 404 | 409) { super(code) }
}
const invalid = (): never => { throw new ProductProfileError('INVALID_PRODUCT_CHANGE', 400) }
function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid()
  return value.trim() || null
}
export async function withProductProfile<T extends Fields & { id: string }>(product: T, userId: string, env: AuthEnv): Promise<T & { profileRevision: number }> {
  const profile = await env.DB.prepare(`SELECT name, brand, package_size AS packageSize, unit, category, revision AS profileRevision
    FROM product_profiles WHERE user_id = ? AND product_id = ?`).bind(userId, product.id).first<Profile>()
  return { ...product, ...(profile ?? { profileRevision: 0 }) }
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body
    || Number(request.headers.get('content-length')) > 10_240) return invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength; if (size > 10_240) { await reader.cancel(); return invalid() }
    chunks.push(value)
  } } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { return invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
async function receipt(userId: string, operationId: string, env: AuthEnv) {
  return env.DB.prepare('SELECT product_id, payload_hash, result_revision FROM product_profile_mutations WHERE user_id = ? AND operation_id = ?')
    .bind(userId, operationId).first<Receipt>()
}
function replay(row: Receipt, operationId: string, hash: string) {
  if (row.payload_hash !== hash) throw new ProductProfileError('OPERATION_CONFLICT', 409)
  return { operationId, productId: row.product_id, profileRevision: row.result_revision }
}
export async function changeProductProfile(request: Request, id: string, userId: string, env: AuthEnv) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return invalid()
  const body = await readBody(request)
  if (Object.keys(body).some(key => !['accountId', 'operationId', 'expectedRevision', 'name', 'brand', 'packageSize', 'unit', 'category'].includes(key))
    || typeof body.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)
    || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision >= 1_000_000_000) return invalid()
  const fields: Fields = { name: text(body.name, 200) ?? '', brand: text(body.brand, 100), packageSize: text(body.packageSize, 100), unit: text(body.unit, 40), category: text(body.category, 100) }
  if (!fields.name) return invalid()
  if (body.accountId !== userId) throw new ProductProfileError('PRODUCT_ACCOUNT_MISMATCH', 403)
  const revision = body.expectedRevision, operationId = body.operationId.toLowerCase()
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ id, revision, fields }))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
  const existing = await receipt(userId, operationId, env)
  if (existing) return replay(existing, operationId, hash)
  const allowed = await env.DB.prepare(`SELECT id FROM products WHERE id = ? AND
    (EXISTS (SELECT 1 FROM purchases WHERE product_id = products.id AND user_id = ?)
     OR EXISTS (SELECT 1 FROM product_image_imports WHERE product_id = products.id AND user_id = ?))`)
    .bind(id, userId, userId).first()
  if (!allowed) throw new ProductProfileError('PRODUCT_NOT_FOUND', 404)
  const now = new Date().toISOString()
  const statements = [
    env.DB.prepare(`UPDATE product_profiles SET name = ?, brand = ?, package_size = ?, unit = ?, category = ?,
      revision = revision + 1, last_operation_id = ?, updated_at = ? WHERE user_id = ? AND product_id = ? AND revision = ?`)
      .bind(fields.name, fields.brand, fields.packageSize, fields.unit, fields.category, operationId, now, userId, id, revision),
    env.DB.prepare(`INSERT INTO product_profiles (user_id, product_id, name, brand, package_size, unit, category, revision, last_operation_id, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ? = 0 ON CONFLICT(user_id, product_id) DO NOTHING`)
      .bind(userId, id, fields.name, fields.brand, fields.packageSize, fields.unit, fields.category, operationId, now, revision),
    env.DB.prepare(`INSERT INTO product_profile_mutations (user_id, operation_id, product_id, payload_hash, result_revision, created_at)
      SELECT user_id, ?, product_id, ?, revision, ? FROM product_profiles
      WHERE user_id = ? AND product_id = ? AND last_operation_id = ? AND revision = ?`)
      .bind(operationId, hash, now, userId, id, operationId, revision + 1),
  ]
  try {
    const results = await env.DB.batch(statements)
    if (!results[0].meta.changes && !results[1].meta.changes) {
      const saved = await receipt(userId, operationId, env)
      if (saved) return replay(saved, operationId, hash)
      throw new ProductProfileError('PRODUCT_CONFLICT', 409)
    }
  } catch (error) {
    const saved = await receipt(userId, operationId, env)
    if (saved) return replay(saved, operationId, hash)
    throw error
  }
  return { operationId, productId: id, profileRevision: revision + 1 }
}

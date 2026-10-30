import type { AuthEnv } from './auth'
import { ADMIN_LIVE, AdminError, adminBody, adminSha, type AdminAccess } from './admin'

type Fields = { name: string; brand: string | null; packageSize: string | null; unit: string | null; category: string | null }
type Product = Fields & { id: string; sku: string; upc: string | null; imageUrl: string | null; revision: number;
  source: string; sourceProductId: string | null; sourceUrl: string | null; createdAt: string; updatedAt: string }
type Receipt = { product_id: string; payload_hash: string; result_revision: number }
const invalid = (): never => { throw new AdminError('INVALID_ADMIN_INPUT', 400) }
const PRODUCT_SELECT = `SELECT p.id, p.sku, p.upc, p.name, p.brand, p.package_size AS packageSize, p.unit, p.category,
  p.image_url AS imageUrl, p.catalog_revision AS revision, p.created_at AS createdAt, p.updated_at AS updatedAt,
  COALESCE(s.source, 'smartcart') AS source, s.source_product_id AS sourceProductId, s.source_url AS sourceUrl
  FROM products p LEFT JOIN product_source_snapshots s ON s.id =
    (SELECT id FROM product_source_snapshots WHERE product_id = p.id ORDER BY fetched_at DESC, id DESC LIMIT 1)`
function productId(id: string): string { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return invalid(); return id }
export async function adminProduct(id: string, env: AuthEnv): Promise<Product> {
  const product = await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).bind(productId(id)).first<Product>()
  if (!product) throw new AdminError('PRODUCT_NOT_FOUND', 404)
  return product
}
export async function listAdminProducts(url: URL, env: AuthEnv) {
  if ([...url.searchParams.keys()].some(k => !['q', 'cursor'].includes(k)) || url.searchParams.getAll('q').length > 1 || url.searchParams.getAll('cursor').length > 1) return invalid()
  const q = (url.searchParams.get('q') ?? '').trim()
  if (q.length > 80 || /[\u0000-\u001f\u007f]/.test(q)) return invalid()
  let after = ''
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null) {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9+/=]+$/.test(cursor)) return invalid()
    try {
      const value: unknown = JSON.parse(decodeURIComponent(atob(cursor)))
      if (!value || typeof value !== 'object' || !('q' in value) || !('id' in value) || value.q !== q || typeof value.id !== 'string'
        || Object.keys(value).length !== 2) return invalid()
      after = productId(value.id)
    } catch { return invalid() }
  }
  const search = `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
  const filter = `(p.name LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.upc LIKE ? ESCAPE '\\')`
  const rows = await env.DB.prepare(`${PRODUCT_SELECT} WHERE ${filter} AND p.id > ? ORDER BY p.id LIMIT 31`)
    .bind(search, search, search, search, after).all<Product>()
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${filter}`).bind(search, search, search, search).first<number>('n')
  const items = rows.results.slice(0, 30)
  return { items, total: total ?? 0, nextCursor: rows.results.length > 30 ? btoa(encodeURIComponent(JSON.stringify({ q, id: items.at(-1)!.id }))) : null }
}
function field(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return invalid()
  return value.trim() || null
}
const receipt = (userId: string, operationId: string, env: AuthEnv) => env.DB.prepare(`SELECT product_id, payload_hash, result_revision
  FROM admin_catalog_mutations WHERE user_id = ? AND operation_id = ?`).bind(userId, operationId).first<Receipt>()
function replay(saved: Receipt, operationId: string, hash: string) {
  if (saved.payload_hash !== hash) throw new AdminError('OPERATION_CONFLICT', 409)
  return { operationId, productId: saved.product_id, revision: saved.result_revision }
}
export async function changeAdminProduct(request: Request, rawId: string, access: AdminAccess, env: AuthEnv) {
  const id = productId(rawId), body = await adminBody(request)
  if (Object.keys(body).some(k => !['accountId', 'operationId', 'expectedRevision', 'name', 'brand', 'packageSize', 'unit', 'category'].includes(k))
    || typeof body.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)
    || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision >= 1_000_000_000) return invalid()
  if (body.accountId !== access.userId) throw new AdminError('ADMIN_ACCOUNT_MISMATCH', 403)
  const fields: Fields = { name: field(body.name, 200) ?? '', brand: field(body.brand, 100), packageSize: field(body.packageSize, 100), unit: field(body.unit, 40), category: field(body.category, 100) }
  if (!fields.name) return invalid()
  const operationId = body.operationId.toLowerCase(), revision = body.expectedRevision
  const hash = await adminSha(JSON.stringify({ id, revision, fields }))
  const existing = await receipt(access.userId, operationId, env)
  if (existing) return replay(existing, operationId, hash)
  const now = new Date().toISOString()
  try {
    const results = await env.DB.batch([
      // The audit receipt and catalog edit commit together, guarded by the original live elevation.
      env.DB.prepare(`INSERT INTO admin_catalog_mutations
        (user_id,operation_id,product_id,payload_hash,result_revision,before_json,after_json,created_at)
        SELECT ?, ?, p.id, ?, p.catalog_revision + 1,
          json_object('name',p.name,'brand',p.brand,'packageSize',p.package_size,'unit',p.unit,'category',p.category), ?, ?
        FROM products p WHERE p.id = ? AND p.catalog_revision = ? AND ${ADMIN_LIVE}`)
        .bind(access.userId, operationId, hash, JSON.stringify(fields), now, id, revision, access.tokenHash, now, now),
      env.DB.prepare(`UPDATE products SET name = ?, brand = ?, package_size = ?, unit = ?, category = ?,
        catalog_revision = catalog_revision + 1, catalog_operation_id = ?, updated_at = ?
        WHERE id = ? AND catalog_revision = ? AND ${ADMIN_LIVE} AND EXISTS
          (SELECT 1 FROM admin_catalog_mutations WHERE user_id = ? AND operation_id = ? AND product_id = products.id AND payload_hash = ?)`)
        .bind(fields.name, fields.brand, fields.packageSize, fields.unit, fields.category, operationId, now, id, revision,
          access.tokenHash, now, now, access.userId, operationId, hash),
    ])
    if (!results[0].meta.changes || !results[1].meta.changes) {
      const saved = await receipt(access.userId, operationId, env)
      if (saved) return replay(saved, operationId, hash)
      if (!await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first()) throw new AdminError('PRODUCT_NOT_FOUND', 404)
      throw new AdminError('PRODUCT_CONFLICT', 409)
    }
  } catch (error) {
    const saved = await receipt(access.userId, operationId, env)
    if (saved) return replay(saved, operationId, hash)
    throw error
  }
  return { operationId, productId: id, revision: revision + 1 }
}

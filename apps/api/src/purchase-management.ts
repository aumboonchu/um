import type { AuthEnv } from './auth'
import { listPurchaseHistory, toPurchaseHistoryItem, type PurchaseRow } from './history'
import { withProductProfile } from './product-profile'

export class PurchaseManagementError extends Error {
  constructor(readonly code: 'INVALID_PURCHASE_CHANGE' | 'INVALID_MONTH' | 'PURCHASE_NOT_FOUND' | 'PRODUCT_NOT_FOUND' | 'PURCHASE_CONFLICT' | 'OPERATION_CONFLICT' | 'ROUND_LOCKED', readonly status: 400 | 404 | 409) { super(code) }
}
type DetailRow = PurchaseRow & { revision: number; updated_at: string; package_size: string | null; shopping_round_id: string | null }
type Receipt = { purchase_id: string; action: 'edit' | 'delete'; payload_hash: string; result_revision: number }
export type MutationResult = { operationId: string; purchaseId: string; action: 'edit' | 'delete'; revision: number }
type EditFields = { unitPriceMinor: number; quantity: number; purchasedAt: string; storeName: string | null; note: string | null }

const SELECT_PURCHASE = `SELECT p.id, p.product_id, COALESCE(pp.name, products.name) AS product_name, products.sku AS product_sku,
  products.upc AS product_upc, CASE WHEN pp.product_id IS NULL THEN products.brand ELSE pp.brand END AS product_brand,
  CASE WHEN pp.product_id IS NULL THEN products.package_size ELSE pp.package_size END AS package_size, products.image_url,
  stores.name AS store_name, p.unit_price_minor, p.quantity, p.total_minor, p.purchased_at, p.note, p.revision, p.updated_at, p.shopping_round_id
  FROM purchases p JOIN products ON products.id = p.product_id
  LEFT JOIN product_profiles pp ON pp.product_id = p.product_id AND pp.user_id = p.user_id
  LEFT JOIN stores ON stores.id = p.store_id AND stores.user_id = p.user_id`;

function idValue(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new PurchaseManagementError('INVALID_PURCHASE_CHANGE', 400)
  return id
}
export function monthRange(value: string | null, now = new Date()) {
  const month = value ?? new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 7)
  if (!/^(?:20\d{2}|2100)-(?:0[1-9]|1[0-2])$/.test(month)) throw new PurchaseManagementError('INVALID_MONTH', 400)
  const [year, number] = month.split('-').map(Number)
  return { month, start: new Date(Date.UTC(year, number - 1, 1) - 7 * 3600_000).toISOString(), end: new Date(Date.UTC(year, number, 1) - 7 * 3600_000).toISOString() }
}

export async function dashboard(url: URL, userId: string, env: AuthEnv) {
  const range = monthRange(url.searchParams.get('month'))
  const row = await env.DB.prepare(`SELECT COUNT(*) AS purchaseCount, COUNT(DISTINCT product_id) AS productCount,
    COALESCE(SUM(total_minor), 0) AS totalSpentMinor FROM purchases
    WHERE user_id = ? AND deleted_at IS NULL AND purchased_at >= ? AND purchased_at < ?`)
    .bind(userId, range.start, range.end).first<{ purchaseCount: number; productCount: number; totalSpentMinor: number }>()
  const recent = await listPurchaseHistory(new URL('https://internal.invalid/?limit=3'), userId, env)
  const summary = row ?? { purchaseCount: 0, productCount: 0, totalSpentMinor: 0 }
  return { ...range, ...summary, averageMinor: summary.purchaseCount ? Math.round(summary.totalSpentMinor / summary.purchaseCount) : 0, recentPurchases: recent.items }
}

export async function purchaseDetail(id: string, userId: string, env: AuthEnv) {
  const row = await env.DB.prepare(`${SELECT_PURCHASE} WHERE p.id = ? AND p.user_id = ? AND p.deleted_at IS NULL`)
    .bind(idValue(id), userId).first<DetailRow>()
  if (!row) throw new PurchaseManagementError('PURCHASE_NOT_FOUND', 404)
  return { ...toPurchaseHistoryItem(row), revision: row.revision, updatedAt: row.updated_at, packageSize: row.package_size, shoppingRoundId: row.shopping_round_id }
}

export async function productDetail(id: string, userId: string, env: AuthEnv, personalized = true) {
  idValue(id)
  // Catalog fields are shared, but access and every price/statistic below are account-scoped.
  const product = await env.DB.prepare(`SELECT id, sku, upc, name, brand, package_size AS packageSize, unit, category, image_url AS imageUrl
    FROM products WHERE id = ? AND (EXISTS (SELECT 1 FROM purchases WHERE product_id = products.id AND user_id = ?)
    OR EXISTS (SELECT 1 FROM product_image_imports WHERE product_id = products.id AND user_id = ?))`)
    .bind(id, userId, userId).first<{ id: string; sku: string; upc: string | null; name: string; brand: string | null; packageSize: string | null; unit: string | null; category: string | null; imageUrl: string | null }>()
  if (!product) throw new PurchaseManagementError('PRODUCT_NOT_FOUND', 404)
  const stats = await env.DB.prepare(`SELECT COUNT(*) AS purchaseCount, COALESCE(SUM(total_minor), 0) AS totalSpentMinor,
    COALESCE(SUM(quantity), 0) AS totalQuantity, MIN(unit_price_minor) AS minimumPriceMinor,
    MAX(unit_price_minor) AS maximumPriceMinor, MAX(purchased_at) AS lastPurchasedAt
    FROM purchases WHERE user_id = ? AND product_id = ? AND deleted_at IS NULL`).bind(userId, id).first()
  const recent = await env.DB.prepare(`${SELECT_PURCHASE} WHERE p.user_id = ? AND p.product_id = ? AND p.deleted_at IS NULL
    ORDER BY p.purchased_at DESC, p.id DESC LIMIT 20`).bind(userId, id).all<DetailRow>()
  return { ...(personalized ? await withProductProfile(product, userId, env) : { ...product, profileRevision: 0 }), ...stats, recentPurchases: recent.results.map(toPurchaseHistoryItem) }
}

function invalid(): never { throw new PurchaseManagementError('INVALID_PURCHASE_CHANGE', 400) }
function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.trim().length > max) return invalid()
  return value.trim() || null
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json') || !request.body) return invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 10_240) { await reader.cancel(); return invalid() }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { return invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function editFields(body: Record<string, unknown>): EditFields {
  const { unitPriceMinor, quantity, purchasedAt } = body
  if (typeof unitPriceMinor !== 'number' || !Number.isSafeInteger(unitPriceMinor) || unitPriceMinor <= 0 || unitPriceMinor > 100_000_000
    || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 10_000
    || !Number.isSafeInteger(Math.round(unitPriceMinor * quantity)) || Math.round(unitPriceMinor * quantity) <= 0
    || typeof purchasedAt !== 'string' || purchasedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(purchasedAt)
    || !Number.isFinite(Date.parse(purchasedAt))) return invalid()
  return { unitPriceMinor, quantity, purchasedAt: new Date(purchasedAt).toISOString(), storeName: optionalText(body.storeName, 80), note: optionalText(body.note, 500) }
}
async function payloadHash(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function receipt(userId: string, operationId: string, env: AuthEnv): Promise<Receipt | null> {
  return env.DB.prepare('SELECT purchase_id, action, payload_hash, result_revision FROM purchase_mutations WHERE user_id = ? AND operation_id = ?')
    .bind(userId, operationId).first<Receipt>()
}
function receiptResult(row: Receipt, operationId: string, hash: string): MutationResult {
  if (row.payload_hash !== hash) throw new PurchaseManagementError('OPERATION_CONFLICT', 409)
  return { operationId, purchaseId: row.purchase_id, action: row.action, revision: row.result_revision }
}

export async function changePurchase(request: Request, id: string, userId: string, env: AuthEnv): Promise<MutationResult> {
  idValue(id)
  const action = request.method === 'DELETE' ? 'delete' : 'edit'
  const body = await readBody(request)
  const allowed = action === 'delete' ? ['operationId', 'expectedRevision'] : ['operationId', 'expectedRevision', 'unitPriceMinor', 'quantity', 'purchasedAt', 'note', 'storeName']
  if (Object.keys(body).some((key) => !allowed.includes(key)) || typeof body.operationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)
    || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || body.expectedRevision > 1_000_000_000) return invalid()
  const operationId = body.operationId, revision = body.expectedRevision
  const fields = action === 'edit' ? editFields(body) : null
  const hash = await payloadHash({ id, action, revision, fields })
  const existing = await receipt(userId, operationId, env)
  if (existing) return receiptResult(existing, operationId, hash)
  // Check ownership before any store or mutation can be written.
  const current = await env.DB.prepare('SELECT revision, deleted_at, shopping_round_id FROM purchases WHERE id = ? AND user_id = ?')
    .bind(id, userId).first<{ revision: number; deleted_at: string | null; shopping_round_id: string | null }>()
  if (!current) throw new PurchaseManagementError('PURCHASE_NOT_FOUND', 404)
  if (current.shopping_round_id) throw new PurchaseManagementError('ROUND_LOCKED', 409)
  if (current.deleted_at || current.revision !== revision) throw new PurchaseManagementError('PURCHASE_CONFLICT', 409)
  const now = new Date().toISOString(), statements: D1PreparedStatement[] = []
  if (fields?.storeName) statements.push(env.DB.prepare(`INSERT INTO stores (id, user_id, name, created_at, updated_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM purchases WHERE id = ? AND user_id = ? AND revision = ? AND deleted_at IS NULL)
    ON CONFLICT(user_id, name) DO NOTHING`).bind(crypto.randomUUID(), userId, fields.storeName, now, now, id, userId, revision))
  const updateIndex = statements.length
  if (fields) statements.push(env.DB.prepare(`UPDATE purchases SET unit_price_minor = ?, quantity = ?, total_minor = ?, purchased_at = ?, note = ?,
    store_id = (SELECT id FROM stores WHERE user_id = ? AND name = ?), revision = revision + 1, updated_at = ?, last_mutation_id = ?
    WHERE id = ? AND user_id = ? AND revision = ? AND deleted_at IS NULL`)
    .bind(fields.unitPriceMinor, fields.quantity, Math.round(fields.unitPriceMinor * fields.quantity), fields.purchasedAt, fields.note,
      userId, fields.storeName, now, operationId, id, userId, revision))
  else statements.push(env.DB.prepare(`UPDATE purchases SET deleted_at = ?, updated_at = ?, revision = revision + 1, last_mutation_id = ?
    WHERE id = ? AND user_id = ? AND revision = ? AND deleted_at IS NULL`).bind(now, now, operationId, id, userId, revision))
  statements.push(env.DB.prepare(`INSERT INTO purchase_mutations (user_id, operation_id, purchase_id, action, payload_hash, result_revision, created_at)
    SELECT ?, ?, id, ?, ?, revision, ? FROM purchases WHERE id = ? AND user_id = ? AND last_mutation_id = ? AND revision = ?`)
    .bind(userId, operationId, action, hash, now, id, userId, operationId, revision + 1))
  try {
    const result = await env.DB.batch(statements)
    if (!result[updateIndex].meta.changes) {
      const replay = await receipt(userId, operationId, env)
      if (replay) return receiptResult(replay, operationId, hash)
      throw new PurchaseManagementError('PURCHASE_CONFLICT', 409)
    }
  } catch (error) {
    const replay = await receipt(userId, operationId, env)
    if (replay) return receiptResult(replay, operationId, hash)
    throw error
  }
  return { operationId, purchaseId: id, action, revision: revision + 1 }
}

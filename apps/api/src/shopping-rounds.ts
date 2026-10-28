import type { AuthEnv } from './auth'
import { monthRange } from './purchase-management'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type Line = { id: string; productId: string; unitPriceMinor: number; quantity: number; note: string | null }
type Checkout = { operationId: string; accountId: string; checkedOutAt: string; storeName: string | null; paymentMethod: string; note: string | null; lines: Line[] }
type RoundRow = { id: string; user_id: string; payload_hash: string; checked_out_at: string; store_name: string | null; payment_method: string; note: string | null; total_minor: number; line_count: number; created_at: string }

export class ShoppingRoundError extends Error {
  constructor(readonly code: 'INVALID_ROUND' | 'ROUND_ACCOUNT_MISMATCH' | 'ROUND_CONFLICT' | 'ROUND_NOT_FOUND' | 'ROUND_PRODUCT_NOT_FOUND', readonly status: 400 | 403 | 404 | 409) { super(code) }
}
function invalid(): never { throw new ShoppingRoundError('INVALID_ROUND', 400) }
function record(v: unknown): v is Record<string, unknown> { return Boolean(v) && typeof v === 'object' && !Array.isArray(v) }
function text(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) return invalid()
  return v.trim() || null
}
function keys(v: Record<string, unknown>, allowed: string[]) { if (Object.keys(v).some(key => !allowed.includes(key))) invalid() }
export function parseCheckout(v: unknown): Checkout {
  if (!record(v)) return invalid()
  keys(v, ['operationId', 'accountId', 'checkedOutAt', 'storeName', 'paymentMethod', 'note', 'lines'])
  if (typeof v.operationId !== 'string' || !UUID.test(v.operationId) || typeof v.accountId !== 'string' || !v.accountId || v.accountId.length > 100
    || typeof v.checkedOutAt !== 'string' || v.checkedOutAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v.checkedOutAt)
    || !Number.isFinite(Date.parse(v.checkedOutAt)) || typeof v.paymentMethod !== 'string' || !['cash', 'card', 'transfer', 'other'].includes(v.paymentMethod)
    || !Array.isArray(v.lines) || v.lines.length === 0 || v.lines.length > 100) return invalid()
  const seen = new Set<string>()
  const lines = v.lines.map((line): Line => {
    if (!record(line)) return invalid()
    keys(line, ['id', 'productId', 'unitPriceMinor', 'quantity', 'note'])
    if (typeof line.id !== 'string' || !UUID.test(line.id) || seen.has(line.id.toLowerCase())
      || typeof line.productId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(line.productId)
      || typeof line.unitPriceMinor !== 'number' || !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor <= 0 || line.unitPriceMinor > 100_000_000
      || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 10_000
      || !Number.isSafeInteger(Math.round(line.unitPriceMinor * line.quantity)) || Math.round(line.unitPriceMinor * line.quantity) <= 0) return invalid()
    seen.add(line.id.toLowerCase())
    return { id: line.id.toLowerCase(), productId: line.productId, unitPriceMinor: line.unitPriceMinor, quantity: line.quantity, note: text(line.note, 500) }
  })
  const total = lines.reduce((sum, line) => sum + Math.round(line.unitPriceMinor * line.quantity), 0)
  if (!Number.isSafeInteger(total) || total > 100_000_000_000_000) return invalid()
  return { operationId: v.operationId.toLowerCase(), accountId: v.accountId, checkedOutAt: new Date(v.checkedOutAt).toISOString(),
    storeName: text(v.storeName, 80), paymentMethod: v.paymentMethod, note: text(v.note, 500), lines }
}
async function readBody(request: Request): Promise<unknown> {
  const max = 128 * 1024
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body
    || Number(request.headers.get('content-length')) > max) return invalid()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try { while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.byteLength; if (size > max) { await reader.cancel(); return invalid() }
    chunks.push(value)
  } } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return invalid() }
}
function summary(row: RoundRow) {
  return { id: row.id, checkedOutAt: row.checked_out_at, storeName: row.store_name, paymentMethod: row.payment_method,
    note: row.note, totalMinor: row.total_minor, lineCount: row.line_count, createdAt: row.created_at }
}
async function find(id: string, env: AuthEnv): Promise<RoundRow | null> { return env.DB.prepare('SELECT * FROM shopping_rounds WHERE id = ?').bind(id).first<RoundRow>() }
function replay(row: RoundRow, input: Checkout, hash: string) {
  if (row.user_id !== input.accountId || row.payload_hash !== hash) throw new ShoppingRoundError('ROUND_CONFLICT', 409)
  return { ...summary(row), operationId: row.id, status: 'synced' as const }
}
/** Checkout is one atomic batch, not N independent purchase requests. */
export async function checkoutRound(request: Request, userId: string, env: AuthEnv) {
  const input = parseCheckout(await readBody(request))
  if (input.accountId !== userId) throw new ShoppingRoundError('ROUND_ACCOUNT_MISMATCH', 403)
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
  const existing = await find(input.operationId, env)
  if (existing) return replay(existing, input, hash)
  const linesJson = JSON.stringify(input.lines)
  const missing = await env.DB.prepare(`SELECT 1 AS missing FROM json_each(?) j
    LEFT JOIN products p ON p.id = json_extract(j.value, '$.productId') WHERE p.id IS NULL LIMIT 1`).bind(linesJson).first()
  if (missing) throw new ShoppingRoundError('ROUND_PRODUCT_NOT_FOUND', 404)
  const now = new Date().toISOString(), total = input.lines.reduce((sum, line) => sum + Math.round(line.unitPriceMinor * line.quantity), 0)
  const statements: D1PreparedStatement[] = []
  if (input.storeName) statements.push(env.DB.prepare(`INSERT INTO stores (id, user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO NOTHING`).bind(crypto.randomUUID(), userId, input.storeName, now, now))
  statements.push(env.DB.prepare(`INSERT INTO shopping_rounds (id, user_id, payload_hash, checked_out_at, store_name, payment_method, note, total_minor, line_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(input.operationId, userId, hash, input.checkedOutAt, input.storeName, input.paymentMethod, input.note, total, input.lines.length, now))
  statements.push(env.DB.prepare(`INSERT INTO purchases (id, user_id, product_id, store_id, unit_price_minor, quantity, total_minor, purchased_at, note, shopping_round_id, created_at, updated_at)
    SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.productId'), (SELECT id FROM stores WHERE user_id = ? AND name = ?),
      json_extract(value, '$.unitPriceMinor'), json_extract(value, '$.quantity'),
      CAST(ROUND(json_extract(value, '$.unitPriceMinor') * json_extract(value, '$.quantity')) AS INTEGER), ?, json_extract(value, '$.note'), ?, ?, ?
    FROM json_each(?)`).bind(userId, userId, input.storeName, input.checkedOutAt, input.operationId, now, now, linesJson))
  statements.push(env.DB.prepare(`INSERT INTO shopping_round_lines
    (round_id, position, purchase_id, product_id, product_name, product_sku, product_upc, package_size, unit_price_minor, quantity, total_minor, note)
    SELECT ?, CAST(j.key AS INTEGER), p.id, p.product_id, c.name, c.sku, c.upc, c.package_size, p.unit_price_minor, p.quantity, p.total_minor, p.note
    FROM json_each(?) j JOIN purchases p ON p.id = json_extract(j.value, '$.id') AND p.user_id = ? AND p.shopping_round_id = ?
    JOIN products c ON c.id = p.product_id`).bind(input.operationId, linesJson, userId, input.operationId))
  try { await env.DB.batch(statements) }
  catch (error) {
    const concurrent = await find(input.operationId, env)
    if (concurrent) return replay(concurrent, input, hash)
    // A line UUID already assigned to any purchase cannot be reused or moved.
    const collision = await env.DB.prepare(`SELECT 1 AS found FROM purchases WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?)) LIMIT 1`).bind(linesJson).first()
    if (collision) throw new ShoppingRoundError('ROUND_CONFLICT', 409)
    throw error
  }
  const saved = await find(input.operationId, env)
  if (!saved) throw new Error('Round receipt missing')
  return replay(saved, input, hash)
}
export async function roundDetail(id: string, userId: string, env: AuthEnv) {
  if (!UUID.test(id)) return invalid()
  const row = await env.DB.prepare('SELECT * FROM shopping_rounds WHERE id = ? AND user_id = ?').bind(id.toLowerCase(), userId).first<RoundRow>()
  if (!row) throw new ShoppingRoundError('ROUND_NOT_FOUND', 404)
  const lines = await env.DB.prepare(`SELECT purchase_id AS id, product_id AS productId, product_name AS productName,
    product_sku AS productSku, product_upc AS productUpc, package_size AS packageSize, unit_price_minor AS unitPriceMinor,
    quantity, total_minor AS totalMinor, note FROM shopping_round_lines WHERE round_id = ? ORDER BY position`).bind(row.id).all()
  return { ...summary(row), lines: lines.results }
}
export async function listRounds(url: URL, userId: string, env: AuthEnv) {
  const range = monthRange(url.searchParams.get('month'))
  let before: { date: string; id: string } | null = null
  const cursor = url.searchParams.get('cursor')
  if (cursor) {
    if (cursor.length > 300) return invalid()
    try { const v: unknown = JSON.parse(atob(cursor)); if (!record(v) || typeof v.date !== 'string' || !Number.isFinite(Date.parse(v.date)) || typeof v.id !== 'string' || !UUID.test(v.id)) return invalid(); before = { date: v.date, id: v.id } }
    catch { return invalid() }
  }
  const rows = await env.DB.prepare(`SELECT * FROM shopping_rounds WHERE user_id = ? AND checked_out_at >= ? AND checked_out_at < ?
    ${before ? 'AND (checked_out_at < ? OR (checked_out_at = ? AND id < ?))' : ''}
    ORDER BY checked_out_at DESC, id DESC LIMIT 21`).bind(userId, range.start, range.end, ...(before ? [before.date, before.date, before.id] : [])).all<RoundRow>()
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS roundCount, COALESCE(SUM(total_minor), 0) AS totalPaidMinor
    FROM shopping_rounds WHERE user_id = ? AND checked_out_at >= ? AND checked_out_at < ?`).bind(userId, range.start, range.end).first<{ roundCount: number; totalPaidMinor: number }>()
  const legacy = await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_minor), 0) AS totalMinor FROM purchases
    WHERE user_id = ? AND shopping_round_id IS NULL AND deleted_at IS NULL AND purchased_at >= ? AND purchased_at < ?`).bind(userId, range.start, range.end).first()
  const items = rows.results.slice(0, 20), last = items.at(-1)
  return { month: range.month, items: items.map(summary), summary: totals, legacy,
    nextCursor: rows.results.length > 20 && last ? btoa(JSON.stringify({ date: last.checked_out_at, id: last.id })) : null }
}

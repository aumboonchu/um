import type { AuthEnv } from './auth'

type PurchaseRow = {
  id: string
  product_id: string
  product_name: string
  product_upc: string
  product_brand: string | null
  image_url: string | null
  store_name: string | null
  unit_price_minor: number
  quantity: number
  total_minor: number
  purchased_at: string
  note: string | null
}

type ProductRow = {
  id: string
  upc: string
  name: string
  brand: string | null
  image_url: string | null
  purchase_count: number
  total_spent_minor: number
  last_purchased_at: string
}

type Cursor = { timestamp: string; id: string }

export type PurchaseHistoryItem = {
  id: string
  productId: string
  productName: string
  productUpc: string
  productBrand: string | null
  imageUrl: string | null
  storeName: string | null
  unitPriceMinor: number
  quantity: number
  totalMinor: number
  purchasedAt: string
  note: string | null
}

export type MyProductItem = {
  id: string
  upc: string
  name: string
  brand: string | null
  imageUrl: string | null
  purchaseCount: number
  totalSpentMinor: number
  lastPurchasedAt: string
}

export type Page<T> = {
  items: T[]
  nextCursor: string | null
}

export class HistoryInputError extends Error {
  constructor() {
    super('INVALID_HISTORY_QUERY')
  }
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

export async function listPurchaseHistory(url: URL, userId: string, env: AuthEnv): Promise<Page<PurchaseHistoryItem>> {
  const { limit, search, cursor } = parsePage(url)
  const bindings: Array<string | number> = [userId]
  const conditions = ['p.user_id = ?']

  if (search) {
    const like = `%${escapeLike(search)}%`
    conditions.push("(products.name LIKE ? ESCAPE '!' OR products.upc LIKE ? ESCAPE '!' OR COALESCE(stores.name, '') LIKE ? ESCAPE '!')")
    bindings.push(like, like, like)
  }
  if (cursor) {
    conditions.push('(p.purchased_at < ? OR (p.purchased_at = ? AND p.id < ?))')
    bindings.push(cursor.timestamp, cursor.timestamp, cursor.id)
  }
  bindings.push(limit + 1)

  const result = await env.DB.prepare(
    `SELECT p.id, p.product_id, products.name AS product_name, products.upc AS product_upc,
            products.brand AS product_brand, products.image_url, stores.name AS store_name,
            p.unit_price_minor, p.quantity, p.total_minor, p.purchased_at, p.note
       FROM purchases p
       INNER JOIN products ON products.id = p.product_id
       LEFT JOIN stores ON stores.id = p.store_id AND stores.user_id = p.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.purchased_at DESC, p.id DESC
      LIMIT ?`,
  )
    .bind(...bindings)
    .all<PurchaseRow>()

  const rows = result.results
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(toPurchaseHistoryItem)
  const last = items.at(-1)
  return { items, nextCursor: hasMore && last ? encodeCursor(last.purchasedAt, last.id) : null }
}

export async function listMyProducts(url: URL, userId: string, env: AuthEnv): Promise<Page<MyProductItem>> {
  const { limit, search, cursor } = parsePage(url)
  const bindings: Array<string | number> = [userId]
  const conditions = ['purchases.user_id = ?']

  if (search) {
    const like = `%${escapeLike(search)}%`
    conditions.push("(products.name LIKE ? ESCAPE '!' OR products.upc LIKE ? ESCAPE '!' OR COALESCE(products.brand, '') LIKE ? ESCAPE '!')")
    bindings.push(like, like, like)
  }
  const having: string[] = []
  if (cursor) {
    having.push('(MAX(purchases.purchased_at) < ? OR (MAX(purchases.purchased_at) = ? AND products.id < ?))')
    bindings.push(cursor.timestamp, cursor.timestamp, cursor.id)
  }
  bindings.push(limit + 1)

  const result = await env.DB.prepare(
    `SELECT products.id, products.upc, products.name, products.brand, products.image_url,
            COUNT(purchases.id) AS purchase_count,
            SUM(purchases.total_minor) AS total_spent_minor,
            MAX(purchases.purchased_at) AS last_purchased_at
       FROM purchases
       INNER JOIN products ON products.id = purchases.product_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY products.id, products.upc, products.name, products.brand, products.image_url
      ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
      ORDER BY last_purchased_at DESC, products.id DESC
      LIMIT ?`,
  )
    .bind(...bindings)
    .all<ProductRow>()

  const rows = result.results
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map(toMyProductItem)
  const last = items.at(-1)
  return { items, nextCursor: hasMore && last ? encodeCursor(last.lastPurchasedAt, last.id) : null }
}

function parsePage(url: URL): { limit: number; search: string | null; cursor: Cursor | null } {
  const limitValue = url.searchParams.get('limit')
  const limit = limitValue === null ? DEFAULT_LIMIT : Number(limitValue)
  const rawSearch = url.searchParams.get('q')
  const search = rawSearch?.trim() || null
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || (search && search.length > 80)) {
    throw new HistoryInputError()
  }
  return { limit, search, cursor: decodeCursor(url.searchParams.get('cursor')) }
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null
  try {
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    const separator = decoded.indexOf('|')
    const timestamp = decoded.slice(0, separator)
    const id = decoded.slice(separator + 1)
    if (separator < 1 || id.length === 0 || id.length > 100 || !Number.isFinite(Date.parse(timestamp))) throw new Error('invalid cursor')
    return { timestamp: new Date(timestamp).toISOString(), id }
  } catch {
    throw new HistoryInputError()
  }
}

function encodeCursor(timestamp: string, id: string): string {
  return btoa(`${timestamp}|${id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function escapeLike(value: string): string {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')
}

function toPurchaseHistoryItem(row: PurchaseRow): PurchaseHistoryItem {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    productUpc: row.product_upc,
    productBrand: row.product_brand,
    imageUrl: row.image_url,
    storeName: row.store_name,
    unitPriceMinor: row.unit_price_minor,
    quantity: row.quantity,
    totalMinor: row.total_minor,
    purchasedAt: row.purchased_at,
    note: row.note,
  }
}

function toMyProductItem(row: ProductRow): MyProductItem {
  return {
    id: row.id,
    upc: row.upc,
    name: row.name,
    brand: row.brand,
    imageUrl: row.image_url,
    purchaseCount: row.purchase_count,
    totalSpentMinor: row.total_spent_minor,
    lastPurchasedAt: row.last_purchased_at,
  }
}


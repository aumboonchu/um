import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import type { CachedProduct, PurchasePayload } from '../src/offline'

const databaseName = 'smartcart-offline'

const legacyProduct: CachedProduct = {
  id: 'product-existing',
  upc: '8851959129012',
  name: 'Existing cached product',
  brand: 'Existing brand',
  packageSize: '1.95 L',
  imageUrl: null,
  source: 'smartcart',
  sourcePriceMinor: 3500,
  regularPriceMinor: null,
  fetchedAt: null,
}

const purchase: PurchasePayload = {
  productId: legacyProduct.id,
  unitPriceMinor: 3500,
  quantity: 1,
  purchasedAt: '2026-10-25T00:00:00.000Z',
  storeName: 'Test store',
  note: null,
}

const existingOperation = {
  operationId: '11111111-1111-4111-8111-111111111111',
  operationType: 'create_purchase',
  payload: purchase,
  createdAt: '2026-10-25T00:00:00.000Z',
  status: 'pending',
}

function linkProduct(id: string): CachedProduct {
  return {
    ...legacyProduct,
    id: `bigc-product-${id}`,
    sku: `SC-BIGC-${id}`,
    upc: null,
    sourceProductId: id,
    source: 'bigc',
    fetchedAt: '2026-10-25T01:00:00.000Z',
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  return requestResult(indexedDB.open(databaseName))
}

async function readAll<T>(database: IDBDatabase, store: string): Promise<T[]> {
  return requestResult(database.transaction(store, 'readonly').objectStore(store).getAll())
}

async function seedVersionOne() {
  const request = indexedDB.open(databaseName, 1)
  request.onupgradeneeded = () => {
    const database = request.result
    database.createObjectStore('products', { keyPath: 'upc' })
    database.createObjectStore('operations', { keyPath: 'operationId' })
    database.createObjectStore('metadata', { keyPath: 'key' })
  }
  const database = await requestResult(request)
  const transaction = database.transaction(['products', 'operations', 'metadata'], 'readwrite')
  transaction.objectStore('products').put(legacyProduct)
  transaction.objectStore('operations').put(existingOperation)
  transaction.objectStore('metadata').put({ key: 'client-id', value: 'existing-device-client-id' })
  await transactionComplete(transaction)
  database.close()
}

beforeEach(() => {
  vi.resetModules()
  // Every test gets an isolated real IndexedDB implementation, not a mocked store.
  vi.stubGlobal('indexedDB', new IDBFactory())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('IndexedDB v2 product cache upgrade', () => {
  it('reports a blocked upgrade, then retries without losing queued operations once the old connection closes', async () => {
    await seedVersionOne()
    // Simulate another old SmartCart tab: v1 did not close on versionchange.
    const oldTab = await requestResult(indexedDB.open(databaseName, 1))
    const offline = await import('../src/offline')

    try {
      await expect(offline.getPendingOperationCount()).rejects.toThrow('INDEXEDDB_UPGRADE_BLOCKED')
      expect(oldTab.version).toBe(1)
      expect(await readAll(oldTab, 'operations')).toEqual([existingOperation])
      expect(await readAll(oldTab, 'products')).toEqual([legacyProduct])
    } finally {
      oldTab.close()
    }

    // The abandoned upgrade request must release its eventual connection and
    // the rejected open promise must not poison future IndexedDB operations.
    expect(await offline.getPendingOperationCount()).toBe(1)
    expect(await offline.findCachedProduct(legacyProduct.upc!)).toEqual(legacyProduct)
    const database = await openDatabase()
    expect(database.version).toBe(2)
    expect(await readAll(database, 'operations')).toEqual([existingOperation])
    expect(await readAll(database, 'metadata')).toEqual([{ key: 'client-id', value: 'existing-device-client-id' }])
    database.close()
  })

  it('upgrades real v1 stores without deleting existing products, pending operations or metadata', async () => {
    await seedVersionOne()
    const offline = await import('../src/offline')

    expect(await offline.getPendingOperationCount()).toBe(1)
    expect(await offline.findCachedProduct(legacyProduct.upc!)).toEqual(legacyProduct)

    const database = await openDatabase()
    expect(database.version).toBe(2)
    expect(Array.from(database.objectStoreNames)).toEqual(['metadata', 'operations', 'products', 'products-by-id'])
    expect(await readAll(database, 'products')).toEqual([legacyProduct])
    expect(await readAll(database, 'products-by-id')).toEqual([legacyProduct])
    expect(await readAll(database, 'operations')).toEqual([existingOperation])
    expect(await readAll(database, 'metadata')).toEqual([{ key: 'client-id', value: 'existing-device-client-id' }])
    database.close()
  })

  it('stores two SKU-only products with null UPC independently and keeps queued purchases', async () => {
    const offline = await import('../src/offline')
    const operation = await offline.queuePurchase(purchase)
    const first = linkProduct('100001')
    const second = linkProduct('100002')

    await offline.cacheProduct(first)
    await offline.cacheProduct(second)

    const database = await openDatabase()
    expect(await readAll(database, 'products-by-id')).toEqual([first, second])
    expect(await readAll(database, 'products')).toEqual([])
    expect(await readAll(database, 'operations')).toEqual([operation])
    expect(await offline.getPendingOperationCount()).toBe(1)
    database.close()
  })

  it('finds updated products by UPC in the new index without overwriting the legacy record', async () => {
    await seedVersionOne()
    const offline = await import('../src/offline')
    const updated = { ...legacyProduct, sku: 'SC-EXISTING', name: 'Updated cached product' }

    await offline.cacheProduct(updated)

    expect(await offline.findCachedProduct(legacyProduct.upc!)).toEqual(updated)
    const database = await openDatabase()
    expect(await readAll(database, 'products')).toEqual([legacyProduct])
    expect(await readAll(database, 'products-by-id')).toEqual([updated])
    database.close()
  })

  it('still finds old UPC records through the legacy fallback if they are absent from the new cache', async () => {
    await seedVersionOne()
    const offline = await import('../src/offline')
    await offline.getPendingOperationCount()
    const database = await openDatabase()
    const transaction = database.transaction('products-by-id', 'readwrite')
    transaction.objectStore('products-by-id').delete(legacyProduct.id)
    await transactionComplete(transaction)

    expect(await offline.findCachedProduct(legacyProduct.upc!)).toEqual(legacyProduct)
    expect(await offline.findCachedProduct('0000000000000')).toBeNull()
    database.close()
  })

  it('does not lose existing or newly queued purchases when a product cache write fails', async () => {
    await seedVersionOne()
    const offline = await import('../src/offline')
    const queued = await offline.queuePurchase({ ...purchase, quantity: 2 })
    const originalPut = IDBObjectStore.prototype.put
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'products-by-id') throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      return originalPut.call(this, value, key)
    })

    await expect(offline.cacheProduct(linkProduct('100003'))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    put.mockRestore()

    expect(await offline.getPendingOperationCount()).toBe(2)
    const database = await openDatabase()
    expect(await readAll(database, 'operations')).toEqual([existingOperation, queued].sort((a, b) => a.operationId.localeCompare(b.operationId)))
    expect(await readAll(database, 'products')).toEqual([legacyProduct])
    expect(await readAll(database, 'products-by-id')).toEqual([legacyProduct])
    expect(await offline.findCachedProduct(legacyProduct.upc!)).toEqual(legacyProduct)
    database.close()
  })
})


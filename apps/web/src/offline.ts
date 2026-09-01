export type CachedProduct = {
  id: string
  upc: string
  name: string
  brand: string | null
  packageSize: string | null
  imageUrl: string | null
  source: 'smartcart' | 'bigc'
  sourcePriceMinor: number | null
  regularPriceMinor: number | null
  fetchedAt: string | null
}

export type PurchasePayload = {
  productId: string
  unitPriceMinor: number
  quantity: number
  purchasedAt: string
  storeName: string | null
  note: string | null
}

type PendingOperation = {
  operationId: string
  operationType: 'create_purchase'
  payload: PurchasePayload
  createdAt: string
  status: 'pending' | 'retryable_error' | 'validation_error'
}

type SyncResponse = {
  data?: {
    operations?: Array<{
      operationId: string
      status: 'synced' | 'validation_error' | 'retryable_error'
    }>
  }
}

export type SyncSummary = {
  synced: number
  validationErrors: number
  retryableErrors: number
  pending: number
}

const DATABASE_NAME = 'smartcart-offline'
const DATABASE_VERSION = 1
const PRODUCTS_STORE = 'products'
const OPERATIONS_STORE = 'operations'
const META_STORE = 'metadata'
const CLIENT_ID_KEY = 'client-id'

let databasePromise: Promise<IDBDatabase> | undefined

export async function cacheProduct(product: CachedProduct): Promise<void> {
  const database = await openDatabase()
  await writeValue(database, PRODUCTS_STORE, product)
}

export async function findCachedProduct(upc: string): Promise<CachedProduct | null> {
  const database = await openDatabase()
  return (await readValue<CachedProduct>(database, PRODUCTS_STORE, upc)) ?? null
}

export async function queuePurchase(payload: PurchasePayload): Promise<PendingOperation> {
  const operation: PendingOperation = {
    operationId: crypto.randomUUID(),
    operationType: 'create_purchase',
    payload,
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  const database = await openDatabase()
  await writeValue(database, OPERATIONS_STORE, operation)
  return operation
}

export async function getPendingOperationCount(): Promise<number> {
  const database = await openDatabase()
  return (await readAll<PendingOperation>(database, OPERATIONS_STORE)).length
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist || !navigator.storage.persisted) return null
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

export async function syncPendingOperations(apiOrigin: string): Promise<SyncSummary> {
  const database = await openDatabase()
  const allOperations = await readAll<PendingOperation>(database, OPERATIONS_STORE)
  const operations = allOperations.filter((operation) => operation.status !== 'validation_error')
  if (operations.length === 0) {
    return { synced: 0, validationErrors: 0, retryableErrors: 0, pending: allOperations.length }
  }

  const response = await fetch(`${apiOrigin}/api/v1/sync`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: await getClientId(database), operations }),
  })
  if (!response.ok) throw new Error(`SYNC_REQUEST_FAILED:${response.status}`)

  const payload = (await response.json()) as SyncResponse
  const results = payload.data?.operations
  if (!results || results.length !== operations.length) throw new Error('SYNC_RESPONSE_INVALID')

  let synced = 0
  let validationErrors = 0
  let retryableErrors = 0
  for (const result of results) {
    const operation = operations.find((item) => item.operationId === result.operationId)
    if (!operation) throw new Error('SYNC_RESPONSE_INVALID')
    if (result.status === 'synced') {
      await deleteValue(database, OPERATIONS_STORE, operation.operationId)
      synced += 1
    } else {
      await writeValue(database, OPERATIONS_STORE, { ...operation, status: result.status })
      if (result.status === 'validation_error') validationErrors += 1
      else retryableErrors += 1
    }
  }

  return { synced, validationErrors, retryableErrors, pending: await getPendingOperationCount() }
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_OPEN_FAILED'))
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PRODUCTS_STORE)) database.createObjectStore(PRODUCTS_STORE, { keyPath: 'upc' })
      if (!database.objectStoreNames.contains(OPERATIONS_STORE)) database.createObjectStore(OPERATIONS_STORE, { keyPath: 'operationId' })
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
  })
  return databasePromise
}

async function getClientId(database: IDBDatabase): Promise<string> {
  const existing = await readValue<{ key: string; value: string }>(database, META_STORE, CLIENT_ID_KEY)
  if (existing?.value) return existing.value
  const value = crypto.randomUUID()
  await writeValue(database, META_STORE, { key: CLIENT_ID_KEY, value })
  return value
}

function readValue<T>(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return requestResult<T | undefined>(database.transaction(storeName, 'readonly').objectStore(storeName).get(key))
}

function readAll<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
  return requestResult<T[]>(database.transaction(storeName, 'readonly').objectStore(storeName).getAll())
}

async function writeValue(database: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  const transaction = database.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).put(value)
  await transactionComplete(transaction)
}

async function deleteValue(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  const transaction = database.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).delete(key)
  await transactionComplete(transaction)
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_REQUEST_FAILED'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_ABORTED'))
    transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_FAILED'))
  })
}


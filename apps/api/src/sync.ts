import type { AuthEnv } from './auth'
import { PurchaseInputError, PurchaseProductNotFoundError, createPurchaseFromPayload } from './purchases'

type SyncOperation = {
  operationId: string
  operationType: 'create_purchase'
  payload: unknown
}

type SyncRequest = {
  clientId: string
  operations: SyncOperation[]
}

export type SyncResult = {
  operationId: string
  status: 'synced' | 'validation_error' | 'retryable_error'
}

export class SyncInputError extends Error {
  constructor() {
    super('INVALID_SYNC')
  }
}

const MAX_SYNC_BYTES = 100 * 1024
const MAX_SYNC_OPERATIONS = 50

export async function syncOperations(request: Request, userId: string, env: AuthEnv): Promise<SyncResult[]> {
  const input = parseSyncRequest(await readJsonBody(request, MAX_SYNC_BYTES))
  const batchId = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO sync_batches (id, user_id, client_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(batchId, userId, input.clientId, now)
    .run()

  const results: SyncResult[] = []
  for (const operation of input.operations) {
    results.push(await processOperation(operation, batchId, userId, env))
  }

  await env.DB.prepare('UPDATE sync_batches SET completed_at = ? WHERE id = ?').bind(new Date().toISOString(), batchId).run()
  return results
}

async function processOperation(
  operation: SyncOperation,
  batchId: string,
  userId: string,
  env: AuthEnv,
): Promise<SyncResult> {
  const existing = await env.DB.prepare(
    `SELECT sync_operations.status, sync_batches.user_id
     FROM sync_operations
     JOIN sync_batches ON sync_batches.id = sync_operations.batch_id
     WHERE sync_operations.operation_id = ?
     LIMIT 1`,
  )
    .bind(operation.operationId)
    .first<{ status: SyncResult['status'] | 'pending'; user_id: string }>()

  // An operation ID is owned by the account that first submitted it.  Do not
  // allow a guessed UUID from another account to be retried or observed.
  if (existing && existing.user_id !== userId) {
    return { operationId: operation.operationId, status: 'validation_error' }
  }

  if (existing?.status === 'synced' || existing?.status === 'validation_error') {
    return { operationId: operation.operationId, status: existing.status }
  }

  if (!existing) {
    try {
      await env.DB.prepare(
        `INSERT INTO sync_operations
          (id, batch_id, operation_id, operation_type, entity_type, entity_id, status)
         VALUES (?, ?, ?, ?, 'purchase', ?, 'pending')`,
      )
        .bind(crypto.randomUUID(), batchId, operation.operationId, operation.operationType, operation.operationId)
        .run()
    } catch {
      const concurrent = await env.DB.prepare(
        `SELECT sync_operations.status, sync_batches.user_id
         FROM sync_operations
         JOIN sync_batches ON sync_batches.id = sync_operations.batch_id
         WHERE sync_operations.operation_id = ?
         LIMIT 1`,
      )
        .bind(operation.operationId)
        .first<{ status: SyncResult['status'] | 'pending'; user_id: string }>()
      if (concurrent && concurrent.user_id !== userId) {
        return { operationId: operation.operationId, status: 'validation_error' }
      }
      if (concurrent?.status === 'synced' || concurrent?.status === 'validation_error') {
        return { operationId: operation.operationId, status: concurrent.status }
      }
    }
  }

  try {
    await createPurchaseFromPayload(operation.payload, userId, env, operation.operationId)
    return markOperation(operation.operationId, 'synced', env)
  } catch (error) {
    if (await purchaseAlreadyExists(operation.operationId, userId, env)) {
      return markOperation(operation.operationId, 'synced', env)
    }
    if (error instanceof PurchaseInputError || error instanceof PurchaseProductNotFoundError) {
      return markOperation(operation.operationId, 'validation_error', env)
    }
    return markOperation(operation.operationId, 'retryable_error', env)
  }
}

async function markOperation(
  operationId: string,
  status: SyncResult['status'],
  env: AuthEnv,
): Promise<SyncResult> {
  await env.DB.prepare('UPDATE sync_operations SET status = ?, completed_at = ? WHERE operation_id = ?')
    .bind(status, new Date().toISOString(), operationId)
    .run()
  return { operationId, status }
}

async function purchaseAlreadyExists(operationId: string, userId: string, env: AuthEnv): Promise<boolean> {
  const purchase = await env.DB.prepare('SELECT id FROM purchases WHERE id = ? AND user_id = ? LIMIT 1')
    .bind(operationId, userId)
    .first()
  return Boolean(purchase)
}

function parseSyncRequest(value: unknown): SyncRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncInputError()
  const record = value as Record<string, unknown>
  const clientId = stringValue(record.clientId, 64)
  if (!clientId || !Array.isArray(record.operations) || record.operations.length === 0 || record.operations.length > MAX_SYNC_OPERATIONS) {
    throw new SyncInputError()
  }

  const operationIds = new Set<string>()
  const operations = record.operations.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyncInputError()
    const operation = value as Record<string, unknown>
    const operationId = stringValue(operation.operationId, 36)
    if (!operationId || !isUuid(operationId) || operation.operationType !== 'create_purchase' || operationIds.has(operationId)) {
      throw new SyncInputError()
    }
    operationIds.add(operationId)
    return { operationId, operationType: 'create_purchase' as const, payload: operation.payload }
  })

  return { clientId, operations }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new SyncInputError()
  if (!request.body) throw new SyncInputError()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new SyncInputError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new SyncInputError()
  }
}

function stringValue(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= maxLength ? value.trim() : null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}


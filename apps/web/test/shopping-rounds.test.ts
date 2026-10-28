import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ShoppingJourney } from '../src/ShoppingJourney'
import { RoundReports, localRoundReport, roundCsv } from '../src/RoundReports'
import { normalizeBarcode } from '../src/barcode-scanner'
import type { CartLine, CheckoutFields, ClosedRound } from '../src/shopping-rounds'
import type { ShoppingRoundsController } from '../src/useShoppingRounds'

const account = 'round-account-a', other = 'round-account-b'
const product = { id: 'oreo', sku: 'IMG-OREO', upc: null, name: 'OREO', brand: 'OREO', packageSize: '24.6 g x 12', imageUrl: null, source: 'smartcart' as const, sourcePriceMinor: 4500, regularPriceMinor: null, fetchedAt: null }
const line = (): CartLine => ({ id: crypto.randomUUID(), product: { ...product }, unitPriceMinor: 4500, quantity: 2, note: null })
const fields: CheckoutFields = { checkedOutAt: '2026-10-28T17:00:00+07:00', storeName: ' Makro Pro ', paymentMethod: 'cash', note: null }
beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
async function closedFixture() {
  const module = await import('../src/shopping-rounds')
  await module.writeDraft(account, null, [line()]); const { draft } = await module.readLocalRounds(account)
  await module.writeDraft(account, draft, draft!.lines, fields)
  return { module, round: (await module.readLocalRounds(account)).closed[0] }
}
const controller: ShoppingRoundsController = { draft: null, closed: [], pending: [], error: '', busy: false, loading: false, syncing: false, save: vi.fn(), sync: vi.fn(), refresh: vi.fn() }

describe('account-scoped durable cart and atomic local checkout', () => {
  it('retains draft lines across reads, separate from closed or synced purchases', async () => {
    const module = await import('../src/shopping-rounds'), item = line()
    await module.writeDraft(account, null, [item])
    const saved = await module.readLocalRounds(account)
    expect(saved.draft).toMatchObject({ accountId: account, revision: 1, lines: [item] }); expect(saved.closed).toEqual([])
    expect(await module.readLocalRounds(other)).toEqual({ draft: null, closed: [] })
  })
  it('edits and removes draft lines without touching completed reports', async () => {
    const module = await import('../src/shopping-rounds'), first = line(), second = line()
    await module.writeDraft(account, null, [first, second]); let draft = (await module.readLocalRounds(account)).draft!
    await module.writeDraft(account, draft, [{ ...first, quantity: 3 }]); draft = (await module.readLocalRounds(account)).draft!
    expect(draft.revision).toBe(2); expect(draft.lines).toMatchObject([{ quantity: 3 }])
    await module.writeDraft(account, draft, []); expect((await module.readLocalRounds(account)).draft?.lines).toEqual([])
  })
  it('atomically moves all items into one immutable checkout UUID, ready for offline sync', async () => {
    const { module, round } = await closedFixture()
    const saved = await module.readLocalRounds(account)
    expect(saved.draft).toBeNull(); expect(saved.closed).toHaveLength(1); expect(round.status).toBe('pending')
    expect(round.payload).toMatchObject({ accountId: account, operationId: round.id, checkedOutAt: '2026-10-28T10:00:00.000Z', storeName: 'Makro Pro', lines: [{ productId: 'oreo', quantity: 2, unitPriceMinor: 4500 }] })
    expect(round.payload.lines[0]).not.toHaveProperty('productName')
  })
  it('rejects a stale tab rather than overwriting the current cart', async () => {
    const module = await import('../src/shopping-rounds'), first = line(), second = line()
    await module.writeDraft(account, null, [first]); const stale = (await module.readLocalRounds(account)).draft!
    await module.writeDraft(account, stale, [first, second])
    await expect(module.writeDraft(account, stale, [])).rejects.toThrow('ROUND_DRAFT_CONFLICT')
    expect((await module.readLocalRounds(account)).draft?.lines).toHaveLength(2)
  })
  it('makes simultaneous local checkout calls contend; only one round can close', async () => {
    const module = await import('../src/shopping-rounds'); await module.writeDraft(account, null, [line()])
    const draft = (await module.readLocalRounds(account)).draft!
    const results = await Promise.allSettled([module.writeDraft(account, draft, draft.lines, fields), module.writeDraft(account, draft, draft.lines, fields)])
    expect(results.filter(v => v.status === 'fulfilled')).toHaveLength(1); expect((await module.readLocalRounds(account)).closed).toHaveLength(1)
  })
  it('does not erase or close a draft if the outbox write fails', async () => {
    const module = await import('../src/shopping-rounds'); await module.writeDraft(account, null, [line()])
    const draft = (await module.readLocalRounds(account)).draft!
    const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    await expect(module.writeDraft(account, draft, draft.lines, fields)).rejects.toThrow('quota'); add.mockRestore()
    expect(await module.readLocalRounds(account)).toEqual({ draft, closed: [] })
  })
  it('refuses account changes or empty/duplicate/over-limit checkout payloads', async () => {
    const module = await import('../src/shopping-rounds'); await module.writeDraft(account, null, [line()]); const draft = (await module.readLocalRounds(account)).draft!
    await expect(module.writeDraft(other, draft, draft.lines, fields)).rejects.toThrow('INVALID_ROUND')
    for (const lines of [[], [draft.lines[0], draft.lines[0]], Array(101).fill(draft.lines[0])]) expect(() => module.checkoutPayload({ ...draft, lines }, fields)).toThrow('INVALID_ROUND')
  })
  it('starts a fresh UUID after checkout without reusing a paid round', async () => {
    const { module, round } = await closedFixture(); await module.writeDraft(account, null, [line()])
    expect((await module.readLocalRounds(account)).draft?.id).not.toBe(round.id)
  })
  it('fails closed when stored payload no longer matches the confirmed cart', async () => {
    const { module, round } = await closedFixture()
    await new Promise<void>((resolve, reject) => { const request = indexedDB.open('smartcart-shopping-rounds'); request.onsuccess = () => {
      const tx = request.result.transaction('rounds', 'readwrite'); tx.objectStore('rounds').put({ ...round, payload: { ...round.payload, lines: [] } })
      tx.oncomplete = () => { request.result.close(); resolve() }; tx.onerror = () => reject(tx.error)
    } })
    await expect(module.readLocalRounds(account)).rejects.toThrow('ROUND_STORAGE_CORRUPT')
    const send = vi.fn(); await expect(module.syncClosedRounds(account, '', send)).rejects.toThrow(); expect(send).not.toHaveBeenCalled()
  })
})

describe('retryable whole-round sync', () => {
  it('replays exact UUID and frozen payload after network failure, then retains a synced cache', async () => {
    const { module, round } = await closedFixture()
    const send = vi.fn<typeof import('../src/auth-client').apiFetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json({ data: { id: round.id, operationId: round.id, status: 'synced', totalMinor: 9000, lineCount: 1 } }))
    await expect(module.syncClosedRounds(account, '', send)).rejects.toThrow('offline')
    expect((await module.readLocalRounds(account)).closed[0].status).toBe('pending')
    expect(await module.syncClosedRounds(account, '', send)).toBe(1)
    expect(send.mock.calls[0][2]?.body).toBe(send.mock.calls[1][2]?.body)
    expect((await module.readLocalRounds(account)).closed[0]).toMatchObject({ id: round.id, status: 'synced', lines: round.lines })
    expect(await module.syncClosedRounds(account, '', send)).toBe(0); expect(send).toHaveBeenCalledTimes(2)
  })
  it.each([401, 403, 404, 409, 500])('retains pending data after HTTP %s', async status => {
    const { module } = await closedFixture()
    await expect(module.syncClosedRounds(account, '', async () => json({ error: { code: 'ROUND_ERROR' } }, status))).rejects.toThrow('ROUND_ERROR')
    expect((await module.readLocalRounds(account)).closed[0].status).toBe('pending')
  })
  it.each([{ totalMinor: 1 }, { lineCount: 3 }, { id: crypto.randomUUID() }, { operationId: crypto.randomUUID() }, { status: 'pending' }])('does not accept an unrelated or incomplete success receipt %#', async wrong => {
    const { module, round } = await closedFixture()
    await expect(module.syncClosedRounds(account, '', async () => json({ data: { id: round.id, operationId: round.id, status: 'synced', totalMinor: 9000, lineCount: 1, ...wrong } }))).rejects.toThrow('ROUND_RESPONSE_INVALID')
    expect((await module.readLocalRounds(account)).closed[0].status).toBe('pending')
  })
  it('does not send another account pending rounds', async () => {
    const { module } = await closedFixture(), send = vi.fn()
    expect(await module.syncClosedRounds(other, '', send)).toBe(0); expect(send).not.toHaveBeenCalled()
  })
  it('settles on timeout even when transport ignores abort', async () => {
    const { module } = await closedFixture(); vi.useFakeTimers()
    const pending = module.syncClosedRounds(account, '', () => new Promise(() => {})); const asserted = expect(pending).rejects.toThrow('ROUND_TIMEOUT')
    await vi.advanceTimersByTimeAsync(20_000); await asserted; vi.useRealTimers()
    expect((await module.readLocalRounds(account)).closed[0].status).toBe('pending')
  })
})

describe('clear round reports and scan-first entry', () => {
  it('keeps pack quantities and totals in per-round CSV without formula injection', async () => {
    const { round } = await closedFixture(), report = localRoundReport(round)
    report.lines[0].productName = '=WEBSERVICE("evil")'; report.note = 'a,"b"'
    const csv = roundCsv(report, 'รอซิงก์')
    expect(csv).toContain("'=WEBSERVICE"); expect(csv).toContain('"a,""b"""'); expect(csv).toContain('"รอซิงก์"')
    expect(csv).toContain('"24.6 g x 12","2","45.00","90.00"'); expect(csv).toContain('"รวมทั้งรอบ (บาท)","90.00"')
  })
  it('validates line count and total before showing a server report', async () => {
    const { module, round } = await closedFixture(), report = localRoundReport(round)
    expect(module.validRoundReport(report)).toBe(true)
    expect(module.validRoundReport({ ...report, totalMinor: 1 })).toBe(false)
    expect(module.validRoundReport({ ...report, lineCount: 2 })).toBe(false)
    expect(module.validRoundReport({ ...report, lines: [{ ...report.lines[0], totalMinor: 1 }] })).toBe(false)
  })
  it('starts with scan and an empty draft rather than auto-saving individual purchases', () => {
    const html = renderToStaticMarkup(createElement(ShoppingJourney, { accountId: account, apiOrigin: '', online: true, rounds: controller, initialProduct: null, onConsumed: vi.fn() }))
    expect(html).toContain('เริ่มสแกนสินค้า'); expect(html).toContain('ค้นหาในฐานข้อมูล'); expect(html).toContain('ชำระเงิน / จบรอบนี้')
    expect(html).not.toContain('บันทึกรายการซื้อ</button>'); expect(html).toContain('ยังไม่รวมในรายงานค่าใช้จ่าย')
  })
  it('does not show fake round totals for a signed-out account', () => {
    const html = renderToStaticMarkup(createElement(RoundReports, { accountId: null, apiOrigin: '', online: true, version: 0, rounds: controller }))
    expect(html).toContain('เข้าสู่ระบบเพื่อดูรอบซื้อของคุณ'); expect(html).not.toContain('ยอดชำระรวม (D1)')
  })
  it.each(['197584', '00000000', '8851959129013', 'https://evil.example', 'QR'])('rejects non-barcode input %s', value => { expect(normalizeBarcode(value)).toBeNull() })
  it('keeps leading zeros and accepts actual GTIN checksums', () => { expect(normalizeBarcode('8851959129012')).toBe('8851959129012'); expect(normalizeBarcode('3017620422003')).toBe('3017620422003') })
})

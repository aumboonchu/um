import { useEffect, useRef, useState } from 'react'
import { bangkokMonth, formatMoney, formatPurchaseDate } from './purchase-management'
import { cartTotal, roundMessage, roundRequest, validRoundPage, validRoundReport, type ClosedRound, type RoundPage, type RoundReport } from './shopping-rounds'
import type { ShoppingRoundsController } from './useShoppingRounds'

export const paymentLabel = (value: string) => ({ cash: 'เงินสด', card: 'บัตร', transfer: 'โอนเงิน', other: 'อื่น ๆ' })[value] ?? value
export function localRoundReport(round: ClosedRound): RoundReport {
  return { id: round.id, checkedOutAt: round.payload.checkedOutAt, createdAt: round.payload.checkedOutAt, storeName: round.payload.storeName,
    paymentMethod: round.payload.paymentMethod, note: round.payload.note, totalMinor: cartTotal(round.lines), lineCount: round.lines.length,
    lines: round.lines.map(line => ({ id: line.id, productId: line.product.id, productName: line.product.name, productSku: line.product.sku ?? line.product.id,
      productUpc: line.product.upc, packageSize: line.product.packageSize, unitPriceMinor: line.unitPriceMinor, quantity: line.quantity,
      totalMinor: Math.round(line.unitPriceMinor * line.quantity), note: line.note })) }
}
export function roundCsv(report: RoundReport, status = 'บันทึกเข้า D1 แล้ว'): string {
  const cell = (value: unknown) => { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"` }
  const rows: unknown[][] = [['รหัสรอบ', report.id], ['สถานะ', status], ['เวลา', report.checkedOutAt], ['ร้านค้า', report.storeName], ['วิธีชำระ', paymentLabel(report.paymentMethod)], ['หมายเหตุรอบ', report.note],
    ['สินค้า', 'SKU', 'UPC', 'ขนาดบรรจุ', 'จำนวน', 'ราคาต่อหน่วย (บาท)', 'ยอดรวม (บาท)', 'หมายเหตุสินค้า'],
    ...report.lines.map(line => [line.productName, line.productSku, line.productUpc, line.packageSize, line.quantity, (line.unitPriceMinor / 100).toFixed(2), (line.totalMinor / 100).toFixed(2), line.note]),
    ['รวมทั้งรอบ (บาท)', (report.totalMinor / 100).toFixed(2)]]
  return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n')
}
function download(report: RoundReport, status: string) {
  const url = URL.createObjectURL(new Blob([roundCsv(report, status)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `smartcart-round-${report.id}.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
export function RoundReports({ accountId, apiOrigin, online, version, rounds }: { accountId: string | null; apiOrigin: string; online: boolean; version: number; rounds: ShoppingRoundsController }) {
  const [month, setMonth] = useState(bangkokMonth), [data, setData] = useState<RoundPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<RoundReport | null>(null), [source, setSource] = useState(''), [reload, setReload] = useState(0)
  const sequence = useRef(0), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1 } }, [])
  async function load(cursor: string | null = null) {
    if (!accountId || !online || !/^\d{4}-\d{2}$/.test(month)) return
    const token = ++sequence.current; setLoading(true); setError('')
    try {
      const value = await roundRequest(`/api/v1/rounds?${new URLSearchParams({ month, ...(cursor ? { cursor } : {}) })}`, apiOrigin)
      if (!validRoundPage(value) || value.month !== month) throw new Error('ROUND_RESPONSE_INVALID')
      if (!mounted.current || token !== sequence.current) return
      setData(previous => cursor && previous?.month === month ? { ...value, items: [...previous.items, ...value.items].filter((item, index, all) => all.findIndex(v => v.id === item.id) === index) } : value)
    } catch (e) { if (mounted.current && token === sequence.current) setError(roundMessage(e instanceof Error ? e.message : '')) }
    finally { if (mounted.current && token === sequence.current) setLoading(false) }
  }
  useEffect(() => { setSelected(null); setSource(''); setData(null); void load(); return () => { sequence.current += 1 } }, [accountId, online, month, version, reload])
  async function openReport(id: string) {
    const token = ++sequence.current; setLoading(true); setError('')
    try {
      const value = await roundRequest(`/api/v1/rounds/${encodeURIComponent(id)}`, apiOrigin)
      if (!validRoundReport(value) || value.id !== id) throw new Error('ROUND_RESPONSE_INVALID')
      if (mounted.current && token === sequence.current) { setSelected(value); setSource('บันทึกเข้า D1 แล้ว') }
    } catch (e) { if (mounted.current && token === sequence.current) setError(roundMessage(e instanceof Error ? e.message : '')) }
    finally { if (mounted.current && token === sequence.current) setLoading(false) }
  }
  const cached = rounds.closed.filter(round => new Date(Date.parse(round.payload.checkedOutAt) + 7 * 3600_000).toISOString().slice(0, 7) === month)
  const local = online ? cached.filter(round => round.status === 'pending') : cached
  return <section className="content-panel round-reports" aria-labelledby="round-report-title"><div className="section-heading"><div><p className="eyebrow">แยกรายงานตามรอบชำระ</p><h2 id="round-report-title">รายงานรายรอบ</h2></div><button className="secondary-button" disabled={!accountId || !online || loading} onClick={() => { void rounds.sync(); setReload(v => v + 1) }}>โหลด / ซิงก์ใหม่</button></div>
    <label className="month-filter">เดือน (เวลาไทย)<input type="month" min="2000-01" max="2100-12" value={month} onChange={e => setMonth(e.target.value)} /></label>
    {!accountId ? <p className="empty-state">เข้าสู่ระบบเพื่อดูรอบซื้อของคุณ</p> : null}
    {loading ? <p role="status">กำลังโหลดรายงาน…</p> : null}{error || rounds.error ? <p className="error-message" role="alert">{error || rounds.error}</p> : null}
    {!online ? <p className="status-message">ออฟไลน์ — แสดงเฉพาะสำเนารอบที่มีในอุปกรณ์นี้ ไม่ใช่รายงานทั้งหมดของบัญชี D1 เป็นข้อมูลหลัก</p> : null}
    {data ? <><dl className="summary-grid"><div className="summary-main"><dt>ยอดชำระรวม (D1)</dt><dd>{formatMoney(data.summary.totalPaidMinor)}</dd></div><div><dt>รอบที่ชำระแล้ว (D1)</dt><dd>{data.summary.roundCount} รอบ</dd></div><div><dt>เฉลี่ยต่อรอบ</dt><dd>{formatMoney(data.summary.roundCount ? Math.round(data.summary.totalPaidMinor / data.summary.roundCount) : 0)}</dd></div></dl><p className="status-message">ไม่รวมรอบกำลังเลือกสินค้าและรอบรอซิงก์</p>
      {data.legacy.count ? <p className="image-import-notice">รายการเดิมที่ยังไม่ผูกรอบ {data.legacy.count} รายการ · {formatMoney(data.legacy.totalMinor)} แยกจากยอดรายรอบด้านบน ดูได้ในหมวดข้อมูลเดิมด้านล่าง ไม่เดาว่ารายการใดเป็นรอบเดียวกัน</p> : null}
      <div className="summary-purchases">{data.items.map(round => <button className="summary-purchase" key={round.id} disabled={loading} onClick={() => void openReport(round.id)}><span><strong>รอบ {round.id.slice(0, 8)} · {round.storeName ?? 'ไม่ระบุร้าน'}</strong><small>{formatPurchaseDate(round.checkedOutAt)} · {round.lineCount} รายการ · {paymentLabel(round.paymentMethod)} · บันทึกเข้า D1 แล้ว</small></span><strong>{formatMoney(round.totalMinor)}</strong></button>)}</div>
      {!data.items.length ? <p className="empty-state">ยังไม่มีรอบที่ชำระและซิงก์สำเร็จในเดือนนี้</p> : null}
      {data.nextCursor ? <button className="secondary-button" disabled={loading} onClick={() => void load(data.nextCursor)}>ดูรอบก่อนหน้าเพิ่มเติม</button> : null}</> : null}
    {local.length ? <div className="pending-change"><h3>{online ? 'จบรอบแล้ว รอยืนยัน D1' : 'รอบที่เก็บบนอุปกรณ์นี้'}</h3>{local.map(round => <button className="summary-purchase" key={round.id} onClick={() => { setSelected(localRoundReport(round)); setSource(round.status === 'synced' ? 'cache บนอุปกรณ์ — เคยยืนยัน D1 แล้ว' : 'จบรอบบนอุปกรณ์แล้ว ยังรอยืนยัน D1') }}><span><strong>รอบ {round.id.slice(0, 8)} · {round.payload.storeName ?? 'ไม่ระบุร้าน'}</strong><small>{formatPurchaseDate(round.payload.checkedOutAt)} · {round.lines.length} รายการ · {round.status === 'pending' ? 'รอซิงก์' : 'cache'}</small></span><strong>{formatMoney(cartTotal(round.lines))}</strong></button>)}<button className="primary-button" disabled={!online || rounds.syncing} onClick={() => void rounds.sync()}>ซิงก์รอบที่ค้างด้วยรหัสเดิม</button><p>ข้อมูลที่ยังไม่เข้า D1 อาจสูญหายหากอุปกรณ์ล้างพื้นที่เก็บข้อมูล</p></div> : null}
    {selected ? <article className="round-receipt"><div className="section-heading"><h3>รายละเอียดรอบ {selected.id.slice(0, 8)}</h3><button className="secondary-button" onClick={() => setSelected(null)}>ปิดรายละเอียด</button></div><p className="source-badge">{source}</p><p className="round-id">รหัสเต็ม: {selected.id}</p><dl className="detail-grid"><div><dt>ร้านค้า</dt><dd>{selected.storeName ?? 'ไม่ระบุ'}</dd></div><div><dt>เวลาชำระ</dt><dd>{formatPurchaseDate(selected.checkedOutAt)}</dd></div><div><dt>วิธีชำระ</dt><dd>{paymentLabel(selected.paymentMethod)}</dd></div><div><dt>จำนวนรายการ</dt><dd>{selected.lineCount}</dd></div></dl>
      {selected.lines.map((line, index) => <div className="round-line" key={line.id}><div><strong>{index + 1}. {line.productName}</strong><small>{line.packageSize} · SKU {line.productSku}</small><small>UPC {line.productUpc ?? 'ไม่มีบาร์โค้ด'} · {line.quantity} × {formatMoney(line.unitPriceMinor)}</small>{line.note ? <small>{line.note}</small> : null}</div><strong>{formatMoney(line.totalMinor)}</strong></div>)}
      <p className="round-total">ยอดชำระทั้งรอบ <strong>{formatMoney(selected.totalMinor)}</strong></p>{selected.note ? <p>หมายเหตุ: {selected.note}</p> : null}<p className="status-message">บันทึกการชำระด้วยตนเอง ไม่ใช่ใบเสร็จหรือหลักฐานยืนยันจากร้านค้า</p><button className="primary-button" onClick={() => download(selected, source)}>ดาวน์โหลดรายงานรอบนี้ (CSV)</button>
    </article> : null}
  </section>
}

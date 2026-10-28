import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bangkokMonth, formatMoney, formatPurchaseDate } from './purchase-management'
import { cartTotal, roundMessage, roundRequest, validRoundPage, validRoundReport, type ClosedRound, type RoundPage, type RoundReport } from './shopping-rounds'
import type { ShoppingRoundsController } from './useShoppingRounds'
import { Icon, PageHeader, ProductThumb } from './ui'

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
export function RoundReports({ accountId, apiOrigin, online, version, rounds, initialRoundId, onAccount, onFocusChange, legacy }: { accountId: string | null; apiOrigin: string; online: boolean; version: number; rounds: ShoppingRoundsController; initialRoundId?: string | null; onAccount?: () => void; onFocusChange?: (focused: boolean) => void; legacy?: ReactNode }) {
  const [month, setMonth] = useState(bangkokMonth), [data, setData] = useState<RoundPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<RoundReport | null>(null), [source, setSource] = useState(''), [reload, setReload] = useState(0)
  const sequence = useRef(0), mounted = useRef(true)
  const initialOpened = useRef<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }); heading.current?.focus({ preventScroll: true }) }, [selected?.id])
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
  useEffect(() => { setData(null); void load(); return () => { sequence.current += 1 } }, [accountId, online, month, version, reload])
  useEffect(() => { onFocusChange?.(Boolean(selected)); return () => onFocusChange?.(false) }, [Boolean(selected), onFocusChange])
  useEffect(() => {
    if (!initialRoundId || initialOpened.current === initialRoundId) return
    const local = rounds.closed.find(round => round.id === initialRoundId)
    if (local) { initialOpened.current = initialRoundId; setSelected(localRoundReport(local)); setSource(local.status === 'synced' ? 'บันทึกเข้า D1 แล้ว' : 'รอซิงก์') }
    else if (online) { initialOpened.current = initialRoundId; void openReport(initialRoundId) }
  }, [initialRoundId, online, rounds.closed])
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
  function closeReport() { setSelected(null); setSource(''); if (!data && online) setReload(value => value + 1) }
  const selectedLocal = selected ? rounds.closed.find(round => round.id === selected.id) : null
  const isPending = selectedLocal?.status === 'pending' || source === 'รอซิงก์' && selectedLocal?.status !== 'synced'
  const receiptSource = isPending ? 'รอซิงก์' : selectedLocal?.status === 'synced' ? online ? 'บันทึกเข้า D1 แล้ว' : 'cache บนอุปกรณ์ — เคยยืนยัน D1 แล้ว' : source
  if (selected) return <section className="round-reports mobile-page focused-page" aria-labelledby="round-report-title">
    <PageHeader title="สรุปรอบซื้อ" id="round-report-title" headingRef={heading} onBack={closeReport} trailing={<button className="icon-button" aria-label="ส่งออก CSV" onClick={() => download(selected, receiptSource)}><Icon name="share" /></button>} />
    <div className="page-content receipt-content"><div className="receipt-identity"><div><h2>{selected.storeName ?? 'ไม่ระบุร้าน'}</h2><p className="muted">{formatPurchaseDate(selected.checkedOutAt)}</p></div><span className={`status-chip${isPending ? ' pending' : ''}`}><Icon name={isPending ? 'clock' : 'checkSmall'} />{isPending ? 'รอซิงก์' : 'ซิงก์แล้ว'}</span></div>
      <div className="round-amount"><span className="muted">ยอดรวมรอบนี้</span><p className="amount">{formatMoney(selected.totalMinor)}</p></div><hr />
      <div className="receipt-lines">{selected.lines.map(line => <div className="product-row" key={line.id}><ProductThumb /><span className="row-description"><strong>{line.productName}</strong><small>{line.packageSize ?? ''}</small></span><span className="row-amount"><strong>{formatMoney(line.totalMinor)}</strong><small>{line.quantity} × {formatMoney(line.unitPriceMinor)}</small></span></div>)}</div>
      <div className="summary-row small"><span>ชำระด้วย</span><span>{paymentLabel(selected.paymentMethod)}</span></div>
      {isPending ? <p className="pending-caption">อย่าล้างข้อมูลก่อนซิงก์</p> : null}
      <details className="disclosure"><summary>รายละเอียดรอบ<Icon name="down" /></summary><div><p className="round-id">รหัสรอบ: {selected.id}</p><p className="muted">{isPending ? 'เก็บบนเครื่อง ยังรอยืนยันจาก D1' : receiptSource}</p>{selected.note ? <p>{selected.note}</p> : null}{selected.lines.map(line => <p className="muted" key={line.id}>{line.productName} · SKU {line.productSku} · UPC {line.productUpc ?? 'ไม่มี'}{line.note ? ` · ${line.note}` : ''}</p>)}<p className="muted">บันทึกการชำระด้วยตนเอง ไม่ใช่ใบเสร็จจากร้านค้า</p></div></details>
      <div className="page-actions"><button className="secondary-button" onClick={() => download(selected, receiptSource)}><Icon name="export" />ส่งออก CSV</button></div>
    </div>
  </section>
  return <section className="round-reports mobile-page" aria-labelledby="round-report-title"><PageHeader title="รายงาน" id="round-report-title" headingRef={heading} onAccount={onAccount} /><div className="page-content reports-content">
    {!accountId ? <p className="empty-state">เข้าสู่ระบบเพื่อดูรอบซื้อของคุณ</p> : null}
    <div className="report-controls"><label className="month-control"><span>{/^\d{4}-\d{2}$/.test(month) ? new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`)) : 'เลือกเดือน'}</span><Icon name="down" /><input aria-label="เดือน" type="month" min="2000-01" max="2100-12" value={month} onChange={e => setMonth(e.target.value)} /></label><button className="text-button" disabled={!accountId || !online || loading || rounds.syncing} onClick={() => { void rounds.sync(); setReload(v => v + 1) }}>รีเฟรช</button></div>
    {loading ? <p role="status" className="muted">กำลังโหลดรายงาน…</p> : null}{error || rounds.error ? <p className="error-message" role="alert">{error || rounds.error}</p> : null}
    {!online ? <p className="pending-caption">ออฟไลน์ · แสดงเฉพาะรอบที่เก็บในเครื่องนี้</p> : null}
    {data ? <>
      <div className="monthly-summary"><span>ยอดซื้อเดือนนี้</span><p className="amount">{formatMoney(data.summary.totalPaidMinor)}</p><span className="muted">{data.summary.roundCount} รอบ · ซิงก์แล้ว</span></div>
      <div className="round-report-list">{data.items.map(round => <button className="report-row" key={round.id} disabled={loading} onClick={() => void openReport(round.id)} aria-label={`ดูรอบ ${round.storeName ?? 'ไม่ระบุร้าน'} ${formatPurchaseDate(round.checkedOutAt)}`}><span className="product-thumb"><Icon name="reportActive" /></span><span className="row-description"><strong>{round.storeName ?? 'ไม่ระบุร้าน'}</strong><small>{formatPurchaseDate(round.checkedOutAt)}</small></span><span className="row-amount"><strong>{formatMoney(round.totalMinor)}</strong><small>{round.lineCount} รายการ</small></span></button>)}</div>
      {!data.items.length ? <p className="empty-state">ยังไม่มีรอบซื้อในเดือนนี้</p> : null}
      {data.nextCursor ? <button className="secondary-button" disabled={loading} onClick={() => void load(data.nextCursor)}>ดูรอบก่อนหน้า</button> : null}
      {data.summary.roundCount ? <details className="disclosure"><summary>สรุปเพิ่มเติม<Icon name="down" /></summary><div className="summary-row"><span>เฉลี่ยต่อรอบ</span><strong>{formatMoney(Math.round(data.summary.totalPaidMinor / data.summary.roundCount))}</strong></div></details> : null}
    </> : null}
    {local.length ? <div className="pending-rounds"><h2>{online ? 'รอซิงก์' : 'รอบบนเครื่องนี้'}</h2>{local.map(round => <button className="report-row" key={round.id} onClick={() => { setSelected(localRoundReport(round)); setSource(round.status === 'synced' ? 'cache บนอุปกรณ์ — เคยยืนยัน D1 แล้ว' : 'รอซิงก์') }}><span className="product-thumb pending"><Icon name="clock" /></span><span className="row-description"><strong>{round.payload.storeName ?? 'ไม่ระบุร้าน'}</strong><small>{formatPurchaseDate(round.payload.checkedOutAt)}</small></span><span className="row-amount"><strong>{formatMoney(cartTotal(round.lines))}</strong><small>{round.status === 'pending' ? 'รอซิงก์' : 'cache'}</small></span></button>)}{local.some(round => round.status === 'pending') ? <><button className="secondary-button" disabled={!online || rounds.syncing} onClick={() => void rounds.sync()}>{rounds.syncing ? 'กำลังซิงก์…' : 'ซิงก์อีกครั้ง'}</button><p className="pending-caption">อย่าล้างข้อมูลก่อนซิงก์</p></> : null}</div> : null}
    {data?.legacy.count ? <p className="muted small-text">รายการเดิม {data.legacy.count} รายการ · {formatMoney(data.legacy.totalMinor)} ไม่รวมในยอดรายรอบ</p> : null}
    {legacy}
  </div></section>
}

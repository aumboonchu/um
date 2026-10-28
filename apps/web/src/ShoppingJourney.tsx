import { useEffect, useRef, useState, type FormEvent } from 'react'
import BarcodeScanner from './BarcodeScanner'
import ImageImport from './ImageImport'
import { apiFetch } from './auth-client'
import { cacheProduct, findCachedProduct, requestPersistentStorage, type CachedProduct } from './offline'
import { formatMoney, localDateTime, purchaseFieldsPayload } from './purchase-management'
import { cartTotal, roundMessage, type CartLine, type CheckoutFields } from './shopping-rounds'
import type { ShoppingRoundsController } from './useShoppingRounds'
import { normalizeBarcode } from './barcode-scanner'

export function ShoppingJourney({ accountId, apiOrigin, online, visible = true, rounds, initialProduct, onConsumed }: { accountId: string | null; apiOrigin: string; online: boolean; visible?: boolean; rounds: ShoppingRoundsController; initialProduct: CachedProduct | null; onConsumed: () => void }) {
  const [stage, setStage] = useState<'scan' | 'add' | 'image' | 'quantity'>('scan'), [upc, setUpc] = useState('')
  const [product, setProduct] = useState<CachedProduct | null>(null), [name, setName] = useState(''), [brand, setBrand] = useState('')
  const [packageSize, setPackageSize] = useState('')
  const [price, setPrice] = useState(''), [quantity, setQuantity] = useState('1'), [note, setNote] = useState(''), [editing, setEditing] = useState<string | null>(null)
  const [editingRevision, setEditingRevision] = useState<number | null>(null), [confirmationRevision, setConfirmationRevision] = useState<number | null>(null)
  const [working, setWorking] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [checkout, setCheckout] = useState(false), [confirmed, setConfirmed] = useState(false), [store, setStore] = useState(''), [method, setMethod] = useState<CheckoutFields['paymentMethod']>('cash'), [date, setDate] = useState(localDateTime), [roundNote, setRoundNote] = useState('')
  const active = useRef(true), sequence = useRef(0), busy = useRef(false), title = useRef<HTMLHeadingElement>(null)
  const canUse = visible && Boolean(accountId) && !rounds.loading && !rounds.busy && !working
  const checkoutConfirmed = confirmed && confirmationRevision === rounds.draft?.revision
  const selectedCallback = useRef(onConsumed); selectedCallback.current = onConsumed
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current += 1 } }, [])
  useEffect(() => { if (initialProduct) { select(initialProduct); void cacheProduct(initialProduct).catch(() => {}); selectedCallback.current() } }, [initialProduct?.id])
  useEffect(() => { title.current?.focus({ preventScroll: true }); if (stage !== 'scan') title.current?.scrollIntoView({ block: 'nearest' }) }, [stage])
  useEffect(() => {
    if (!product && !checkout) return
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave)
  }, [product, checkout])
  function reset() { sequence.current += 1; setProduct(null); setStage('scan'); setUpc(''); setEditing(null); setPrice(''); setQuantity('1'); setNote(''); setName(''); setBrand(''); setPackageSize(''); setError('') }
  function select(selected: CachedProduct) {
    setProduct(selected); setPrice(selected.sourcePriceMinor === null ? '' : (selected.sourcePriceMinor / 100).toFixed(2)); setQuantity('1'); setNote(''); setStage('quantity'); setError(''); setMessage('พบสินค้าแล้ว กรอกราคาที่ซื้อจริงและจำนวนก่อนเพิ่มเข้ารอบ')
  }
  async function lookup(code: string) {
    if (!canUse || busy.current) return
    const normalized = normalizeBarcode(code)
    if (!normalized) { setError('บาร์โค้ดไม่ถูกต้อง กรุณาสแกนหรือกรอก UPC / EAN อีกครั้ง'); return }
    const token = ++sequence.current
    busy.current = true; setWorking(true); setError(''); setMessage('กำลังค้นหาในฐานข้อมูล SmartCart…'); setUpc(normalized)
    try {
      let found: CachedProduct | null = null
      if (!online) found = await findCachedProduct(normalized)
      else {
        const response = await apiFetch(apiOrigin, `/api/v1/products/upc/${encodeURIComponent(normalized)}?databaseOnly=1`, { signal: AbortSignal.timeout(20_000) })
        if (response.ok) { const body = await response.json() as { data: CachedProduct }; if (body.data?.upc !== normalized || !body.data.id || !body.data.name) throw new Error('BAD_PRODUCT'); found = body.data }
        else if (response.status !== 404) throw new Error('LOOKUP_FAILED')
      }
      if (!active.current || token !== sequence.current) return
      if (found) { select(found); try { await cacheProduct(found) } catch { setMessage('พบสินค้าแล้ว แต่ยังเก็บ cache ไม่ได้') } }
      else { setName(''); setBrand(''); setProduct(null); setStage('add'); setMessage(online ? 'ไม่พบสินค้านี้ในฐานข้อมูล เพิ่มข้อมูลสินค้าแล้วกลับมาใส่จำนวนและราคา' : 'ยังไม่มีสินค้านี้ใน cache ต้องออนไลน์เพื่อเพิ่มสินค้าใหม่ รอบที่เลือกไว้ยังเก็บอยู่') }
    } catch { if (active.current && token === sequence.current) { setError('ยังค้นหาสินค้าไม่สำเร็จ ไม่ได้สรุปว่าไม่มีสินค้า กรุณาลองใหม่'); setMessage('') } }
    finally { busy.current = false; if (active.current) setWorking(false) }
  }
  async function addProduct(e: FormEvent) {
    e.preventDefault(); if (!canUse || !online || !accountId || busy.current) return
    busy.current = true; setWorking(true); setError(''); const token = ++sequence.current
    try {
      const response = await apiFetch(apiOrigin, '/api/v1/products', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upc, name: name.trim(), brand: brand.trim() || null, packageSize: packageSize.trim() || null }), signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error('SAVE_PRODUCT_FAILED')
      const body = await response.json() as { data: CachedProduct }
      if (!body.data?.id || body.data.upc !== upc || !body.data.name) throw new Error('BAD_PRODUCT')
      if (!active.current || token !== sequence.current) return
      select(body.data); try { await cacheProduct(body.data) } catch { /* Confirmed product remains authoritative. */ }
    } catch { if (active.current && token === sequence.current) setError('ยังยืนยันการเพิ่มสินค้าไม่ได้ ลองค้นบาร์โค้ดเดิมอีกครั้งก่อนเพิ่มใหม่') }
    finally { busy.current = false; if (active.current) setWorking(false) }
  }
  async function addLine(e: FormEvent) {
    e.preventDefault(); if (!canUse || !product || busy.current) return
    busy.current = true; setError('')
    try {
      const values = purchaseFieldsPayload({ price, quantity, note, storeName: '', purchasedAt: localDateTime() })
      const line: CartLine = { id: editing ?? crypto.randomUUID(), product, unitPriceMinor: values.unitPriceMinor, quantity: values.quantity, note: values.note }
      const lines = rounds.draft?.lines ?? []
      if (editing && rounds.draft?.revision !== editingRevision) throw new Error('ROUND_DRAFT_CONFLICT')
      if (editing && !lines.some(item => item.id === editing)) throw new Error('ROUND_DRAFT_CONFLICT')
      await rounds.save(editing ? lines.map(item => item.id === editing ? line : item) : [...lines, line])
      if (!active.current) return
      reset(); setMessage(editing ? 'แก้ไขรายการในรอบแล้ว' : 'เพิ่มสินค้าเข้ารอบแล้ว — สแกนชิ้นต่อไป หรือกดชำระเงิน / จบรอบ')
      try { const persisted = await requestPersistentStorage(); if (persisted !== true && active.current) setMessage('เพิ่มเข้ารอบแล้ว แต่อุปกรณ์ไม่รับประกันการเก็บถาวร ควรจบรอบและซิงก์เข้า D1 เมื่อพร้อม') } catch { /* The IndexedDB write already succeeded. */ }
    } catch (e) { if (active.current) setError(e instanceof Error && e.message.startsWith('ROUND_') ? roundMessage(e.message) : e instanceof Error ? e.message : 'เพิ่มเข้ารอบไม่สำเร็จ') }
    finally { busy.current = false }
  }
  async function removeLine(id: string) {
    if (!canUse || busy.current) return
    busy.current = true
    try { await rounds.save((rounds.draft?.lines ?? []).filter(line => line.id !== id)); if (editing === id) reset() }
    catch (e) { setError(roundMessage(e instanceof Error ? e.message : '')) } finally { busy.current = false }
  }
  function editLine(line: CartLine) { setEditingRevision(rounds.draft?.revision ?? null); setProduct(line.product); setPrice((line.unitPriceMinor / 100).toFixed(2)); setQuantity(String(line.quantity)); setNote(line.note ?? ''); setEditing(line.id); setStage('quantity'); setMessage('แก้ไขรายการในรอบที่ยังไม่ชำระ'); setError('') }
  async function finish(e: FormEvent) {
    e.preventDefault(); if (!canUse || !rounds.draft || !checkoutConfirmed || busy.current) return
    busy.current = true; setError('')
    try {
      const checkedOutAt = new Date(date).toISOString()
      await rounds.save(rounds.draft.lines, { checkedOutAt, storeName: store, paymentMethod: method, note: roundNote })
      if (!active.current) return
      reset(); setCheckout(false); setConfirmed(false); setStore(''); setRoundNote(''); setDate(localDateTime()); setMessage('จบรอบและเก็บข้อมูลบนอุปกรณ์แล้ว ดูสถานะซิงก์ด้านล่างหรือในรายงานรายรอบ ยังไม่ถือว่าข้อมูลอยู่ใน D1 จนกว่าจะยืนยันซิงก์สำเร็จ')
    } catch (e) { setError(roundMessage(e instanceof RangeError ? 'INVALID_ROUND' : e instanceof Error ? e.message : 'INVALID_ROUND')) }
    finally { busy.current = false }
  }
  return <section className="content-panel shopping-journey" aria-labelledby="shopping-title">
    <p className="eyebrow">สแกน → เพิ่มเข้ารอบ → ชำระเงิน → รายงานรายรอบ</p><h2 id="shopping-title" ref={title} tabIndex={-1}>{checkout ? 'ตรวจยอดและจบรอบ' : stage === 'add' || stage === 'image' ? 'เพิ่มข้อมูลสินค้าใหม่' : stage === 'quantity' ? 'จำนวนและราคาสินค้า' : 'เริ่มสแกนสินค้า'}</h2>
    {!accountId ? <p className="empty-state">เข้าสู่ระบบด้วย Google เพื่อเริ่มรอบซื้อสินค้า</p> : null}
    {rounds.loading ? <p role="status">กำลังเปิดรอบที่เก็บไว้บนเครื่อง…</p> : null}
    {message ? <p role="status" className="success-message">{message}</p> : null}
    {error || rounds.error ? <p role="alert" className="error-message">{error || rounds.error}</p> : null}
    {rounds.error ? <button className="secondary-button" onClick={() => void rounds.refresh()}>โหลดรอบบนอุปกรณ์อีกครั้ง</button> : null}
    {!checkout && stage === 'scan' ? <>
      <BarcodeScanner disabled={!canUse} onDetected={code => { void lookup(code) }} />
      <form className="lookup-form" onSubmit={e => { e.preventDefault(); void lookup(upc) }}><label htmlFor="round-upc">UPC / EAN<input id="round-upc" value={upc} onChange={e => setUpc(e.target.value)} inputMode="numeric" maxLength={14} disabled={!canUse} placeholder="สแกนกล้อง หรือกรอกบาร์โค้ด" /></label><button className="primary-button" disabled={!canUse}>{working ? 'กำลังค้นหา…' : 'ค้นหาในฐานข้อมูล'}</button></form>
      <button className="secondary-button" disabled={!canUse || !online} onClick={() => { setUpc(''); setStage('image'); setMessage('เพิ่มสินค้าจากภาพก่อน แล้วใส่จำนวนและราคาเพื่อเข้ารอบ') }}>เพิ่มจากภาพ Big C / Makro Pro (ไม่มีบาร์โค้ดก็ได้)</button>
    </> : null}
    {!checkout && stage === 'add' ? <>
      <p>บาร์โค้ดที่สแกน: <strong>{upc}</strong></p>
      <form className="manual-form" onSubmit={e => void addProduct(e)}><label>ชื่อสินค้า<input value={name} onChange={e => setName(e.target.value)} maxLength={200} required disabled={!canUse || !online} /></label><label>แบรนด์ (ไม่บังคับ)<input value={brand} onChange={e => setBrand(e.target.value)} maxLength={100} disabled={!canUse || !online} /></label><label>ขนาดบรรจุ / จำนวนชิ้นต่อแพ็ก (ไม่บังคับ)<input value={packageSize} onChange={e => setPackageSize(e.target.value)} maxLength={100} placeholder="เช่น 24.6 g x 12" disabled={!canUse || !online} /></label><button className="primary-button" disabled={!canUse || !online}>บันทึกสินค้า → ใส่จำนวนและราคา</button></form>
      <button className="secondary-button" disabled={!canUse || !online} onClick={() => setStage('image')}>ใช้ภาพ Big C / Makro Pro ช่วยเพิ่มข้อมูล</button>
    </> : null}
    {!checkout && stage === 'image' ? <ImageImport accountId={accountId} apiOrigin={apiOrigin} canImport={canUse && online} scannedUpc={upc || null} onProduct={value => {
      void cacheProduct(value).catch(() => {})
      if (upc && value.upc !== upc) { setStage('add'); setMessage('กู้ผลนำเข้ารายการเดิมสำเร็จแล้ว แต่บาร์โค้ดไม่ตรงกับสินค้าที่กำลังเพิ่ม กรุณาเพิ่มข้อมูลสำหรับบาร์โค้ดที่สแกนต่อ'); return }
      select(value)
    }} /> : null}
    {!checkout && stage === 'quantity' && product ? <form className="edit-purchase" onSubmit={e => void addLine(e)}>
      <h3>{product.name}</h3><p>{product.packageSize ?? ''} · UPC: {product.upc ?? 'ไม่มีบาร์โค้ด'}</p><p className="status-message">ยังไม่บันทึกเป็นยอดใช้จ่ายจนกดชำระเงิน / จบรอบ ราคาอ้างอิงแก้เป็นราคาที่ซื้อจริงได้ สินค้าขายเป็นแพ็กให้จำนวน 1 = 1 แพ็ก</p>
      <fieldset className="purchase-fieldset purchase-form" disabled={!canUse}><legend>รายการในรอบนี้</legend><label>จำนวน<input inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} required /></label><label>ราคาต่อหน่วย / แพ็ก (บาท)<input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} required /></label><label className="full-width">หมายเหตุสินค้า<input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></label></fieldset><button className="primary-button" disabled={!canUse}>{editing ? 'บันทึกแก้ไขในรอบ' : 'เพิ่มเข้ารอบนี้ → สแกนต่อ'}</button>
    </form> : null}
    {!checkout && stage !== 'scan' ? <button className="secondary-button" disabled={!canUse} onClick={() => { reset(); setMessage('กลับมาสแกนสินค้า รายการที่เพิ่มเข้ารอบไว้ยังอยู่') }}>← กลับไปสแกน / ยกเลิกรายการที่ยังไม่เพิ่ม</button> : null}
    <div className="round-cart"><div className="section-heading"><h3>รอบซื้อปัจจุบัน</h3><strong>{rounds.draft?.lines.length ?? 0} รายการ</strong></div><p className="status-message">กำลังเลือกสินค้า · เก็บร่างใน IndexedDB ของบัญชีนี้ ยังไม่รวมในรายงานค่าใช้จ่าย</p>
      {rounds.draft?.lines.map((line, index) => <article className="round-line" key={line.id}><div><strong>{index + 1}. {line.product.name}</strong><small>{line.product.packageSize} · {line.quantity} × {formatMoney(line.unitPriceMinor)}</small>{line.note ? <small>{line.note}</small> : null}</div><strong>{formatMoney(Math.round(line.quantity * line.unitPriceMinor))}</strong>{!checkout ? <div className="detail-actions"><button className="secondary-button" disabled={!canUse} onClick={() => editLine(line)}>แก้ไข</button><button className="danger-outline" disabled={!canUse} onClick={() => void removeLine(line.id)}>เอาออกจากรอบ</button></div> : null}</article>)}
      {!rounds.draft?.lines.length ? <p className="empty-state">ยังไม่มีสินค้า เริ่มจากสแกนชิ้นแรก</p> : null}
      <p className="round-total">ยอดรวมรอบนี้ <strong>{formatMoney(cartTotal(rounds.draft?.lines ?? []))}</strong></p>
      {!checkout ? <button className="primary-button checkout-button" disabled={!canUse || !rounds.draft?.lines.length || stage !== 'scan'} onClick={() => { setDate(localDateTime()); setCheckout(true); setConfirmed(false); setError('') }}>ชำระเงิน / จบรอบนี้</button> : <form className="checkout-form" onSubmit={e => void finish(e)}>
        <fieldset className="purchase-fieldset purchase-form" disabled={!canUse}><legend>ข้อมูลทั้งรอบ (เก็บเมื่อยืนยันจบรอบ)</legend><label className="full-width">ร้านค้า<input value={store} onChange={e => { setStore(e.target.value); setConfirmed(false) }} maxLength={80} placeholder="เช่น Makro Pro / Big C" /></label><label>วันที่ชำระ (เวลาบนอุปกรณ์)<input type="datetime-local" step="1" value={date} onChange={e => { setDate(e.target.value); setConfirmed(false) }} required /></label><label>วิธีชำระ<select value={method} onChange={e => { setMethod(e.target.value as CheckoutFields['paymentMethod']); setConfirmed(false) }}><option value="cash">เงินสด</option><option value="card">บัตร</option><option value="transfer">โอนเงิน</option><option value="other">อื่น ๆ</option></select></label><label className="full-width">หมายเหตุรอบ<input value={roundNote} onChange={e => { setRoundNote(e.target.value); setConfirmed(false) }} maxLength={500} /></label></fieldset>
        <p className="image-import-notice">ปุ่มนี้บันทึกว่าคุณชำระแล้วเท่านั้น ไม่ตัดเงินจริง เมื่อจบรอบ ข้อมูลทั้งรอบจะไม่เปิดให้แก้รายชิ้น เพื่อคงยอดรายงานให้ตรงกัน</p><label className="delete-check"><input type="checkbox" checked={checkoutConfirmed} onChange={e => { setConfirmed(e.target.checked); setConfirmationRevision(rounds.draft?.revision ?? null) }} disabled={!canUse} /><span>ตรวจจำนวนและราคาแล้ว ยืนยันยอด {formatMoney(cartTotal(rounds.draft?.lines ?? []))} ของรอบนี้</span></label><button className="primary-button" disabled={!canUse || !checkoutConfirmed}>ยืนยันชำระแล้วและบันทึกรอบ</button><button type="button" className="secondary-button" disabled={!canUse} onClick={() => setCheckout(false)}>กลับไปแก้ไข / สแกนต่อ</button>
      </form>}
    </div>
    {rounds.pending.length ? <div className="pending-change" role="status"><strong>จบรอบแล้ว รอซิงก์ {rounds.pending.length} รอบ</strong><p>รอบถูกเก็บไว้บนอุปกรณ์ ยังไม่รับประกันว่าจะไม่สูญหายจนกว่าจะเข้า D1 ห้ามล้างข้อมูลเว็บ</p><button className="primary-button" disabled={!online || rounds.syncing} onClick={() => void rounds.sync()}>{rounds.syncing ? 'กำลังยืนยันกับ D1…' : 'ซิงก์รอบที่ค้างด้วยรหัสเดิม'}</button></div> : null}
    {rounds.closed[0] ? <p className={rounds.closed[0].status === 'synced' ? 'success-message' : 'status-message'} role="status">รอบล่าสุด {rounds.closed[0].id.slice(0, 8)} · {formatMoney(cartTotal(rounds.closed[0].lines))} · {rounds.closed[0].status === 'synced' ? 'บันทึกเข้า D1 แล้ว เก็บสำเนาบนอุปกรณ์เป็น cache' : 'จบรอบบนอุปกรณ์แล้ว รอยืนยัน D1'}</p> : null}
  </section>
}

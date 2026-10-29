import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import BarcodeScanner from './BarcodeScanner'
import ImageImport from './ImageImport'
import { apiFetch } from './auth-client'
import { cacheProduct, findCachedProduct, requestPersistentStorage, type CachedProduct } from './offline'
import { formatMoney, localDateTime, purchaseFieldsPayload } from './purchase-management'
import { cartTotal, roundMessage, type CartLine, type CheckoutFields } from './shopping-rounds'
import type { ShoppingRoundsController } from './useShoppingRounds'
import { normalizeBarcode } from './barcode-scanner'
import { Icon, PageHeader, ProductThumb } from './ui'

export function ShoppingJourney({ accountId, apiOrigin, online, visible = true, rounds, initialProduct, onConsumed, onAccount, onReport, onFocusChange, action }: { accountId: string | null; apiOrigin: string; online: boolean; visible?: boolean; rounds: ShoppingRoundsController; initialProduct: CachedProduct | null; onConsumed: () => void; onAccount?: () => void; onReport?: (id: string) => void; onFocusChange?: (focused: boolean) => void; action?: number }) {
  const id = useId()
  const [stage, setStage] = useState<'scan' | 'manual' | 'add' | 'image' | 'quantity'>('scan'), [upc, setUpc] = useState('')
  const [product, setProduct] = useState<CachedProduct | null>(null), [name, setName] = useState(''), [brand, setBrand] = useState('')
  const [packageSize, setPackageSize] = useState('')
  const [price, setPrice] = useState(''), [quantity, setQuantity] = useState('1'), [note, setNote] = useState(''), [editing, setEditing] = useState<string | null>(null)
  const [editingRevision, setEditingRevision] = useState<number | null>(null), [confirmationRevision, setConfirmationRevision] = useState<number | null>(null)
  const [working, setWorking] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [checkout, setCheckout] = useState(false), [store, setStore] = useState(''), [method, setMethod] = useState<CheckoutFields['paymentMethod']>('cash'), [date, setDate] = useState(localDateTime), [roundNote, setRoundNote] = useState('')
  const [cartVisible, setCartVisible] = useState(false)
  const [completed, setCompleted] = useState<{ id: string; total: number; store: string; date: string } | null>(null)
  const active = useRef(true), sequence = useRef(0), busy = useRef(false), title = useRef<HTMLHeadingElement>(null)
  const canUse = visible && Boolean(accountId) && !rounds.loading && !rounds.busy && !working
  const checkoutConfirmed = confirmationRevision !== null && confirmationRevision === rounds.draft?.revision
  const selectedCallback = useRef(onConsumed); selectedCallback.current = onConsumed
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current += 1 } }, [])
  useEffect(() => { if (initialProduct) { select(initialProduct); void cacheProduct(initialProduct, accountId).catch(() => {}); selectedCallback.current() } }, [initialProduct?.id, accountId])
  useEffect(() => { if (action) { reset(); setCheckout(false); setCompleted(null); setStage('image'); selectedCallback.current() } }, [action])
  useEffect(() => { title.current?.focus({ preventScroll: true }); if (stage !== 'scan' || checkout || completed) title.current?.scrollIntoView({ block: 'nearest' }) }, [stage, checkout, completed?.id, cartVisible])
  useEffect(() => { onFocusChange?.(visible && (stage !== 'scan' || checkout || Boolean(completed))); return () => onFocusChange?.(false) }, [stage, checkout, Boolean(completed), visible, onFocusChange])
  useEffect(() => {
    if (!product && !checkout) return
    const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave)
  }, [product, checkout])
  function reset() { sequence.current += 1; setProduct(null); setStage('scan'); setUpc(''); setEditing(null); setPrice(''); setQuantity('1'); setNote(''); setName(''); setBrand(''); setPackageSize(''); setError('') }
  function select(selected: CachedProduct) {
    setCompleted(null); setProduct(selected); setPrice(selected.sourcePriceMinor === null ? '' : (selected.sourcePriceMinor / 100).toFixed(2)); setQuantity('1'); setNote(''); setStage('quantity'); setError(''); setMessage('')
  }
  async function lookup(code: string) {
    if (!canUse || busy.current) return
    const normalized = normalizeBarcode(code)
    if (!normalized) { setError('บาร์โค้ดไม่ถูกต้อง กรุณาสแกนหรือกรอก UPC / EAN อีกครั้ง'); return }
    const token = ++sequence.current
    busy.current = true; setWorking(true); setError(''); setMessage('กำลังค้นหาในฐานข้อมูล SmartCart…'); setUpc(normalized)
    try {
      let found: CachedProduct | null = null
      if (!online) found = await findCachedProduct(normalized, accountId)
      else {
        const response = await apiFetch(apiOrigin, `/api/v1/products/upc/${encodeURIComponent(normalized)}?databaseOnly=1`, { signal: AbortSignal.timeout(20_000) })
        if (response.ok) { const body = await response.json() as { data: CachedProduct }; if (body.data?.upc !== normalized || !body.data.id || !body.data.name) throw new Error('BAD_PRODUCT'); found = body.data }
        else if (response.status !== 404) throw new Error('LOOKUP_FAILED')
      }
      if (!active.current || token !== sequence.current) return
      if (found) { select(found); try { await cacheProduct(found, accountId) } catch { setMessage('พบสินค้าแล้ว แต่ยังเก็บ cache ไม่ได้') } }
      else { setName(''); setBrand(''); setProduct(null); setStage('add'); setMessage(online ? '' : 'ยังไม่มีในเครื่อง เชื่อมต่ออินเทอร์เน็ตเพื่อเพิ่มสินค้า') }
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
      select(body.data); try { await cacheProduct(body.data, accountId) } catch { /* Confirmed product remains authoritative. */ }
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
      reset(); setCartVisible(true); setMessage(editing ? 'แก้ไขแล้ว' : 'เพิ่มเข้ารอบแล้ว')
      try { await requestPersistentStorage() } catch { /* D1 remains the source of truth; persistence is optional. */ }
    } catch (e) { if (active.current) setError(e instanceof Error && e.message.startsWith('ROUND_') ? roundMessage(e.message) : e instanceof Error ? e.message : 'เพิ่มเข้ารอบไม่สำเร็จ') }
    finally { busy.current = false }
  }
  async function removeLine(id: string) {
    if (!canUse || busy.current) return
    busy.current = true
    try { await rounds.save((rounds.draft?.lines ?? []).filter(line => line.id !== id)); if (editing === id) reset() }
    catch (e) { setError(roundMessage(e instanceof Error ? e.message : '')) } finally { busy.current = false }
  }
  function editLine(line: CartLine) { setEditingRevision(rounds.draft?.revision ?? null); setProduct(line.product); setPrice((line.unitPriceMinor / 100).toFixed(2)); setQuantity(String(line.quantity)); setNote(line.note ?? ''); setEditing(line.id); setStage('quantity'); setMessage(''); setError('') }
  async function finish(e: FormEvent) {
    e.preventDefault(); if (!canUse || !rounds.draft || !checkoutConfirmed || busy.current) return
    busy.current = true; setError('')
    try {
      const checkedOutAt = new Date(date).toISOString()
      const receipt = { id: rounds.draft.id, total: cartTotal(rounds.draft.lines), store: store.trim(), date: checkedOutAt }
      await rounds.save(rounds.draft.lines, { checkedOutAt, storeName: store, paymentMethod: method, note: roundNote })
      if (!active.current) return
      reset(); setCheckout(false); setConfirmationRevision(null); setStore(''); setRoundNote(''); setDate(localDateTime()); setMessage(''); setCompleted(receipt); setCartVisible(false)
    } catch (e) { setError(roundMessage(e instanceof RangeError ? 'INVALID_ROUND' : e instanceof Error ? e.message : 'INVALID_ROUND')) }
    finally { busy.current = false }
  }
  const lines = rounds.draft?.lines ?? []
  const total = cartTotal(lines)
  const showCart = stage === 'scan' && cartVisible && lines.length > 0
  const synced = completed ? rounds.closed.some(round => round.id === completed.id && round.status === 'synced') : false
  const lineAmount = Number(price) * 100 * Number(quantity)
  function back() { reset(); setCheckout(false); setMessage(''); setCartVisible(lines.length > 0) }
  function newRound() { reset(); setCompleted(null); setCartVisible(false); setMessage('') }
  function image() { setUpc(''); setStage('image'); setMessage(''); setCompleted(null) }
  const pageTitle = completed ? (synced ? 'บันทึกรอบแล้ว' : 'เก็บรอบบนเครื่องแล้ว') : checkout ? 'จบรอบนี้' : stage === 'add' ? 'เพิ่มสินค้า' : stage === 'image' ? 'เพิ่มจากรูป' : stage === 'quantity' ? (editing ? 'แก้ไขรายการ' : 'เพิ่มเข้ารอบ') : stage === 'manual' ? 'พิมพ์บาร์โค้ด' : showCart ? 'รอบนี้' : 'ซื้อสินค้า'
  return <section className={`shopping-journey mobile-page${stage !== 'scan' || checkout || completed ? ' focused-page' : ''}`} aria-labelledby="shopping-title">
    {!completed ? <PageHeader title={pageTitle} id="shopping-title" headingRef={title} onBack={checkout || stage !== 'scan' ? back : undefined} onAccount={stage === 'scan' && !checkout ? onAccount : undefined} /> : null}
    <div className={`page-content${stage === 'scan' && !checkout && !completed && !showCart ? ' scan-home' : ''}${completed ? ' completion-page' : ''}`}>
      {rounds.loading ? <p role="status">กำลังเปิดรอบที่เก็บไว้…</p> : null}
      {message && stage !== 'quantity' && stage !== 'add' ? <p role="status" className="inline-message">{message}</p> : null}
      {error || rounds.error ? <p role="alert" className="error-message">{error || rounds.error}</p> : null}
      {rounds.error ? <button className="secondary-button" onClick={() => void rounds.refresh()}>ลองเปิดข้อมูลอีกครั้ง</button> : null}

      {completed ? <>
        <div className="completion-summary">
          <span className={`completion-icon${synced ? '' : ' pending'}`}><Icon name={synced ? 'check' : 'offline'} /></span>
          <h1 id="shopping-title" ref={title} tabIndex={-1}>{pageTitle}</h1><p className="amount">{formatMoney(completed.total)}</p>
          <p className="muted">{completed.store || 'ไม่ระบุร้าน'} · {new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(completed.date))}</p>
          <span className={`status-chip${synced ? '' : ' pending'}`}><Icon name={synced ? 'checkSmall' : 'clock'} />{synced ? 'ซิงก์แล้ว' : rounds.syncing ? 'กำลังซิงก์…' : 'รอซิงก์'}</span>
          {!synced ? <p className="pending-caption">อย่าล้างข้อมูลก่อนซิงก์</p> : null}
        </div>
        <div className="page-actions">
          {!synced ? <button className="primary-button" disabled={!online || rounds.syncing} onClick={() => void rounds.sync()}><Icon name="offlineWhite" />{rounds.syncing ? 'กำลังซิงก์…' : 'ซิงก์อีกครั้ง'}</button> : null}
          <button className={synced ? 'primary-button' : 'secondary-button'} onClick={newRound}><Icon name={synced ? 'scanWhite' : 'scan'} />เริ่มรอบใหม่</button>
          {onReport ? <button className="secondary-button" onClick={() => onReport(completed.id)}>ดูสรุปรอบนี้</button> : null}
        </div>
      </> : null}

      {!completed && !checkout && stage === 'scan' && !showCart ? <>
        {lines.length ? <button className="saved-round" onClick={() => { setCartVisible(true); setMessage('') }}><Icon name="basket" /><span><strong>ต่อรอบที่ค้างไว้</strong><small>{lines.length} รายการ · {formatMoney(total)}</small></span></button> : null}
        <div className="scan-invitation"><span className="scan-mark"><Icon name="scanHero" /></span><h2>{lines.length ? 'สแกนสินค้าชิ้นต่อไป' : 'สแกนชิ้นแรกได้เลย'}</h2></div>
        <div className="page-actions home-actions">
          <BarcodeScanner disabled={!canUse} presentation="journey" roundCount={lines.length} onManual={() => { setStage('manual'); setMessage('') }} onDetected={code => { void lookup(code) }} />
          <div className="alternative-actions"><button className="secondary-button" disabled={!canUse} onClick={() => { setStage('manual'); setMessage('') }}><Icon name="barcode" />พิมพ์รหัส</button><button className="secondary-button" disabled={!canUse || !online} onClick={image}><Icon name="image" />เพิ่มจากรูป</button></div>
        </div>
      </> : null}

      {!completed && !checkout && stage === 'manual' ? <form className="focused-form" onSubmit={e => { e.preventDefault(); void lookup(upc) }}>
        <p className="muted">ใช้ตัวเลขใต้บาร์โค้ด</p><label htmlFor={`${id}-upc`}>UPC / EAN<input id={`${id}-upc`} value={upc} onChange={e => setUpc(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={14} disabled={!canUse} required /></label>
        <div className="page-actions"><button className="primary-button" disabled={!canUse}><Icon name="searchWhite" />{working ? 'กำลังค้นหา…' : 'ค้นหา'}</button></div>
      </form> : null}

      {!completed && !checkout && stage === 'add' ? <form className="focused-form" onSubmit={e => void addProduct(e)}>
        <span className="status-chip pending"><Icon name="boxWarning" />ยังไม่มีสินค้านี้</span><p className="muted barcode-value">{upc}</p>
        {message ? <p role="status" className="pending-caption">{message}</p> : null}
        <label>ชื่อสินค้า<input value={name} onChange={e => setName(e.target.value)} maxLength={200} required disabled={!canUse || !online} placeholder="ชื่อสินค้า" /></label>
        <button type="button" className="secondary-button" disabled={!canUse || !online} onClick={() => { setStage('image'); setMessage('') }}><Icon name="image" />เพิ่มข้อมูลจากรูป</button>
        <details className="disclosure"><summary>รายละเอียดเพิ่มเติม<Icon name="down" /></summary><div><label>แบรนด์<input value={brand} onChange={e => setBrand(e.target.value)} maxLength={100} disabled={!canUse || !online} /></label><label>ขนาด / บรรจุ<input value={packageSize} onChange={e => setPackageSize(e.target.value)} maxLength={100} placeholder="เช่น 24.6 g × 12" disabled={!canUse || !online} /></label></div></details>
        <div className="page-actions"><button className="primary-button" disabled={!canUse || !online || !name.trim()}>{working ? 'กำลังบันทึก…' : 'บันทึกและใส่ราคา'}</button></div>
      </form> : null}

      {!completed && !checkout && stage === 'image' ? <ImageImport accountId={accountId} apiOrigin={apiOrigin} canImport={canUse && online} compact scannedUpc={upc || null} onProduct={value => {
        void cacheProduct(value, accountId).catch(() => {})
        if (upc && value.upc !== upc) { setStage('add'); setMessage('บาร์โค้ดไม่ตรงกับที่สแกน โปรดตรวจข้อมูลสินค้า'); return }
        select(value)
      }} /> : null}

      {!completed && !checkout && stage === 'quantity' && product ? <form className="focused-form" onSubmit={e => void addLine(e)}>
        <div className="matched-product"><ProductThumb imageUrl={product.imageUrl} large /><div><h2>{product.name}</h2>{product.packageSize ? <p className="muted">{product.packageSize}</p> : null}</div></div>
        <div className="quantity-row"><label htmlFor={`${id}-quantity`}>จำนวน</label><div className="quantity-stepper"><button type="button" aria-label="ลดจำนวน" disabled={!canUse || Number(quantity) <= 1} onClick={() => setQuantity(String(Math.max(1, (Number(quantity) || 1) - 1)))}><Icon name="minus" /></button><input id={`${id}-quantity`} inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} required disabled={!canUse} /><button type="button" aria-label="เพิ่มจำนวน" disabled={!canUse || Number(quantity) >= 10000} onClick={() => setQuantity(String(Math.min(10000, (Number(quantity) || 0) + 1)))}><Icon name="plus" /></button></div></div>
        <label>ราคาต่อหน่วย (บาท)<input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} required disabled={!canUse} placeholder="0.00" /></label>
        <details className="disclosure"><summary>รายละเอียดเพิ่มเติม<Icon name="down" /></summary><div><p className="muted">UPC {product.upc ?? 'ไม่มีบาร์โค้ด'} · จำนวน 1 หมายถึง 1 หน่วยขาย / แพ็ก</p><label>หมายเหตุสินค้า<input value={note} onChange={e => setNote(e.target.value)} maxLength={500} disabled={!canUse} /></label></div></details>
        <div className="page-actions"><button className="primary-button" disabled={!canUse}>{editing ? 'บันทึกแก้ไข' : 'เพิ่มเข้ารอบ'}{Number.isFinite(lineAmount) && lineAmount > 0 ? ` · ${formatMoney(Math.round(lineAmount))}` : ''}</button>{editing ? <button type="button" className="text-danger" disabled={!canUse} onClick={() => void removeLine(editing)}>เอาออกจากรอบ</button> : null}</div>
      </form> : null}

      {!completed && !checkout && showCart ? <>
        <div className="cart-heading"><span className="muted">{lines.length} รายการ · {lines.reduce((sum, line) => sum + line.quantity, 0)} ชิ้น</span><BarcodeScanner disabled={!canUse} presentation="journey" compact roundCount={lines.length} onManual={() => setStage('manual')} onDetected={code => { void lookup(code) }} /></div>
        <div className="cart-lines">{lines.map(line => <button className="product-row" key={line.id} disabled={!canUse} onClick={() => editLine(line)} aria-label={`แก้ไข ${line.product.name}`}><ProductThumb imageUrl={line.product.imageUrl} /><span className="row-description"><strong>{line.product.name}</strong><small>{line.product.packageSize ?? line.product.brand ?? ''}</small></span><span className="row-amount"><strong>{formatMoney(Math.round(line.quantity * line.unitPriceMinor))}</strong><small>{line.quantity} × {formatMoney(line.unitPriceMinor)}</small></span></button>)}</div>
        <div className="page-actions"><div className="summary-row"><span>รวมรอบนี้</span><strong>{formatMoney(total)}</strong></div><button className="primary-button checkout-button" disabled={!canUse} onClick={() => { setDate(localDateTime()); setCheckout(true); setConfirmationRevision(rounds.draft?.revision ?? null); setMessage(''); setError('') }}>ชำระเงิน · {formatMoney(total)}</button></div>
      </> : null}

      {!completed && checkout ? <form className="focused-form checkout-form" onSubmit={e => void finish(e)}>
        <div className="round-amount"><span className="muted">ยอดที่ชำระ</span><p className="amount">{formatMoney(total)}</p></div><hr />
        <label>ร้านค้า<input value={store} onChange={e => setStore(e.target.value)} maxLength={80} placeholder="เช่น Makro Pro / Big C" disabled={!canUse} /></label>
        <div className="summary-row small"><span>วันและเวลา</span><span>{new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date || Date.now()))}</span></div>
        <fieldset className="payment-options" disabled={!canUse}><legend>ชำระด้วย</legend><div>{(['cash', 'card', 'transfer'] as const).map(value => <button type="button" key={value} aria-pressed={method === value} className={method === value ? 'payment-selected' : ''} onClick={() => setMethod(value)}><Icon name={value === 'cash' ? 'cash' : value === 'card' ? 'card' : 'transfer'} />{{ cash: 'เงินสด', card: 'บัตร', transfer: 'โอน' }[value]}</button>)}</div></fieldset>
        <details className="disclosure"><summary>{lines.length} รายการ · {lines.reduce((sum, line) => sum + line.quantity, 0)} ชิ้น<Icon name="down" /></summary><div>{lines.map(line => <div className="summary-row small" key={line.id}><span>{line.product.name} × {line.quantity}</span><strong>{formatMoney(Math.round(line.unitPriceMinor * line.quantity))}</strong></div>)}</div></details>
        <details className="disclosure"><summary>รายละเอียดรอบ<Icon name="down" /></summary><div><label>วันที่ชำระ<input type="datetime-local" step="1" value={date} onChange={e => setDate(e.target.value)} required disabled={!canUse} /></label><label>หมายเหตุรอบ<input value={roundNote} onChange={e => setRoundNote(e.target.value)} maxLength={500} disabled={!canUse} /></label><label>วิธีชำระอื่น<select value={method} onChange={e => setMethod(e.target.value as CheckoutFields['paymentMethod'])} disabled={!canUse}><option value="cash">เงินสด</option><option value="card">บัตร</option><option value="transfer">โอนเงิน</option><option value="other">อื่น ๆ</option></select></label></div></details>
        {!checkoutConfirmed ? <div className="pending-change" role="alert"><p>รอบนี้เปลี่ยนจากอีกแท็บ โปรดตรวจยอดใหม่</p><button type="button" className="secondary-button" disabled={!canUse || !lines.length} onClick={() => setConfirmationRevision(rounds.draft?.revision ?? null)}>ตรวจยอดใหม่</button></div> : null}
        <div className="page-actions"><p className="action-caption">บันทึกยอดเท่านั้น ไม่ตัดเงินจริง</p><button className="primary-button" disabled={!canUse || !checkoutConfirmed || !lines.length}>ยืนยันชำระแล้ว</button></div>
      </form> : null}
    </div>
  </section>
}

import { useEffect, useState, type FormEvent } from 'react'
import {
  cacheProduct,
  findCachedProduct,
  getPendingOperationCount,
  queuePurchase,
  requestPersistentStorage,
  syncPendingOperations,
  type CachedProduct,
} from './offline'

type Account = { id: string; displayName: string | null; primaryEmail: string | null }
type AuthResponse = { data: { authenticated: boolean; account: Account | null } }
type Product = CachedProduct
type ProductResponse = { data: Product }
type ApiError = { error?: { message?: string; manualEntry?: boolean } }
type AppView = 'purchase' | 'history' | 'products'

type PurchaseHistoryItem = {
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

type MyProductItem = {
  id: string
  upc: string
  name: string
  brand: string | null
  imageUrl: string | null
  purchaseCount: number
  totalSpentMinor: number
  lastPurchasedAt: string
}

type PageResponse<T> = { data: { items: T[]; nextCursor: string | null } }

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:8787'

function App() {
  const [account, setAccount] = useState<Account | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [activeView, setActiveView] = useState<AppView>('purchase')
  const [upc, setUpc] = useState('')
  const [product, setProduct] = useState<Product | null>(null)
  const [lookupMessage, setLookupMessage] = useState<string | null>(null)
  const [isLookingUp, setIsLookingUp] = useState(false)
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [manualName, setManualName] = useState('')
  const [manualBrand, setManualBrand] = useState('')
  const [isSavingProduct, setIsSavingProduct] = useState(false)
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [storeName, setStoreName] = useState('')
  const [purchaseMessage, setPurchaseMessage] = useState<string | null>(null)
  const [isSavingPurchase, setIsSavingPurchase] = useState(false)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [historyItems, setHistoryItems] = useState<PurchaseHistoryItem[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const [historyQuery, setHistoryQuery] = useState('')
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [historyMessage, setHistoryMessage] = useState<string | null>(null)
  const [myProducts, setMyProducts] = useState<MyProductItem[]>([])
  const [productsCursor, setProductsCursor] = useState<string | null>(null)
  const [productsSearch, setProductsSearch] = useState('')
  const [productsQuery, setProductsQuery] = useState('')
  const [isLoadingProducts, setIsLoadingProducts] = useState(false)
  const [productsMessage, setProductsMessage] = useState<string | null>(null)
  const [authMessage, setAuthMessage] = useState<string | null>(null)

  useEffect(() => {
    void loadAccount()
    void refreshPendingSyncCount()
    if (new URLSearchParams(window.location.search).get('auth') === 'setup_required') {
      setAuthMessage('Google Login สำหรับ staging ยังอยู่ระหว่างตั้งค่า')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true)
      void syncQueue()
    }
    function handleOffline() {
      setIsOnline(false)
      setSyncMessage('ขณะนี้ออฟไลน์ รายการซื้อใหม่จะรอซิงก์เมื่อเชื่อมต่ออีกครั้ง')
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [account])

  useEffect(() => {
    if (account && navigator.onLine) void syncQueue()
  }, [account])

  useEffect(() => {
    if (!account || !isOnline) return
    if (activeView === 'history') void loadHistory(true)
    if (activeView === 'products') void loadMyProducts(true)
  }, [activeView, account, isOnline])

  async function loadAccount() {
    try {
      const response = await fetch(`${apiOrigin}/auth/me`, { credentials: 'include' })
      if (!response.ok) return
      const payload = (await response.json()) as AuthResponse
      setAccount(payload.data.authenticated ? payload.data.account : null)
    } finally {
      setIsLoading(false)
    }
  }

  async function refreshPendingSyncCount() {
    try {
      setPendingSyncCount(await getPendingOperationCount())
    } catch {
      setSyncMessage('ไม่สามารถเปิดพื้นที่เก็บข้อมูลในเครื่องได้')
    }
  }

  async function syncQueue() {
    if (!account || !navigator.onLine || isSyncing) return
    setIsSyncing(true)
    try {
      const summary = await syncPendingOperations(apiOrigin)
      setPendingSyncCount(summary.pending)
      if (summary.synced > 0) setSyncMessage(`ซิงก์รายการซื้อแล้ว ${summary.synced} รายการ`)
      else if (summary.validationErrors > 0) setSyncMessage('มีรายการที่ตรวจสอบไม่ผ่าน กรุณาตรวจสอบข้อมูลอีกครั้ง')
      else if (summary.retryableErrors > 0) setSyncMessage('ยังซิงก์ไม่สำเร็จ ระบบจะลองใหม่เมื่อเชื่อมต่อ')
    } catch (error) {
      setSyncMessage(error instanceof Error && error.message === 'SYNC_REQUEST_FAILED:401'
        ? 'กรุณาเข้าสู่ระบบใหม่ก่อนซิงก์รายการที่ค้างอยู่'
        : 'ยังซิงก์ไม่สำเร็จ ระบบจะลองใหม่เมื่อเชื่อมต่อ')
      await refreshPendingSyncCount()
    } finally {
      setIsSyncing(false)
    }
  }

  async function loadHistory(reset: boolean, query = historyQuery) {
    if (!account || !navigator.onLine || isLoadingHistory || (!reset && !historyCursor)) return
    setIsLoadingHistory(true)
    setHistoryMessage(null)
    try {
      const page = await fetchPage<PurchaseHistoryItem>('/api/v1/purchases', query, reset ? null : historyCursor)
      setHistoryItems((items) => reset ? page.items : [...items, ...page.items])
      setHistoryCursor(page.nextCursor)
    } catch {
      setHistoryMessage('ยังโหลดประวัติรายการซื้อไม่สำเร็จ')
    } finally {
      setIsLoadingHistory(false)
    }
  }

  async function loadMyProducts(reset: boolean, query = productsQuery) {
    if (!account || !navigator.onLine || isLoadingProducts || (!reset && !productsCursor)) return
    setIsLoadingProducts(true)
    setProductsMessage(null)
    try {
      const page = await fetchPage<MyProductItem>('/api/v1/products/mine', query, reset ? null : productsCursor)
      setMyProducts((items) => reset ? page.items : [...items, ...page.items])
      setProductsCursor(page.nextCursor)
    } catch {
      setProductsMessage('ยังโหลดคลังสินค้าไม่สำเร็จ')
    } finally {
      setIsLoadingProducts(false)
    }
  }

  async function fetchPage<T>(path: string, query: string, cursor: string | null): Promise<{ items: T[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ limit: '20' })
    if (query.trim()) params.set('q', query.trim())
    if (cursor) params.set('cursor', cursor)
    const response = await fetch(`${apiOrigin}${path}?${params.toString()}`, { credentials: 'include' })
    if (!response.ok) throw new Error(`PAGE_REQUEST_FAILED:${response.status}`)
    return (await response.json() as PageResponse<T>).data
  }

  function signInWithGoogle() {
    const returnTo = encodeURIComponent(window.location.href)
    window.location.assign(`${apiOrigin}/auth/google/start?return_to=${returnTo}`)
  }

  async function signOut() {
    setIsSigningOut(true)
    try {
      await fetch(`${apiOrigin}/auth/logout`, { method: 'POST', credentials: 'include' })
      setAccount(null)
      setHistoryItems([])
      setMyProducts([])
    } finally {
      setIsSigningOut(false)
    }
  }

  async function lookupProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedUpc = upc.replace(/\D/g, '')
    setUpc(normalizedUpc)
    setProduct(null)
    setPurchaseMessage(null)
    setShowManualEntry(false)
    setLookupMessage(null)
    setIsLookingUp(true)
    try {
      if (!navigator.onLine) {
        const cachedProduct = await findCachedProduct(normalizedUpc)
        if (!cachedProduct) {
          setLookupMessage('ออฟไลน์และยังไม่มีสินค้านี้ในข้อมูลที่เก็บไว้')
          return
        }
        setProduct(cachedProduct)
        setPrice(cachedProduct.sourcePriceMinor ? (cachedProduct.sourcePriceMinor / 100).toFixed(2) : '')
        setLookupMessage('พบสินค้าในข้อมูลที่เก็บไว้บนเครื่อง')
        return
      }
      const response = await fetch(`${apiOrigin}/api/v1/products/upc/${encodeURIComponent(normalizedUpc)}`, { credentials: 'include' })
      const payload = (await response.json()) as ProductResponse & ApiError
      if (!response.ok) {
        setLookupMessage(payload.error?.message ?? 'ค้นหาสินค้าไม่สำเร็จ')
        setShowManualEntry(Boolean(payload.error?.manualEntry))
        return
      }
      setProduct(payload.data)
      setPrice(payload.data.sourcePriceMinor ? (payload.data.sourcePriceMinor / 100).toFixed(2) : '')
      await cacheProduct(payload.data)
      setLookupMessage(payload.data.source === 'bigc' ? 'นำเข้าสินค้าจาก Big C และบันทึกลงฐานข้อมูลแล้ว' : 'พบสินค้าในฐานข้อมูล SmartCart')
    } catch {
      setLookupMessage('เชื่อมต่อ API ไม่สำเร็จ กรุณาลองใหม่')
    } finally {
      setIsLookingUp(false)
    }
  }

  async function saveManualProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!account) {
      setLookupMessage('กรุณาเข้าสู่ระบบด้วย Google ก่อนเพิ่มสินค้าเอง')
      return
    }
    if (!navigator.onLine) {
      setLookupMessage('การเพิ่มสินค้าใหม่ต้องทำขณะออนไลน์')
      return
    }
    setIsSavingProduct(true)
    try {
      const response = await fetch(`${apiOrigin}/api/v1/products`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upc, name: manualName, brand: manualBrand || null }),
      })
      const payload = (await response.json()) as ProductResponse & ApiError
      if (!response.ok) {
        setLookupMessage(payload.error?.message ?? 'เพิ่มสินค้าไม่สำเร็จ')
        return
      }
      setProduct(payload.data)
      await cacheProduct(payload.data)
      setShowManualEntry(false)
      setLookupMessage('เพิ่มสินค้าเองลงฐานข้อมูล SmartCart แล้ว')
    } catch {
      setLookupMessage('เชื่อมต่อ API ไม่สำเร็จ กรุณาลองใหม่')
    } finally {
      setIsSavingProduct(false)
    }
  }

  async function savePurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!product) return
    if (!account) {
      setPurchaseMessage('กรุณาเข้าสู่ระบบด้วย Google ก่อนบันทึกรายการซื้อ')
      return
    }
    const unitPriceMinor = Math.round(Number(price) * 100)
    const parsedQuantity = Number(quantity)
    if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor <= 0 || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setPurchaseMessage('กรุณาระบุราคาและจำนวนให้ถูกต้อง')
      return
    }
    setIsSavingPurchase(true)
    setPurchaseMessage(null)
    try {
      await queuePurchase({ productId: product.id, unitPriceMinor, quantity: parsedQuantity, purchasedAt: new Date().toISOString(), storeName: storeName.trim() || null, note: null })
      const persistenceGranted = await requestPersistentStorage()
      await refreshPendingSyncCount()
      if (!navigator.onLine) setPurchaseMessage('บันทึกรายการไว้บนเครื่องแล้ว จะซิงก์เมื่อกลับมาออนไลน์')
      else {
        await syncQueue()
        setPurchaseMessage('บันทึกรายการซื้อแล้ว และกำลังซิงก์เข้าระบบ')
      }
      if (persistenceGranted === false) setSyncMessage('อุปกรณ์ไม่ได้อนุญาต persistent storage: อย่าลบแอปหรือข้อมูลเบราว์เซอร์ก่อนรายการจะซิงก์')
    } catch {
      setPurchaseMessage('ไม่สามารถบันทึกรายการลงบนเครื่องได้ กรุณาลองใหม่')
    } finally {
      setIsSavingPurchase(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="account-card" aria-labelledby="app-title">
        <div>
          <p className="eyebrow">SmartCart PWA</p>
          <h1 id="app-title">บันทึกรายการซื้อได้ทุกที่</h1>
          <p>ค้นหาด้วย UPC ก่อน แล้ว SmartCart จะใช้ข้อมูลในระบบ หรือขอข้อมูลจาก Big C เมื่อพบรหัสใหม่</p>
        </div>
        <div className="sync-banner" aria-live="polite">
          <span className={isOnline ? 'online-indicator' : 'offline-indicator'}>{isOnline ? 'ออนไลน์' : 'ออฟไลน์'}</span>
          <span>{pendingSyncCount > 0 ? `รอซิงก์ ${pendingSyncCount} รายการ` : 'ไม่มีรายการรอซิงก์'}</span>
          <button className="secondary-button" onClick={() => void syncQueue()} disabled={!account || !isOnline || isSyncing || pendingSyncCount === 0}>{isSyncing ? 'กำลังซิงก์…' : 'ซิงก์ตอนนี้'}</button>
          {syncMessage ? <small>{syncMessage}</small> : null}
        </div>
        <div className="account-panel" aria-live="polite">
          {isLoading ? <p>กำลังตรวจสอบการเข้าสู่ระบบ…</p> : account ? <>
            <p className="account-label">เข้าสู่ระบบแล้ว</p><strong>{account.displayName ?? 'SmartCart user'}</strong>
            {account.primaryEmail ? <span>{account.primaryEmail}</span> : null}
            <button className="secondary-button" onClick={() => void signOut()} disabled={isSigningOut}>{isSigningOut ? 'กำลังออกจากระบบ…' : 'ออกจากระบบ'}</button>
          </> : <><p className="account-label">ยังไม่ได้เข้าสู่ระบบ</p><button className="google-button" onClick={signInWithGoogle}><span aria-hidden="true">G</span>เข้าสู่ระบบด้วย Google</button>{authMessage ? <small>{authMessage}</small> : null}</>}
        </div>
        <nav className="view-tabs" aria-label="SmartCart sections">
          <button className={activeView === 'purchase' ? 'tab-active' : 'secondary-button'} onClick={() => setActiveView('purchase')}>Add Purchase</button>
          <button className={activeView === 'history' ? 'tab-active' : 'secondary-button'} onClick={() => setActiveView('history')}>ประวัติ</button>
          <button className={activeView === 'products' ? 'tab-active' : 'secondary-button'} onClick={() => setActiveView('products')}>สินค้าของฉัน</button>
        </nav>

        {activeView === 'purchase' ? <PurchaseView
          upc={upc} setUpc={setUpc} product={product} lookupMessage={lookupMessage} isLookingUp={isLookingUp}
          showManualEntry={showManualEntry} manualName={manualName} setManualName={setManualName} manualBrand={manualBrand} setManualBrand={setManualBrand}
          isSavingProduct={isSavingProduct} lookupProduct={lookupProduct} saveManualProduct={saveManualProduct}
          quantity={quantity} setQuantity={setQuantity} price={price} setPrice={setPrice} storeName={storeName} setStoreName={setStoreName}
          isSavingPurchase={isSavingPurchase} purchaseMessage={purchaseMessage} savePurchase={savePurchase}
        /> : null}

        {activeView === 'history' ? <section className="content-panel" aria-labelledby="history-title">
          <h2 id="history-title">ประวัติรายการซื้อ</h2>
          <SearchForm value={historySearch} setValue={setHistorySearch} onSubmit={() => { setHistoryQuery(historySearch); void loadHistory(true, historySearch) }} placeholder="ค้นหาสินค้า, UPC หรือร้านค้า" />
          {!account ? <p className="status-message">เข้าสู่ระบบเพื่อดูประวัติของคุณ</p> : !isOnline ? <p className="status-message">เชื่อมต่ออินเทอร์เน็ตเพื่อโหลดประวัติจาก D1</p> : null}
          {historyMessage ? <p className="status-message">{historyMessage}</p> : null}
          <div className="history-list">{historyItems.map((item) => <HistoryCard key={item.id} item={item} />)}</div>
          {account && isOnline && !isLoadingHistory && historyItems.length === 0 ? <p className="status-message">ยังไม่มีรายการซื้อที่ตรงกับการค้นหา</p> : null}
          {historyCursor ? <button className="secondary-button load-more" onClick={() => void loadHistory(false)} disabled={isLoadingHistory}>{isLoadingHistory ? 'กำลังโหลด…' : 'ดูรายการเพิ่มเติม'}</button> : null}
          {isLoadingHistory && historyItems.length === 0 ? <p className="status-message">กำลังโหลดประวัติ…</p> : null}
        </section> : null}

        {activeView === 'products' ? <section className="content-panel" aria-labelledby="products-title">
          <h2 id="products-title">สินค้าของฉัน</h2>
          <p className="status-message">สินค้าที่คุณเคยบันทึกรายการซื้อ พร้อมยอดใช้จ่ายสะสม</p>
          <SearchForm value={productsSearch} setValue={setProductsSearch} onSubmit={() => { setProductsQuery(productsSearch); void loadMyProducts(true, productsSearch) }} placeholder="ค้นหาชื่อสินค้า, UPC หรือแบรนด์" />
          {!account ? <p className="status-message">เข้าสู่ระบบเพื่อดูคลังสินค้าของคุณ</p> : !isOnline ? <p className="status-message">เชื่อมต่ออินเทอร์เน็ตเพื่อโหลดคลังสินค้าจาก D1</p> : null}
          {productsMessage ? <p className="status-message">{productsMessage}</p> : null}
          <div className="product-library">{myProducts.map((item) => <MyProductCard key={item.id} item={item} />)}</div>
          {account && isOnline && !isLoadingProducts && myProducts.length === 0 ? <p className="status-message">ยังไม่มีสินค้าที่เคยซื้อ</p> : null}
          {productsCursor ? <button className="secondary-button load-more" onClick={() => void loadMyProducts(false)} disabled={isLoadingProducts}>{isLoadingProducts ? 'กำลังโหลด…' : 'ดูสินค้าเพิ่มเติม'}</button> : null}
          {isLoadingProducts && myProducts.length === 0 ? <p className="status-message">กำลังโหลดสินค้า…</p> : null}
        </section> : null}
      </section>
    </main>
  )
}

type PurchaseViewProps = {
  upc: string; setUpc: (value: string) => void; product: Product | null; lookupMessage: string | null; isLookingUp: boolean
  showManualEntry: boolean; manualName: string; setManualName: (value: string) => void; manualBrand: string; setManualBrand: (value: string) => void
  isSavingProduct: boolean; lookupProduct: (event: FormEvent<HTMLFormElement>) => Promise<void>; saveManualProduct: (event: FormEvent<HTMLFormElement>) => Promise<void>
  quantity: string; setQuantity: (value: string) => void; price: string; setPrice: (value: string) => void; storeName: string; setStoreName: (value: string) => void
  isSavingPurchase: boolean; purchaseMessage: string | null; savePurchase: (event: FormEvent<HTMLFormElement>) => Promise<void>
}

function PurchaseView(props: PurchaseViewProps) {
  return <section className="lookup-panel" aria-labelledby="lookup-title">
    <h2 id="lookup-title">Add Purchase</h2>
    <form className="lookup-form" onSubmit={(event) => void props.lookupProduct(event)}>
      <label htmlFor="upc">UPC / Barcode</label><div className="input-row"><input id="upc" value={props.upc} onChange={(event) => props.setUpc(event.target.value)} inputMode="numeric" autoComplete="off" placeholder="เช่น 8851959129012" required /><button className="primary-button" disabled={props.isLookingUp}>{props.isLookingUp ? 'กำลังค้น…' : 'ค้นหา'}</button></div>
    </form>
    {props.lookupMessage ? <p className="status-message">{props.lookupMessage}</p> : null}
    {props.showManualEntry ? <form className="manual-form" onSubmit={(event) => void props.saveManualProduct(event)}><strong>เพิ่มสินค้าเอง</strong><label>ชื่อสินค้า<input value={props.manualName} onChange={(event) => props.setManualName(event.target.value)} maxLength={200} required /></label><label>แบรนด์ (ไม่บังคับ)<input value={props.manualBrand} onChange={(event) => props.setManualBrand(event.target.value)} maxLength={100} /></label><button className="secondary-button" disabled={props.isSavingProduct}>{props.isSavingProduct ? 'กำลังเพิ่ม…' : 'บันทึกสินค้าเอง'}</button></form> : null}
    {props.product ? <div className="product-result">{props.product.imageUrl ? <img src={props.product.imageUrl} alt="" /> : <div className="image-placeholder" aria-hidden="true">สินค้า</div>}<div><p className="source-badge">{props.product.source === 'bigc' ? 'Big C import' : 'SmartCart database'}</p><h3>{props.product.name}</h3><p>{[props.product.brand, props.product.packageSize, props.product.upc].filter(Boolean).join(' · ')}</p>{props.product.sourcePriceMinor ? <strong>{formatBaht(props.product.sourcePriceMinor)} ราคาอ้างอิง</strong> : null}</div></div> : null}
    {props.product ? <form className="purchase-form" onSubmit={(event) => void props.savePurchase(event)}><label>ราคาที่ซื้อจริง (บาท)<input value={props.price} onChange={(event) => props.setPrice(event.target.value)} inputMode="decimal" required /></label><label>จำนวน<input value={props.quantity} onChange={(event) => props.setQuantity(event.target.value)} inputMode="decimal" required /></label><label className="full-width">ร้านค้า (ไม่บังคับ)<input value={props.storeName} onChange={(event) => props.setStoreName(event.target.value)} maxLength={80} /></label><button className="primary-button full-width" disabled={props.isSavingPurchase}>{props.isSavingPurchase ? 'กำลังบันทึก…' : 'บันทึกรายการซื้อ'}</button>{props.purchaseMessage ? <p className="status-message full-width">{props.purchaseMessage}</p> : null}</form> : null}
  </section>
}

function SearchForm({ value, setValue, onSubmit, placeholder }: { value: string; setValue: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return <form className="search-form" onSubmit={(event) => { event.preventDefault(); onSubmit() }}><label htmlFor="history-search">ค้นหา</label><div className="input-row"><input id="history-search" value={value} onChange={(event) => setValue(event.target.value)} maxLength={80} placeholder={placeholder} /><button className="primary-button">ค้นหา</button></div></form>
}

function HistoryCard({ item }: { item: PurchaseHistoryItem }) {
  return <article className="history-card">
    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <div className="small-image-placeholder" aria-hidden="true">สินค้า</div>}
    <div><strong>{item.productName}</strong><p>{[item.productBrand, item.productUpc, item.storeName].filter(Boolean).join(' · ')}</p><small>{formatDate(item.purchasedAt)} · {item.quantity} ชิ้น × {formatBaht(item.unitPriceMinor)}</small></div>
    <strong className="history-total">{formatBaht(item.totalMinor)}</strong>
  </article>
}

function MyProductCard({ item }: { item: MyProductItem }) {
  return <article className="library-card">
    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <div className="small-image-placeholder" aria-hidden="true">สินค้า</div>}
    <div><strong>{item.name}</strong><p>{[item.brand, item.upc].filter(Boolean).join(' · ')}</p><small>ซื้อ {item.purchaseCount} ครั้ง · ล่าสุด {formatDate(item.lastPurchasedAt)}</small></div>
    <strong className="history-total">{formatBaht(item.totalSpentMinor)}</strong>
  </article>
}

function formatBaht(minor: number): string {
  return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' }).format(minor / 100)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default App


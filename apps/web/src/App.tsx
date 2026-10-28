import { useEffect, useRef, useState } from 'react'
import { apiFetch, browserSessionInfo, clearBrowserSession, finishGoogleLogin, isBrowserSessionChange, startGoogleLogin } from './auth-client'
import { ShoppingJourney } from './ShoppingJourney'
import { RoundReports } from './RoundReports'
import { useShoppingRounds } from './useShoppingRounds'
import { HomeSummary, ProductDetailView, PurchaseDetailView } from './AccountViews'
import { type ProductDetail } from './purchase-management'
import {
  getPendingOperationCount,
  syncPendingOperations,
  type CachedProduct,
} from './offline'

type Account = { id: string; displayName: string | null; primaryEmail: string | null }
type AuthResponse = { data: { authenticated: boolean; account: Account | null } }
type Product = CachedProduct
type AppView = 'home' | 'purchase' | 'history' | 'products'

type PurchaseHistoryItem = {
  id: string
  productId: string
  productName: string
  productSku: string
  productUpc: string | null
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
  sku: string
  upc: string | null
  name: string
  brand: string | null
  imageUrl: string | null
  purchaseCount: number
  totalSpentMinor: number
  lastPurchasedAt: string
}

type PageResponse<T> = { data: { items: T[]; nextCursor: string | null } }

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:8787'
const storageUpgradeMessage = 'มีแท็บ SmartCart อื่นขวางการอัปเดตพื้นที่เก็บข้อมูล กรุณาปิดแท็บ SmartCart อื่นทั้งหมด แล้วรีเฟรชหน้านี้ ไม่ต้องล้างข้อมูลเบราว์เซอร์'

function App() {
  const [account, setAccount] = useState<Account | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [activeView, setActiveView] = useState<AppView>('purchase')
  const [detail, setDetail] = useState<{ kind: 'purchase' | 'product'; id: string } | null>(null)
  const [detailStack, setDetailStack] = useState<Array<{ kind: 'purchase' | 'product'; id: string }>>([])
  const [detailsDirty, setDetailsDirty] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const [product, setProduct] = useState<Product | null>(null)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const rounds = useShoppingRounds(account?.id ?? null, apiOrigin, isOnline, () => setDataVersion(value => value + 1))
  const [pendingSyncCount, setPendingSyncCount] = useState<number | null>(null)
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
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [sessionInfo, setSessionInfo] = useState<ReturnType<typeof browserSessionInfo>>(null)
  const authSequence = useRef(0)

  useEffect(() => {
    void loadAccount()
    void refreshPendingSyncCount()
    return () => { authSequence.current += 1 }
  }, [])

  useEffect(() => {
    function changed(event: StorageEvent) {
      if (!isBrowserSessionChange(event, apiOrigin)) return
      // Revalidate before showing private data if another tab switches account or logs out.
      authSequence.current += 1
      setAccount(null); setSessionInfo(null); setHistoryItems([]); setMyProducts([])
      setDetail(null); setDetailStack([]); setDetailsDirty(false)
      setProduct(null)
      setIsLoading(true)
      void loadAccount()
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true)
      if (!account) { setIsLoading(true); void loadAccount() }
      else void syncQueue()
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
  }, [activeView, account, isOnline, dataVersion])

  async function loadAccount() {
    const sequence = ++authSequence.current
    try {
      const result = new URLSearchParams(window.location.search).get('auth')
      if (result) {
        setAuthMessage(result === 'setup_required' ? 'Google Login ยังอยู่ระหว่างตั้งค่า' : 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง')
        const url = new URL(window.location.href)
        url.searchParams.delete('auth')
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
      }
      await finishGoogleLogin(apiOrigin)
      const config = await apiFetch(apiOrigin, '/auth/config')
      if (sequence !== authSequence.current) return
      if (!config.ok) throw new Error('AUTH_CONFIG_FAILED')
      const settings = await config.json() as { data: { googleEnabled: boolean } }
      setGoogleEnabled(settings.data.googleEnabled)
      if (!settings.data.googleEnabled) setAuthMessage('Google Login ยังอยู่ระหว่างตั้งค่า')
      const response = await apiFetch(apiOrigin, '/auth/me')
      if (sequence !== authSequence.current) return
      if (!response.ok) throw new Error('AUTH_CHECK_FAILED')
      const payload = (await response.json()) as AuthResponse
      if (sequence !== authSequence.current) return
      setAccount(payload.data.authenticated ? payload.data.account : null)
      setSessionInfo(browserSessionInfo(apiOrigin))
      if (payload.data.authenticated) setAuthMessage(null)
    } catch {
      if (sequence !== authSequence.current) return
      const saved = browserSessionInfo(apiOrigin)
      setSessionInfo(saved)
      setAuthMessage(saved ? 'ยังตรวจสอบการเข้าสู่ระบบเดิมไม่ได้ ระบบยังเก็บเซสชันไว้ กรุณาเชื่อมต่อแล้วตรวจสอบอีกครั้ง ไม่จำเป็นต้องเริ่ม Google Login ใหม่ทันที' : 'ยังเชื่อมต่อการเข้าสู่ระบบไม่สำเร็จ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่')
    } finally {
      if (sequence === authSequence.current) setIsLoading(false)
    }
  }

  async function refreshPendingSyncCount() {
    try {
      setPendingSyncCount(await getPendingOperationCount())
    } catch (error) {
      setPendingSyncCount(null)
      setSyncMessage(error instanceof Error && error.message === 'INDEXEDDB_UPGRADE_BLOCKED'
        ? storageUpgradeMessage
        : 'ไม่สามารถเปิดพื้นที่เก็บข้อมูลในเครื่องได้')
    }
  }

  async function syncQueue() {
    if (!account || !navigator.onLine || isSyncing) return
    setIsSyncing(true)
    try {
      await rounds.sync()
      const summary = await syncPendingOperations(apiOrigin)
      setPendingSyncCount(summary.pending)
      if (summary.synced > 0) setDataVersion(value => value + 1)
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
    const authVersion = authSequence.current
    setIsLoadingHistory(true)
    setHistoryMessage(null)
    try {
      const page = await fetchPage<PurchaseHistoryItem>('/api/v1/purchases', query, reset ? null : historyCursor)
      if (authVersion !== authSequence.current) return
      setHistoryItems((items) => reset ? page.items : [...items, ...page.items])
      setHistoryCursor(page.nextCursor)
    } catch {
      if (authVersion === authSequence.current) setHistoryMessage('ยังโหลดประวัติรายการซื้อไม่สำเร็จ')
    } finally {
      setIsLoadingHistory(false)
    }
  }

  async function loadMyProducts(reset: boolean, query = productsQuery) {
    if (!account || !navigator.onLine || isLoadingProducts || (!reset && !productsCursor)) return
    const authVersion = authSequence.current
    setIsLoadingProducts(true)
    setProductsMessage(null)
    try {
      const page = await fetchPage<MyProductItem>('/api/v1/products/mine', query, reset ? null : productsCursor)
      if (authVersion !== authSequence.current) return
      setMyProducts((items) => reset ? page.items : [...items, ...page.items])
      setProductsCursor(page.nextCursor)
    } catch {
      if (authVersion === authSequence.current) setProductsMessage('ยังโหลดคลังสินค้าไม่สำเร็จ')
    } finally {
      setIsLoadingProducts(false)
    }
  }

  async function fetchPage<T>(path: string, query: string, cursor: string | null): Promise<{ items: T[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ limit: '20' })
    if (path === '/api/v1/purchases') params.set('legacyOnly', '1')
    if (query.trim()) params.set('q', query.trim())
    if (cursor) params.set('cursor', cursor)
    const response = await apiFetch(apiOrigin, `${path}?${params.toString()}`)
    if (!response.ok) throw new Error(`PAGE_REQUEST_FAILED:${response.status}`)
    return (await response.json() as PageResponse<T>).data
  }

  async function signInWithGoogle() {
    setIsSigningIn(true)
    setAuthMessage(null)
    try { await startGoogleLogin(apiOrigin) }
    catch {
      setAuthMessage('ไม่สามารถเริ่มเข้าสู่ระบบได้ กรุณาอนุญาตพื้นที่เก็บข้อมูลของเบราว์เซอร์แล้วลองใหม่')
      setIsSigningIn(false)
    }
  }

  async function signOut() {
    if (detailsDirty && !window.confirm('มีข้อมูลแก้ไขหรือคำขอที่รอยืนยัน ต้องการออกจากระบบหรือไม่? รายการที่ส่งแล้วจะเก็บรหัสไว้ให้ตรวจต่อเมื่อเข้าสู่ระบบบัญชีเดิม')) return
    setIsSigningOut(true)
    try {
      const response = await apiFetch(apiOrigin, '/auth/logout', { method: 'POST' })
      if (!response.ok) throw new Error('LOGOUT_FAILED')
      authSequence.current += 1
      clearBrowserSession(apiOrigin)
      setAccount(null)
      setSessionInfo(null)
      setDetail(null); setDetailStack([]); setDetailsDirty(false)
      setHistoryItems([])
      setMyProducts([])
      setAuthMessage(null)
      setProduct(null)
    } catch {
      setAuthMessage('ยังออกจากระบบไม่สำเร็จ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่')
    } finally {
      setIsSigningOut(false)
    }
  }

  function navigate(view: AppView) {
    if (detailsDirty && !window.confirm('มีข้อมูลแก้ไขที่ยังไม่บันทึกหรือคำขอที่รอยืนยัน ต้องการออกจากหน้านี้หรือไม่? คำขอที่ส่งแล้วสามารถกลับมาตรวจด้วยรหัสเดิมได้')) return
    setDetailsDirty(false); setDetail(null); setDetailStack([]); setActiveView(view)
  }
  function openDetail(kind: 'purchase' | 'product', id: string) {
    if (detailsDirty && !window.confirm('ต้องการออกจากรายการที่ยังแก้ไขหรือรอยืนยันอยู่หรือไม่?')) return
    setDetailStack(items => detail ? [...items, detail].slice(-20) : [])
    setDetailsDirty(false); setDetail({ kind, id })
  }
  function closeDetail() {
    if (detailsDirty && !window.confirm('ต้องการกลับโดยยังมีข้อมูลแก้ไขหรือรายการรอยืนยันหรือไม่?')) return
    setDetailsDirty(false)
    setDetail(detailStack.at(-1) ?? null); setDetailStack(items => items.slice(0, -1))
  }
  function buyAgain(item: ProductDetail) {
    setProduct({ id: item.id, sku: item.sku, upc: item.upc, name: item.name, brand: item.brand, packageSize: item.packageSize, imageUrl: item.imageUrl,
      source: 'smartcart', sourcePriceMinor: item.recentPurchases[0]?.unitPriceMinor ?? null, regularPriceMinor: null, fetchedAt: null })
    setDetail(null); setDetailStack([]); setDetailsDirty(false); setActiveView('purchase')
  }

  return (
    <main className="app-shell">
      <section className="account-card" aria-labelledby="app-title">
        <div>
          <p className="eyebrow">SmartCart PWA</p>
          <h1 id="app-title">สแกนสินค้า ซื้อเป็นรอบ</h1>
          <p>สแกน → ถ้าไม่พบให้เพิ่มสินค้า → ใส่จำนวนและราคา → เพิ่มเข้ารอบ → กดชำระเงินเพื่อบันทึกทั้งรอบ แล้วดูรายงานแยกแต่ละครั้ง</p>
        </div>
        <div className="sync-banner" aria-live="polite">
          <span className={isOnline ? 'online-indicator' : 'offline-indicator'}>{isOnline ? 'ออนไลน์' : 'ออฟไลน์'}</span>
          <span>{pendingSyncCount === null ? 'ยังตรวจสอบจำนวนรายการรอซิงก์ไม่ได้' : pendingSyncCount > 0 ? `รอซิงก์ ${pendingSyncCount} รายการ` : 'ไม่มีรายการรอซิงก์'}</span>
          {account ? <span>{rounds.pending.length ? `รอซิงก์รอบชำระ ${rounds.pending.length} รอบ` : 'ไม่มีรอบชำระรอซิงก์'}</span> : null}
          <button className="secondary-button" onClick={() => void syncQueue()} disabled={!account || !isOnline || isSyncing || rounds.syncing || (pendingSyncCount === 0 && rounds.pending.length === 0)}>{isSyncing || rounds.syncing ? 'กำลังซิงก์…' : 'ซิงก์ตอนนี้'}</button>
          {syncMessage ? <small>{syncMessage}</small> : null}
        </div>
        <div className="account-panel" aria-live="polite">
          {isLoading ? <p>กำลังตรวจสอบการเข้าสู่ระบบ…</p> : account ? <details className="account-details"><summary>เข้าสู่ระบบแล้ว · {account.displayName ?? 'SmartCart user'} · ข้อมูลบัญชี</summary><div>
            {account.primaryEmail ? <span>{account.primaryEmail}</span> : null}
            <small>{sessionInfo?.remembered ? `จดจำการเข้าสู่ระบบในเบราว์เซอร์นี้ถึง ${formatDate(sessionInfo.expiresAt)} หากใช้เครื่องร่วมกับผู้อื่น กรุณาออกจากระบบเมื่อเสร็จ` : 'เบราว์เซอร์ไม่อนุญาตให้จดจำถาวร จึงใช้การเข้าสู่ระบบได้เฉพาะแท็บนี้'}</small>
            <button className="secondary-button" onClick={() => void signOut()} disabled={isSigningOut}>{isSigningOut ? 'กำลังออกจากระบบ…' : 'ออกจากระบบ'}</button>
          </div></details> : <><p className="account-label">{sessionInfo ? 'รอตรวจสอบการเข้าสู่ระบบเดิม' : 'ยังไม่ได้เข้าสู่ระบบ'}</p><button className="google-button" onClick={() => void signInWithGoogle()} disabled={!googleEnabled || !isOnline || isSigningIn}><span aria-hidden="true">G</span>{isSigningIn ? 'กำลังเปิด Google…' : 'เข้าสู่ระบบด้วย Google'}</button><small>จดจำการเข้าสู่ระบบบนเบราว์เซอร์นี้อัตโนมัติ สูงสุด 30 วัน โดยไม่เก็บรหัสผ่าน Google</small></>}
          {authMessage ? <small role="status">{authMessage}</small> : null}
          {(!googleEnabled || (sessionInfo && !account)) && !isLoading && isOnline ? <button className="secondary-button" onClick={() => { setIsLoading(true); void loadAccount() }}>ตรวจสอบการเข้าสู่ระบบอีกครั้ง</button> : null}
        </div>
        <nav className="view-tabs" aria-label="SmartCart sections">
          <button className={activeView === 'home' ? 'tab-active' : 'secondary-button'} onClick={() => navigate('home')} disabled={rounds.busy}>ภาพรวม</button>
          <button className={activeView === 'purchase' ? 'tab-active' : 'secondary-button'} onClick={() => navigate('purchase')} disabled={rounds.busy}>สแกน / รอบนี้</button>
          <button className={activeView === 'history' ? 'tab-active' : 'secondary-button'} onClick={() => navigate('history')} disabled={rounds.busy}>รายงานรายรอบ</button>
          <button className={activeView === 'products' ? 'tab-active' : 'secondary-button'} onClick={() => navigate('products')} disabled={rounds.busy}>สินค้าของฉัน</button>
        </nav>

        {detail && account ? detail.kind === 'purchase' ? <PurchaseDetailView key={`${account.id}:purchase:${detail.id}`} apiOrigin={apiOrigin} accountId={account.id} id={detail.id} online={isOnline} onBack={closeDetail} onDirtyChange={setDetailsDirty} onChanged={() => setDataVersion(v => v + 1)} onProduct={id => openDetail('product', id)} />
          : <ProductDetailView key={`${account.id}:product:${detail.id}`} apiOrigin={apiOrigin} id={detail.id} online={isOnline} onBack={closeDetail} onPurchase={id => openDetail('purchase', id)} onBuy={buyAgain} /> : null}

        {activeView === 'home' && !detail ? <HomeSummary key={account?.id ?? 'signed-out'} apiOrigin={apiOrigin} accountId={account?.id ?? null} online={isOnline} version={dataVersion} pendingCount={pendingSyncCount} onAdd={() => navigate('purchase')} onHistory={() => navigate('history')} onPurchase={id => openDetail('purchase', id)} /> : null}

        <div hidden={activeView !== 'purchase' || Boolean(detail)}><ShoppingJourney key={account?.id ?? 'guest'} accountId={account?.id ?? null} apiOrigin={apiOrigin} online={isOnline} visible={activeView === 'purchase' && !detail} rounds={rounds} initialProduct={product} onConsumed={() => setProduct(null)} /></div>

        {activeView === 'history' && !detail ? <RoundReports key={account?.id ?? 'guest'} accountId={account?.id ?? null} apiOrigin={apiOrigin} online={isOnline} version={dataVersion} rounds={rounds} /> : null}

        {activeView === 'history' && !detail ? <section className="content-panel" aria-labelledby="history-title">
          <h2 id="history-title">รายการเดิมที่ยังไม่ผูกรอบ</h2>
          <p className="status-message">เก็บประวัติเดิมไว้แยกต่างหาก ไม่รวมเป็นรอบซื้อให้อัตโนมัติ</p>
          <SearchForm value={historySearch} setValue={setHistorySearch} onSubmit={() => { setHistoryQuery(historySearch); void loadHistory(true, historySearch) }} placeholder="ค้นหาสินค้า, SKU, UPC หรือร้านค้า" />
          {!account ? <p className="status-message">เข้าสู่ระบบเพื่อดูประวัติของคุณ</p> : !isOnline ? <p className="status-message">เชื่อมต่ออินเทอร์เน็ตเพื่อโหลดประวัติจาก D1</p> : null}
          {historyMessage ? <p className="status-message">{historyMessage}</p> : null}
          <div className="history-list">{historyItems.map((item) => <HistoryCard key={item.id} item={item} onOpen={() => openDetail('purchase', item.id)} />)}</div>
          {account && isOnline && !isLoadingHistory && historyItems.length === 0 ? <p className="status-message">ยังไม่มีรายการซื้อที่ตรงกับการค้นหา</p> : null}
          {historyCursor ? <button className="secondary-button load-more" onClick={() => void loadHistory(false)} disabled={isLoadingHistory}>{isLoadingHistory ? 'กำลังโหลด…' : 'ดูรายการเพิ่มเติม'}</button> : null}
          {isLoadingHistory && historyItems.length === 0 ? <p className="status-message">กำลังโหลดประวัติ…</p> : null}
        </section> : null}

        {activeView === 'products' && !detail ? <section className="content-panel" aria-labelledby="products-title">
          <h2 id="products-title">สินค้าของฉัน</h2>
          <p className="status-message">สินค้าที่คุณเคยบันทึกรายการซื้อ พร้อมยอดใช้จ่ายสะสม</p>
          <SearchForm value={productsSearch} setValue={setProductsSearch} onSubmit={() => { setProductsQuery(productsSearch); void loadMyProducts(true, productsSearch) }} placeholder="ค้นหาชื่อสินค้า, SKU, UPC หรือแบรนด์" />
          {!account ? <p className="status-message">เข้าสู่ระบบเพื่อดูคลังสินค้าของคุณ</p> : !isOnline ? <p className="status-message">เชื่อมต่ออินเทอร์เน็ตเพื่อโหลดคลังสินค้าจาก D1</p> : null}
          {productsMessage ? <p className="status-message">{productsMessage}</p> : null}
          <div className="product-library">{myProducts.map((item) => <MyProductCard key={item.id} item={item} onOpen={() => openDetail('product', item.id)} />)}</div>
          {account && isOnline && !isLoadingProducts && myProducts.length === 0 ? <p className="status-message">ยังไม่มีสินค้าที่เคยซื้อ</p> : null}
          {productsCursor ? <button className="secondary-button load-more" onClick={() => void loadMyProducts(false)} disabled={isLoadingProducts}>{isLoadingProducts ? 'กำลังโหลด…' : 'ดูสินค้าเพิ่มเติม'}</button> : null}
          {isLoadingProducts && myProducts.length === 0 ? <p className="status-message">กำลังโหลดสินค้า…</p> : null}
        </section> : null}
      </section>
    </main>
  )
}

function SearchForm({ value, setValue, onSubmit, placeholder }: { value: string; setValue: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return <form className="search-form" onSubmit={(event) => { event.preventDefault(); onSubmit() }}><label htmlFor="history-search">ค้นหา</label><div className="input-row"><input id="history-search" value={value} onChange={(event) => setValue(event.target.value)} maxLength={80} placeholder={placeholder} /><button className="primary-button">ค้นหา</button></div></form>
}

function HistoryCard({ item, onOpen }: { item: PurchaseHistoryItem; onOpen: () => void }) {
  return <article className="history-card">
    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <div className="small-image-placeholder" aria-hidden="true">สินค้า</div>}
    <div><strong>{item.productName}</strong><p>{[item.productBrand, `SKU: ${item.productSku ?? item.productId}`, item.productUpc ? `UPC: ${item.productUpc}` : null, item.storeName].filter(Boolean).join(' · ')}</p><small>{formatDate(item.purchasedAt)} · {item.quantity} ชิ้น × {formatBaht(item.unitPriceMinor)}</small></div>
    <strong className="history-total">{formatBaht(item.totalMinor)}</strong>
    <button type="button" className="secondary-button card-detail-link" onClick={onOpen} aria-label={`ดูรายละเอียดรายการซื้อ ${item.productName}`}>ดูรายละเอียด / แก้ไข</button>
  </article>
}

function MyProductCard({ item, onOpen }: { item: MyProductItem; onOpen: () => void }) {
  return <article className="library-card">
    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <div className="small-image-placeholder" aria-hidden="true">สินค้า</div>}
    <div><strong>{item.name}</strong><p>{[item.brand, `SKU: ${item.sku ?? item.id}`, item.upc ? `UPC: ${item.upc}` : null].filter(Boolean).join(' · ')}</p><small>ซื้อ {item.purchaseCount} ครั้ง · ล่าสุด {formatDate(item.lastPurchasedAt)}</small></div>
    <strong className="history-total">{formatBaht(item.totalSpentMinor)}</strong>
    <button type="button" className="secondary-button card-detail-link" onClick={onOpen} aria-label={`ดูรายละเอียดสินค้า ${item.name}`}>ดูรายละเอียดสินค้า</button>
  </article>
}

function formatBaht(minor: number): string {
  return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' }).format(minor / 100)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default App

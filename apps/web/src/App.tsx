import { useEffect, useRef, useState } from 'react'
import { apiFetch, browserSessionInfo, clearBrowserSession, finishGoogleLogin, isBrowserSessionChange, startGoogleLogin } from './auth-client'
import { ShoppingJourney } from './ShoppingJourney'
import { RoundReports } from './RoundReports'
import { useShoppingRounds } from './useShoppingRounds'
import { HomeSummary, ProductDetailView, PurchaseDetailView } from './AccountViews'
import { getProductDetail, type ProductDetail } from './purchase-management'
import { AccountAvatar, AccountPhotoContext, Icon, PageHeader, ProductThumb, useMobileViewport } from './ui'
import {
  getPendingOperationCount,
  syncPendingOperations,
  requestPersistentStorage,
  type CachedProduct,
} from './offline'

type Account = { id: string; displayName: string | null; primaryEmail: string | null; avatarUrl?: string | null }
type AuthResponse = { data: { authenticated: boolean; account: Account | null } }
type Product = CachedProduct
type AppView = 'home' | 'purchase' | 'history' | 'products' | 'account'

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
  packageSize?: string | null
  imageUrl: string | null
  purchaseCount: number
  totalSpentMinor: number
  lastPurchasedAt: string
}

type PageResponse<T> = { data: { items: T[]; nextCursor: string | null } }

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:8787'
const storageUpgradeMessage = 'มีแท็บ SmartCart อื่นขวางการอัปเดตพื้นที่เก็บข้อมูล กรุณาปิดแท็บ SmartCart อื่นทั้งหมด แล้วรีเฟรชหน้านี้ ไม่ต้องล้างข้อมูลเบราว์เซอร์'

function App() {
  useMobileViewport()
  const [account, setAccount] = useState<Account | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [accountReturnView, setAccountReturnView] = useState<AppView>('purchase')
  const [shoppingFocused, setShoppingFocused] = useState(false), [reportFocused, setReportFocused] = useState(false)
  const [addImageAction, setAddImageAction] = useState(0), [reportId, setReportId] = useState<string | null>(null)
  const [storageInfo, setStorageInfo] = useState(''), [buyingProduct, setBuyingProduct] = useState<string | null>(null)
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

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'auto' }) }, [activeView, detail?.id, detail?.kind])

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
    setSyncMessage(null)
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
    setDetailsDirty(false); setDetail(null); setDetailStack([]); setActiveView(view); setReportId(null)
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
  function openAccount() { setAccountReturnView(activeView); navigate('account') }
  async function buyProduct(id: string) {
    if (!account || !isOnline || buyingProduct) return
    const sequence = authSequence.current
    setBuyingProduct(id); setProductsMessage(null)
    try { const item = await getProductDetail(apiOrigin, id); if (sequence === authSequence.current) buyAgain(item) }
    catch { if (sequence === authSequence.current) setProductsMessage('ยังเปิดสินค้าไม่สำเร็จ ลองอีกครั้ง') }
    finally { setBuyingProduct(null) }
  }

  const pending = (pendingSyncCount ?? 0) + rounds.pending.length
  const busySync = isSyncing || rounds.syncing
  const showSync = !isOnline || pending > 0 || busySync || pendingSyncCount === null || Boolean(rounds.error)
  const showNavigation = !detail && activeView !== 'account' && activeView !== 'home' && !(activeView === 'purchase' && shoppingFocused) && !(activeView === 'history' && reportFocused)
  return <AccountPhotoContext.Provider value={account?.avatarUrl ?? null}><main className="app-shell"><div className={`app-frame${account && !isLoading && showNavigation ? ' with-navigation' : ''}${account && !isLoading && showSync ? ' has-sync' : ''}`} data-view={activeView}>
    {!account || isLoading ? <section className="mobile-page login-page" aria-labelledby="login-title">
      <PageHeader title="SmartCart" id="login-title" />
      <div className="page-content login-content"><div className="scan-invitation"><span className="scan-mark"><Icon name="scanHero" /></span><h2>ซื้อสินค้าเป็นรอบ</h2><p className="muted">สแกน · บันทึก · ดูยอดซื้อ</p></div>
        <div className="page-actions">
          {isLoading ? <p role="status">กำลังตรวจสอบการเข้าสู่ระบบ…</p> : <>
            {authMessage ? <p className="error-message" role="status">{authMessage}</p> : null}
            {!isOnline ? <p className="pending-caption">เชื่อมต่ออินเทอร์เน็ตเพื่อเข้าสู่ระบบ</p> : null}
            <button className="primary-button google-button" onClick={() => void signInWithGoogle()} disabled={!googleEnabled || !isOnline || isSigningIn}><span aria-hidden="true">G</span>{isSigningIn ? 'กำลังเปิด Google…' : 'เข้าสู่ระบบด้วย Google'}</button>
            {(!googleEnabled || sessionInfo) && isOnline ? <button className="secondary-button" onClick={() => { setIsLoading(true); void loadAccount() }}>ตรวจสอบการเข้าสู่ระบบอีกครั้ง</button> : null}
            <p className="action-caption">จดจำบนเครื่องนี้อัตโนมัติ</p>
          </>}
        </div>
      </div>
    </section> : <>
      {showSync ? <aside className={`global-sync${!isOnline || pending || pendingSyncCount === null || rounds.error ? ' pending' : ''}`} aria-live="polite">
        <span>{!isOnline ? 'ออฟไลน์' : busySync ? 'กำลังซิงก์…' : pending > 0 ? 'รอซิงก์' : 'ตรวจข้อมูลไม่ได้'}{rounds.pending.length ? ` · ${rounds.pending.length} รอบ` : ''}{pendingSyncCount ? ` · ${pendingSyncCount} รายการ` : ''}{pendingSyncCount === null ? ' · ตรวจจำนวนไม่ได้' : ''}</span>
        {pending > 0 && isOnline ? <button className="text-button" onClick={() => void syncQueue()} disabled={busySync}>ซิงก์</button> : null}
        {pending > 0 ? <small>อย่าล้างข้อมูลก่อนซิงก์</small> : null}
      </aside> : null}

      {activeView === 'account' && !detail ? <section className="mobile-page focused-page" aria-labelledby="account-title"><PageHeader title="บัญชี" id="account-title" onBack={() => navigate(accountReturnView)} /><div className="page-content account-content">
        <div className="account-identity"><span className="account-avatar"><AccountAvatar large /></span><div><strong>{account.displayName ?? 'บัญชี Google'}</strong>{account.primaryEmail ? <span className="muted">{account.primaryEmail}</span> : null}<small className="green-text">เข้าสู่ระบบแล้ว</small></div></div>
        <h2>ข้อมูลของฉัน</h2><div className="summary-row"><span>สถานะ</span><strong className={pending || pendingSyncCount === null || rounds.error ? 'pending-caption' : 'green-text'}>{pending ? `รอซิงก์ ${rounds.pending.length} รอบ${pendingSyncCount ? ` / ${pendingSyncCount} รายการ` : ''}` : pendingSyncCount === null || rounds.error ? 'ตรวจสอบไม่ได้' : busySync ? 'กำลังซิงก์…' : 'ซิงก์แล้ว'}</strong></div>
        {syncMessage ? <p className="inline-message" role="status">{syncMessage}</p> : null}
        <button className="secondary-button" onClick={() => void syncQueue()} disabled={!isOnline || busySync || (!pending && pendingSyncCount !== null && !rounds.error)}>{busySync ? 'กำลังซิงก์…' : 'ซิงก์ข้อมูล'}</button>
        <details className="disclosure"><summary>การเข้าสู่ระบบ<Icon name="down" /></summary><div><p className="muted">{sessionInfo?.remembered ? `จดจำถึง ${formatDate(sessionInfo.expiresAt)} หากใช้เครื่องร่วมกับผู้อื่น ให้ออกจากระบบเมื่อเสร็จ` : 'เบราว์เซอร์ไม่อนุญาตให้จดจำถาวร ใช้ได้เฉพาะแท็บนี้'}</p><button type="button" className="secondary-button" disabled={!isOnline || isSigningIn} onClick={() => void signInWithGoogle()}>{isSigningIn ? 'กำลังเปิด Google…' : 'อัปเดตรูป Google'}</button></div></details>
        <details className="disclosure"><summary>พื้นที่เก็บข้อมูลออฟไลน์<Icon name="down" /></summary><div><p className="muted">ข้อมูลที่ยังไม่ซิงก์อาจสูญหายเมื่อเครื่องล้างพื้นที่ อย่าล้างข้อมูลเว็บก่อนซิงก์สำเร็จ</p><button className="secondary-button" onClick={() => { void requestPersistentStorage().then(result => setStorageInfo(result ? 'ได้รับสิทธิ์เก็บข้อมูลแล้ว แต่ยังควรซิงก์เสมอ' : 'เครื่องไม่ได้อนุญาต ยังบันทึกบนเครื่องและซิงก์ได้ตามปกติ')).catch(() => setStorageInfo('ตรวจสอบสิทธิ์ไม่ได้ โปรดซิงก์ข้อมูลเมื่อออนไลน์')) }}>ขอเก็บข้อมูลบนเครื่อง</button>{storageInfo ? <p role="status" className="muted">{storageInfo}</p> : null}</div></details>
        <details className="disclosure"><summary>ข้อมูลเพิ่มเติม<Icon name="down" /></summary><div><button className="secondary-button" onClick={() => navigate('home')}>ภาพรวมรายการซื้อ</button></div></details>
        {authMessage ? <p role="status" className="error-message">{authMessage}</p> : null}
        <div className="page-actions"><button className="primary-button" onClick={() => navigate('purchase')}>กลับไปซื้อสินค้า</button><button className="text-button" onClick={() => void signOut()} disabled={isSigningOut}>{isSigningOut ? 'กำลังออกจากระบบ…' : 'ออกจากระบบ'}</button></div>
      </div></section> : null}

      {detail ? <div className="legacy-detail"><PageHeader title={detail.kind === 'purchase' ? 'รายการซื้อ' : 'รายละเอียดสินค้า'} />{detail.kind === 'purchase' ? <PurchaseDetailView key={`${account.id}:purchase:${detail.id}`} apiOrigin={apiOrigin} accountId={account.id} id={detail.id} online={isOnline} onBack={closeDetail} onDirtyChange={setDetailsDirty} onChanged={() => setDataVersion(v => v + 1)} onProduct={id => openDetail('product', id)} />
        : <ProductDetailView key={`${account.id}:product:${detail.id}`} apiOrigin={apiOrigin} id={detail.id} online={isOnline} onBack={closeDetail} onPurchase={id => openDetail('purchase', id)} onBuy={buyAgain} />}</div> : null}

      {activeView === 'home' && !detail ? <div className="legacy-detail"><PageHeader title="ภาพรวมรายการซื้อ" onBack={() => navigate('account')} /><HomeSummary key={account.id} apiOrigin={apiOrigin} accountId={account.id} online={isOnline} version={dataVersion} pendingCount={pendingSyncCount} onAdd={() => navigate('purchase')} onHistory={() => navigate('history')} onPurchase={id => openDetail('purchase', id)} /></div> : null}

      <div className="view-page" hidden={activeView !== 'purchase' || Boolean(detail)}><ShoppingJourney key={account.id} accountId={account.id} apiOrigin={apiOrigin} online={isOnline} visible={activeView === 'purchase' && !detail} rounds={rounds} initialProduct={product} onConsumed={() => { setProduct(null); setAddImageAction(0) }} onAccount={openAccount} onFocusChange={setShoppingFocused} action={addImageAction} onReport={id => { navigate('history'); setReportId(id) }} /></div>

      {activeView === 'history' && !detail ? <div className="view-page"><RoundReports key={account.id} accountId={account.id} apiOrigin={apiOrigin} online={isOnline} version={dataVersion} rounds={rounds} initialRoundId={reportId} onAccount={openAccount} onFocusChange={setReportFocused} legacy={<details className="disclosure legacy-history"><summary>รายการเดิม<Icon name="down" /></summary><div>
        <SearchForm value={historySearch} setValue={setHistorySearch} onSubmit={() => { setHistoryQuery(historySearch); void loadHistory(true, historySearch) }} placeholder="สินค้า หรือร้านค้า" />
        {!isOnline ? <p className="muted">ออนไลน์เพื่อโหลดรายการเดิม</p> : null}{historyMessage ? <p role="status" className="error-message">{historyMessage}</p> : null}
        <div className="history-list">{historyItems.map(item => <HistoryCard key={item.id} item={item} onOpen={() => openDetail('purchase', item.id)} />)}</div>
        {isOnline && !isLoadingHistory && !historyItems.length ? <p className="muted">ไม่มีรายการเดิม</p> : null}
        {historyCursor ? <button className="secondary-button" onClick={() => void loadHistory(false)} disabled={isLoadingHistory}>{isLoadingHistory ? 'กำลังโหลด…' : 'ดูเพิ่มเติม'}</button> : null}
      </div></details>} /></div> : null}

      {activeView === 'products' && !detail ? <section className="mobile-page" aria-labelledby="products-title"><PageHeader title="สินค้า" id="products-title" onAccount={openAccount} /><div className="page-content product-content">
        <SearchForm value={productsSearch} setValue={setProductsSearch} onSubmit={() => { setProductsQuery(productsSearch); void loadMyProducts(true, productsSearch) }} placeholder="ชื่อสินค้า หรือบาร์โค้ด" />
        {!isOnline ? <p className="pending-caption">ออนไลน์เพื่อโหลดสินค้า</p> : null}{productsMessage ? <p role="alert" className="error-message">{productsMessage}</p> : null}
        <div className="product-library">{myProducts.map(item => <MyProductCard key={item.id} item={item} onOpen={() => openDetail('product', item.id)} onBuy={() => void buyProduct(item.id)} disabled={!isOnline || Boolean(buyingProduct)} buying={buyingProduct === item.id} />)}</div>
        {isOnline && !isLoadingProducts && !myProducts.length ? <p className="empty-state">ยังไม่มีสินค้าที่เคยซื้อ</p> : null}
        {isLoadingProducts ? <p role="status">กำลังโหลดสินค้า…</p> : null}{productsCursor ? <button className="secondary-button" onClick={() => void loadMyProducts(false)} disabled={isLoadingProducts}>ดูสินค้าเพิ่มเติม</button> : null}
        <div className="page-actions"><button className="secondary-button" disabled={!isOnline} onClick={() => { navigate('purchase'); setAddImageAction(value => value + 1) }}><Icon name="plusGreen" />เพิ่มสินค้า</button></div>
      </div></section> : null}

      {showNavigation ? <nav className="bottom-nav" aria-label="เมนูหลัก">{([{ view: 'purchase', label: 'ซื้อสินค้า', activeIcon: 'scan', icon: 'scanMuted' }, { view: 'history', label: 'รายงาน', activeIcon: 'reportActive', icon: 'report' }, { view: 'products', label: 'สินค้า', activeIcon: 'boxActive', icon: 'boxMuted' }] as const).map(tab => <button key={tab.view} className={activeView === tab.view ? 'nav-active' : ''} aria-current={activeView === tab.view ? 'page' : undefined} disabled={rounds.busy} onClick={() => navigate(tab.view)}><span className="nav-icon"><Icon name={activeView === tab.view ? tab.activeIcon : tab.icon} /></span><span>{tab.label}</span></button>)}</nav> : null}
    </>}
  </div></main></AccountPhotoContext.Provider>
}

function SearchForm({ value, setValue, onSubmit, placeholder }: { value: string; setValue: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return <form className="search-form" role="search" onSubmit={event => { event.preventDefault(); onSubmit() }}><div className="search-bar"><button className="icon-button" aria-label="ค้นหา"><Icon name="search" /></button><input type="search" aria-label="ค้นหา" value={value} onChange={event => setValue(event.target.value)} maxLength={80} placeholder={placeholder} /></div></form>
}

function HistoryCard({ item, onOpen }: { item: PurchaseHistoryItem; onOpen: () => void }) {
  return <article className="history-card">
    {item.imageUrl ? <img src={item.imageUrl} alt="" /> : <div className="small-image-placeholder" aria-hidden="true">สินค้า</div>}
    <div><strong>{item.productName}</strong><p>{[item.productBrand, `SKU: ${item.productSku ?? item.productId}`, item.productUpc ? `UPC: ${item.productUpc}` : null, item.storeName].filter(Boolean).join(' · ')}</p><small>{formatDate(item.purchasedAt)} · {item.quantity} ชิ้น × {formatBaht(item.unitPriceMinor)}</small></div>
    <strong className="history-total">{formatBaht(item.totalMinor)}</strong>
    <button type="button" className="secondary-button card-detail-link" onClick={onOpen} aria-label={`ดูรายละเอียดรายการซื้อ ${item.productName}`}>ดูรายละเอียด / แก้ไข</button>
  </article>
}

function MyProductCard({ item, onOpen, onBuy, disabled, buying }: { item: MyProductItem; onOpen: () => void; onBuy: () => void; disabled: boolean; buying: boolean }) {
  return <article className="library-row"><button className="library-details" onClick={onOpen} aria-label={`ดูรายละเอียดสินค้า ${item.name}`}><ProductThumb imageUrl={item.imageUrl} /><span className="row-description"><strong>{item.name}</strong><small>{item.packageSize ?? item.brand ?? `ซื้อ ${item.purchaseCount} ครั้ง`}</small></span></button><button className="buy-again" onClick={onBuy} disabled={disabled} aria-label={`ซื้อ ${item.name} อีก`}>{buying ? 'กำลังเปิด…' : 'ซื้ออีก'}</button></article>
}

function formatBaht(minor: number): string {
  return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB' }).format(minor / 100)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default App

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  clearSessionCookie,
  completeGoogleLogin,
  currentAccount,
  exchangeBrowserLogin,
  getRequestId,
  isTrustedOrigin,
  isGoogleLoginConfigured,
  revokeCurrentSession,
  startGoogleLogin,
  type AuthEnv,
} from './auth'
import { ManualProductInputError, ProductLookupError, createManualProduct, importBigCProductLink, lookupProductByUpc } from './products'
import { BigCLinkError } from './bigc-link'
import { extractProductImage, ImageExtractionError } from './image-extraction'
import { confirmImageProduct, ImageProductError } from './image-product'
import { PurchaseInputError, PurchaseProductNotFoundError, createPurchase } from './purchases'
import { SyncInputError, syncOperations } from './sync'
import { HistoryInputError, listMyProducts, listPurchaseHistory } from './history'
import { changePurchase, dashboard, productDetail, purchaseDetail, PurchaseManagementError } from './purchase-management'
import { checkoutRound, listRounds, roundDetail, ShoppingRoundError } from './shopping-rounds'
import { changeProductProfile, ProductProfileError, withProductProfile } from './product-profile'
import { AdminError, adminEligible, adminLogin, adminLogout, changeAdminPassword, requireAdmin } from './admin'
import { adminProduct, changeAdminProduct, listAdminProducts } from './admin-catalog'
import { changeAdminProductImage, ProductImageError, readProductImageAsset } from './product-images'
import { AccessLogQueryError, listAccessLogs, purgeAccessLogs, recordAccess } from './access-logs'

type Bindings = { Bindings: AuthEnv; Variables: { adminAccountId: string } }

const app = new Hono<Bindings>()

app.use(
  '*',
  cors({
    origin: (origin, context) => {
      return origin === context.env.APP_ORIGIN ? origin : ''
    },
    allowHeaders: ['Content-Type', 'X-Request-Id', 'Authorization', 'X-SmartCart-Profile', 'X-SmartCart-Admin'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  }),
)

app.use('*', async (context, next) => {
  await next()
  context.header('Cache-Control', 'no-store')
  context.header('Referrer-Policy', 'no-referrer')
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('X-Frame-Options', 'DENY')
  // Public, user-confirmed product crops may be displayed by the GitHub Pages frontend.
  context.header('Cross-Origin-Resource-Policy', context.req.path.startsWith('/api/v1/product-images/') ? 'cross-origin' : 'same-site')
  context.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()')
  if (context.env.ENVIRONMENT === 'production') {
    context.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})

app.use('/auth/*', async (context, next) => {
  context.header('Cache-Control', 'no-store')
  await next()
  context.header('Cache-Control', 'no-store')
})

app.get('/auth/config', (context) => context.json({ data: { googleEnabled: isGoogleLoginConfigured(context.env) } }))
app.post('/auth/exchange', (context) => exchangeBrowserLogin(context.req.raw, context.env))

app.get('/api/v1/health', (context) => {
  return context.json({
    data: { status: 'ok', environment: context.env.ENVIRONMENT },
    meta: { requestId: getRequestId(context.req.raw) },
  })
})

app.get('/api/v1/product-images/:id/:file', async (context) => {
  const match = /^([0-9a-f]{64})\.jpg$/.exec(context.req.param('file'))
  if (!match) return context.json({ error: { code: 'NOT_FOUND' } }, 404)
  return readProductImageAsset(context.req.param('id'), match[1], context.env)
})

// Separate elevated surface: ordinary Google login never grants catalog administration.
app.use('/api/v1/admin/*', async (context, next) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  if (context.req.method !== 'GET' && context.req.header('Origin') !== context.env.APP_ORIGIN)
    return context.json({ error: { code: 'UNTRUSTED_ORIGIN' } }, 403)
  context.set('adminAccountId', account.id)
  await next()
})
app.get('/api/v1/admin/status', async (context) => {
  return context.json({ data: { eligible: await adminEligible(context.get('adminAccountId'), context.env) } })
})
app.post('/api/v1/admin/login', async (context) => {
  const userId = context.get('adminAccountId')
  try {
    const data = await adminLogin(context.req.raw, userId, context.env)
    await recordAccess(context.req.raw, context.env, 'admin_login_succeeded', 'success', userId, 'SIGNED_IN')
    return context.json({ data })
  } catch (error) {
    await recordAccess(context.req.raw, context.env, 'admin_login_failed', 'failure', userId, error instanceof AdminError ? error.code : 'INTERNAL_ERROR')
    throw error
  }
})
app.post('/api/v1/admin/password', async (context) => {
  const access = await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env, true)
  const data = await changeAdminPassword(context.req.raw, access, context.env)
  await recordAccess(context.req.raw, context.env, 'admin_password_changed', 'success', access.userId, 'PASSWORD_CHANGED')
  return context.json({ data })
})
app.post('/api/v1/admin/logout', async (context) => {
  return context.json({ data: await adminLogout(await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env, true), context.env) })
})
app.get('/api/v1/admin/products', async (context) => {
  await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env)
  return context.json({ data: await listAdminProducts(new URL(context.req.url), context.env) })
})

app.get('/api/v1/admin/access-logs', async (context) => {
  await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env)
  return context.json({ data: await listAccessLogs(new URL(context.req.url), context.env) })
})
app.get('/api/v1/admin/products/:id', async (context) => {
  await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env)
  return context.json({ data: await adminProduct(context.req.param('id'), context.env) })
})
app.patch('/api/v1/admin/products/:id', async (context) => {
  const access = await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env)
  return context.json({ data: await changeAdminProduct(context.req.raw, context.req.param('id'), access, context.env) })
})
app.patch('/api/v1/admin/products/:id/image', async (context) => {
  const access = await requireAdmin(context.req.raw, context.get('adminAccountId'), context.env)
  return context.json({ data: await changeAdminProductImage(context.req.raw, context.req.param('id'), access, context.env) })
})

app.get('/api/v1/products/upc/:upc', async (context) => {
  try {
    const canonical = await lookupProductByUpc(context.req.param('upc'), context.env, context.req.query('databaseOnly') === '1')
    const account = await currentAccount(context.req.raw, context.env)
    const product = account && context.req.header('X-SmartCart-Profile') === '1' ? await withProductProfile(canonical, account.id, context.env) : canonical
    return context.json({ data: product, meta: { requestId: getRequestId(context.req.raw), source: product.source } })
  } catch (error) {
    if (error instanceof ProductLookupError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: productErrorMessage(error.code),
            retryable: error.retryable,
            manualEntry: true,
          },
          meta: { requestId: getRequestId(context.req.raw) },
        },
        error.status,
      )
    }
    throw error
  }
})

app.get('/api/v1/products/mine', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) {
    return context.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in is required' } }, 401)
  }
  try {
    const page = await listMyProducts(new URL(context.req.url), account.id, context.env)
    return context.json({ data: page, meta: { requestId: getRequestId(context.req.raw) } })
  } catch (error) {
    if (error instanceof HistoryInputError) {
      return context.json({ error: { code: 'INVALID_QUERY', message: 'Product query is invalid' } }, 400)
    }
    throw error
  }
})

app.post('/api/v1/products/extract-image', async (context) => {
  try {
    const preview = await extractProductImage(context.req.raw, context.env)
    return context.json({ data: preview, meta: { requestId: getRequestId(context.req.raw) } })
  } catch (error) {
    if (error instanceof ImageExtractionError) return context.json({ error: { code: error.code, message: imageErrorMessage(error.code) } }, error.status)
    throw error
  }
})

app.post('/api/v1/products/import-image', async (context) => {
  try {
    const result = await confirmImageProduct(context.req.raw, context.env)
    const account = await currentAccount(context.req.raw, context.env)
    const product = account && context.req.header('X-SmartCart-Profile') === '1' ? await withProductProfile(result.product, account.id, context.env) : result.product
    return context.json({ data: product, meta: { created: result.created, requestId: getRequestId(context.req.raw) } }, result.created ? 201 : 200)
  } catch (error) {
    if (error instanceof ImageProductError) return context.json({ error: { code: error.code, message: imageErrorMessage(error.code) } }, error.status)
    throw error
  }
})

app.post('/api/v1/products/import-bigc', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED', message: 'กรุณาเข้าสู่ระบบก่อนนำเข้าสินค้า' } }, 401)
  if (!isTrustedOrigin(context.req.raw, context.env)) {
    return context.json({ error: { code: 'UNTRUSTED_ORIGIN', message: 'Origin is not allowed' } }, 403)
  }
  try {
    const canonical = await importBigCProductLink(context.req.raw, context.env)
    const product = context.req.header('X-SmartCart-Profile') === '1' ? await withProductProfile(canonical, account.id, context.env) : canonical
    return context.json({ data: product, meta: { requestId: getRequestId(context.req.raw), source: product.source } })
  } catch (error) {
    if (error instanceof BigCLinkError) return context.json({
      error: { code: error.code, message: bigCLinkErrorMessage(error.code), retryable: error.retryable },
      meta: { requestId: getRequestId(context.req.raw) },
    }, error.status)
    throw error
  }
})

app.post('/api/v1/products', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) {
    return context.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in is required' } }, 401)
  }
  try {
    const canonical = await createManualProduct(context.req.raw, context.env)
    const product = context.req.header('X-SmartCart-Profile') === '1' ? await withProductProfile(canonical, account.id, context.env) : canonical
    return context.json({ data: product, meta: { requestId: getRequestId(context.req.raw), source: product.source } }, 201)
  } catch (error) {
    if (error instanceof ManualProductInputError) {
      return context.json({ error: { code: 'INVALID_PRODUCT', message: 'Product data is invalid' } }, 400)
    }
    throw error
  }
})

app.post('/api/v1/purchases', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) {
    return context.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in is required' } }, 401)
  }
  try {
    const purchase = await createPurchase(context.req.raw, account.id, context.env)
    return context.json({ data: purchase, meta: { requestId: getRequestId(context.req.raw) } }, 201)
  } catch (error) {
    if (error instanceof PurchaseInputError) {
      return context.json({ error: { code: 'INVALID_PURCHASE', message: 'Purchase data is invalid' } }, 400)
    }
    if (error instanceof PurchaseProductNotFoundError) {
      return context.json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Product was not found' } }, 404)
    }
    throw error
  }
})

app.get('/api/v1/purchases', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) {
    return context.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in is required' } }, 401)
  }
  try {
    const page = await listPurchaseHistory(new URL(context.req.url), account.id, context.env)
    return context.json({ data: page, meta: { requestId: getRequestId(context.req.raw) } })
  } catch (error) {
    if (error instanceof HistoryInputError) {
      return context.json({ error: { code: 'INVALID_QUERY', message: 'Purchase query is invalid' } }, 400)
    }
    throw error
  }
})

app.post('/api/v1/sync', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) {
    return context.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in is required' } }, 401)
  }
  try {
    const operations = await syncOperations(context.req.raw, account.id, context.env)
    return context.json({ data: { operations }, meta: { requestId: getRequestId(context.req.raw) } })
  } catch (error) {
    if (error instanceof SyncInputError) {
      return context.json({ error: { code: 'INVALID_SYNC', message: 'Sync data is invalid' } }, 400)
    }
    throw error
  }
})

app.post('/api/v1/rounds/checkout', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  if (!isTrustedOrigin(context.req.raw, context.env)) return context.json({ error: { code: 'UNTRUSTED_ORIGIN' } }, 403)
  return context.json({ data: await checkoutRound(context.req.raw, account.id, context.env) })
})
app.get('/api/v1/rounds', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  return context.json({ data: await listRounds(new URL(context.req.url), account.id, context.env) })
})
app.get('/api/v1/rounds/:id', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  return context.json({ data: await roundDetail(context.req.param('id'), account.id, context.env) })
})

app.get('/api/v1/dashboard', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  return context.json({ data: await dashboard(new URL(context.req.url), account.id, context.env) })
})

app.get('/api/v1/products/:id/detail', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  return context.json({ data: await productDetail(context.req.param('id'), account.id, context.env, context.req.header('X-SmartCart-Profile') === '1') })
})

app.patch('/api/v1/products/:id/detail', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  if (context.req.header('Origin') !== context.env.APP_ORIGIN) return context.json({ error: { code: 'UNTRUSTED_ORIGIN' } }, 403)
  return context.json({ data: await changeProductProfile(context.req.raw, context.req.param('id'), account.id, context.env) })
})

app.on(['GET', 'PATCH', 'DELETE'], '/api/v1/purchases/:id', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) return context.json({ error: { code: 'UNAUTHENTICATED' } }, 401)
  if (context.req.method !== 'GET' && context.req.header('Origin') !== context.env.APP_ORIGIN) {
    return context.json({ error: { code: 'UNTRUSTED_ORIGIN' } }, 403)
  }
  const data = context.req.method === 'GET' ? await purchaseDetail(context.req.param('id'), account.id, context.env)
    : await changePurchase(context.req.raw, context.req.param('id'), account.id, context.env)
  return context.json({ data })
})

app.get('/auth/google/start', async (context) => startGoogleLogin(context.req.raw, context.env))

app.get('/auth/google/callback', async (context) => completeGoogleLogin(context.req.raw, context.env))

app.get('/auth/me', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  return context.json({ data: { authenticated: Boolean(account), account } })
})

app.post('/auth/logout', async (context) => {
  if (!isTrustedOrigin(context.req.raw, context.env)) {
    return context.json({ error: { code: 'UNTRUSTED_ORIGIN', message: 'Origin is not allowed' } }, 403)
  }
  await revokeCurrentSession(context.req.raw, context.env)
  const response = context.json({ data: { signedOut: true } })
  response.headers.append('Set-Cookie', clearSessionCookie(context.env))
  return response
})

app.notFound((context) => context.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404))

app.onError((error, context) => {
  if (error instanceof AccessLogQueryError) return context.json({ error: { code: 'INVALID_QUERY' } }, 400)
  if (error instanceof ProductImageError) return context.json({ error: { code: error.code, reason: error.reason, message: imageErrorMessage(error.code) } }, error.status)
  if (error instanceof AdminError) {
    context.header('Cache-Control', 'no-store')
    if (error.status === 429) context.header('Retry-After', '900')
    return context.json({ error: { code: error.code } }, error.status)
  }
  if (error instanceof ProductProfileError) return context.json({ error: { code: error.code } }, error.status)
  if (error instanceof ShoppingRoundError) return context.json({ error: { code: error.code } }, error.status)
  if (error instanceof PurchaseManagementError) return context.json({ error: { code: error.code, message: error.code } }, error.status)
  const requestId = getRequestId(context.req.raw)
  console.error(
    JSON.stringify({
      message: 'request failed',
      requestId,
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  return context.json(
    { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }, meta: { requestId } },
    500,
  )
})

function productErrorMessage(code: ProductLookupError['code']): string {
  switch (code) {
    case 'INVALID_UPC':
      return 'UPC ต้องเป็นรหัสตัวเลข 8, 12, 13 หรือ 14 หลัก'
    case 'PRODUCT_NOT_FOUND':
      return 'ไม่พบสินค้านี้ กรุณากรอกข้อมูลสินค้าเอง'
    case 'BIGC_UNAVAILABLE':
      return 'ยังดึงข้อมูลจาก Big C ไม่ได้ กรุณาลองใหม่หรือกรอกข้อมูลสินค้าเอง'
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: AuthEnv) { await purgeAccessLogs(env) },
} satisfies ExportedHandler<AuthEnv>

function imageErrorMessage(code: string): string {
  switch (code) {
    case 'PRODUCT_IMAGE_INVALID': return 'ยังบันทึกรูปไม่ได้ ระบบตรวจไฟล์รูปไม่ผ่าน'
    case 'PRODUCT_IMAGE_TOO_LARGE': return 'ยังบันทึกรูปไม่ได้ ไฟล์รูปใหญ่เกินขนาดที่ระบบรับได้'
    case 'UNAUTHENTICATED': return 'กรุณาเข้าสู่ระบบก่อนอ่านภาพหรือเพิ่มสินค้า'
    case 'UNTRUSTED_ORIGIN': return 'กรุณาใช้หน้า SmartCart ที่ได้รับอนุญาต'
    case 'IMAGE_TOO_LARGE': return 'ภาพใหญ่เกินไป กรุณาใช้ภาพขนาดเล็กลง'
    case 'IMAGE_UNSUPPORTED': return 'รองรับภาพ JPG, PNG และ WebP เท่านั้น'
    case 'IMAGE_UNREADABLE': return 'ยังอ่านข้อมูลสินค้าในภาพไม่ชัด กรุณาเลือกภาพใหม่หรือกรอกเองจากภาพ'
    case 'IMAGE_QUOTA_EXCEEDED': return 'ถึงขีดจำกัดการอ่านภาพวันนี้แล้ว กรุณากรอกเองหรือกลับมาลองวันถัดไป'
    case 'IMAGE_AI_UNAVAILABLE': return 'บริการอ่านภาพยังไม่พร้อม กรุณาลองใหม่ภายหลังหรือกรอกเองจากภาพ'
    case 'IMAGE_IMPORT_CONFLICT': return 'รายการยืนยันนี้มีข้อมูลไม่ตรงกับครั้งก่อน กรุณาตรวจสอบสินค้าเดิมก่อนเริ่มใหม่'
    default: return 'กรุณาตรวจชื่อสินค้า ราคา และบาร์โค้ด แล้วติ๊กยืนยันข้อมูลก่อนบันทึก'
  }
}

function bigCLinkErrorMessage(code: BigCLinkError['code']): string {
  switch (code) {
    case 'INVALID_IMPORT': return 'ข้อมูลนำเข้าไม่ถูกต้อง กรุณาส่งลิงก์สินค้าของ Big C'
    case 'INVALID_BIGC_URL': return 'ใช้ลิงก์หน้าสินค้า https://www.bigc.co.th/product/... เท่านั้น ไม่ใช่หน้าค้นหาหรือลิงก์ย่อ'
    case 'BIGC_BLOCKED': return 'Big C บล็อกการอ่านข้อมูลอัตโนมัติ จึงยังไม่เพิ่มสินค้า ลิงก์ที่ส่งมาไม่ได้ทำให้ข้ามระบบป้องกันบอตได้'
    case 'BIGC_PRODUCT_NOT_FOUND': return 'ไม่พบหน้าสินค้า Big C นี้ กรุณาตรวจลิงก์'
    case 'BIGC_PRODUCT_DATA_MISSING': return 'อ่านข้อมูล SKU ที่ตรงกับลิงก์ไม่ได้ จึงยังไม่เพิ่มสินค้า'
    case 'BIGC_UPC_CONFLICT': return 'บาร์โค้ดของสินค้าขัดแย้งกับข้อมูลเดิม กรุณาตรวจสอบก่อนนำเข้า'
    case 'BIGC_UNAVAILABLE': return 'ยังอ่านหน้าสินค้า Big C ไม่สำเร็จ กรุณาลองใหม่ภายหลัง'
  }
}

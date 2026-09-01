import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  clearSessionCookie,
  completeGoogleLogin,
  currentAccount,
  getRequestId,
  isTrustedOrigin,
  revokeCurrentSession,
  startGoogleLogin,
  type AuthEnv,
} from './auth'
import { ManualProductInputError, ProductLookupError, createManualProduct, lookupProductByUpc } from './products'
import { PurchaseInputError, PurchaseProductNotFoundError, createPurchase } from './purchases'
import { SyncInputError, syncOperations } from './sync'
import { HistoryInputError, listMyProducts, listPurchaseHistory } from './history'

type Bindings = { Bindings: AuthEnv }

const app = new Hono<Bindings>()

app.use(
  '*',
  cors({
    origin: (origin, context) => {
      return origin === context.env.APP_ORIGIN ? origin : ''
    },
    allowHeaders: ['Content-Type', 'X-Request-Id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  }),
)

app.use('*', async (context, next) => {
  await next()
  context.header('Referrer-Policy', 'no-referrer')
  context.header('X-Content-Type-Options', 'nosniff')
  context.header('X-Frame-Options', 'DENY')
  context.header('Cross-Origin-Resource-Policy', 'same-site')
  context.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()')
  if (context.env.ENVIRONMENT === 'production') {
    context.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})

app.get('/api/v1/health', (context) => {
  return context.json({
    data: { status: 'ok', environment: context.env.ENVIRONMENT },
    meta: { requestId: getRequestId(context.req.raw) },
  })
})

app.get('/api/v1/products/upc/:upc', async (context) => {
  try {
    const product = await lookupProductByUpc(context.req.param('upc'), context.env)
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

app.post('/api/v1/products', async (context) => {
  const account = await currentAccount(context.req.raw, context.env)
  if (!account) {
    return context.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in is required' } }, 401)
  }
  try {
    const product = await createManualProduct(context.req.raw, context.env)
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

export default app


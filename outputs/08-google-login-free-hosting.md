# Google Login — Free Hosting Update

Updated: 2026-10-24

## Implemented

- Fixed the optional Google credentials type error with a validated `GoogleAuthEnv` type.
- Added `APP_URL` separately from `APP_ORIGIN`; staging redirects return to `/um/`.
- Added migration `0003_browser_login.sql` for browser PKCE challenges and single-use login codes.
- Google OAuth remains server-side, with state, nonce, Google PKCE, and signature/audience/issuer checks.
- The callback issues a 60-second, one-use code bound to a separate browser verifier. No session or Google token is put in a URL.
- `/auth/exchange` atomically consumes the code and returns an opaque session; D1 stores only its SHA-256 hash.
- The frontend clears the callback fragment before exchange, stores its session in sessionStorage, and sends Authorization headers on API requests, including offline sync.
- No third-party cookies or paid domains are needed. Closing the browser tab/session may require signing in again. Safari and Home Screen keep separate sessions and still need real-device verification.
- CORS permits Authorization only for the configured app origin. API responses use `Cache-Control: no-store`.
- Logout revokes the bearer session in D1 before clearing it from the browser.
- `/auth/config` exposes only readiness; the UI disables Google Login while credentials are absent.

## Verification

- Typecheck passes for frontend and API.
- 23 API tests pass, including 12 auth tests using the real migration files.
- Tests cover Google callback with a signed mock ID token, replay, expiration, concurrent exchange, verifier mismatch, logout, CORS, and missing credentials.
- A mocked Google callback does not verify the actual Google Cloud client configuration. Real Google sign-in remains pending until OAuth credentials are provisioned.

## Remaining setup

Staging currently has no Google Client ID/Secret. Google Cloud is signed in, but creating a dedicated SmartCart project requires the user's approval after automatic review rejected that action. No billing or paid service is required for the proposed login setup.

Create a Web application OAuth client with these values:

| Setting | Value |
|---|---|
| App URL | https://aumboonchu.github.io/um/ |
| JavaScript origin | https://aumboonchu.github.io |
| Redirect URI | https://smartcart-api-staging.jib-inventory.workers.dev/auth/google/callback |
| Scopes | openid, email, profile |

Store credentials with interactive `wrangler secret put GOOGLE_CLIENT_ID --env staging` and `wrangler secret put GOOGLE_CLIENT_SECRET --env staging` from `apps/api`. Never paste the secret into chat or commit it to GitHub.

After setup, verify real sign-in → reload → authenticated API → logout, including blocked third-party cookies and Safari/Home Screen. Production remains unconfigured.


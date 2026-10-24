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
- Real Google sign-in on the deployed GitHub Pages app passes with the owner's signed-in Google account.
- Reload preserves the session; History and Products load successfully using authenticated requests.
- Logout passes, and reload stays signed out. A read-only D1 aggregate confirms 1 revoked session and 0 active sessions after logout.
- `/auth/config` reports `googleEnabled: true`; Wrangler lists both Google secret names without revealing their values.
- Safari/Home Screen and an explicit browser setting that blocks third-party cookies still need separate real-device verification.

## Provisioned staging setup

The user approved creating SmartCart, its OAuth client, storing credentials in Cloudflare staging, using the account email as support/contact, and accepting the Google API Services User Data Policy. The Google Cloud project is `smartcart-512615`; its Web application OAuth client is named `SmartCart staging web`. Both credentials are stored as Worker secrets. No billing or paid service has been activated. Google Auth Platform remains in Testing mode; the app has not been published or verified for a production rollout.

The Web application OAuth client uses these values:

| Setting | Value |
|---|---|
| App URL | https://aumboonchu.github.io/um/ |
| JavaScript origin | https://aumboonchu.github.io |
| Redirect URI | https://smartcart-api-staging.jib-inventory.workers.dev/auth/google/callback |
| Scopes | openid, email, profile |

Store credentials with interactive `wrangler secret put GOOGLE_CLIENT_ID --env staging` and `wrangler secret put GOOGLE_CLIENT_SECRET --env staging` from `apps/api`. Never paste the secret into chat or commit it to GitHub.

Alternatively, after downloading the Web application OAuth client JSON, run `node scripts/configure-google-staging.mjs <absolute-downloaded-json-path>`. The helper validates the project and staging callback, reads credentials into memory, and sends them directly to Wrangler's stdin. It does not print credential values or create a credentials file in the repository. Keep the original Google download private.

The original Google JSON download is a private local credential backup outside this repository. A screenshot of the logged-out, login-ready app is saved locally as `11-google-login-ready.png`.

Staging sign-in → reload → authenticated API → logout is verified. Production remains unconfigured. Separate work remains for Safari/Home Screen QA, offline completion, camera scanning, and the Big C connector; those are not completed by this OAuth setup.


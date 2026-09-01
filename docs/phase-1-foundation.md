# Phase 1 — Foundation checklist

## Completed in the repository

- npm workspace for the web PWA and Cloudflare Worker.
- React/Vite web shell with PWA manifest and service worker registration.
- Worker health endpoint at `GET /api/v1/health`.
- D1 initial migration for user, identity, session, product, purchase, store and sync entities.
- Local, staging and production Worker configuration structure.
- CI, GitHub Pages deployment and manual Cloudflare deployment workflows.

## Required before the first staging deployment

1. Create the GitHub repository and enable GitHub Pages with GitHub Actions as the deployment source.
2. Create `smartcart-staging` and `smartcart-production` D1 databases.
3. Replace both D1 placeholders in `apps/api/wrangler.jsonc` with returned database IDs.
4. Set the final custom frontend and API domains in `wrangler.jsonc` (for example `app.example.com` and `api.example.com`).
5. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub environment secrets for `staging` and `production`.
6. Set Google OAuth client credentials as Worker secrets before enabling login. Apple Login is deferred.

## Local verification

```bash
npm install
copy apps\\api\\.dev.vars.example apps\\api\\.dev.vars
npm run dev:web
npm run dev:api
```

Open `http://localhost:8787/api/v1/health` to verify the Worker.

## Phase 1 exit criteria

- CI passes typecheck, tests and builds.
- Web app deploys to a GitHub Pages staging location.
- Staging Worker deploys and returns a health response.
- Staging D1 migration applies successfully.
- Production credentials and database IDs are not present in source control.


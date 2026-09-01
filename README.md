# SmartCart

SmartCart is a local-first PWA for recording purchases with UPC product lookup. It uses GitHub Pages for the web app, Cloudflare Workers for the API, and Cloudflare D1 for persistent data.

## What is included

- Google OpenID Connect login with PKCE, nonce, opaque HttpOnly sessions, and D1-backed replay protection.
- UPC-first product lookup: D1 cache first, then public Big C product data when available.
- Offline-first purchase capture with IndexedDB, UUID idempotency, D1 sync, and a pending-sync indicator.
- Purchase history and a per-user product library with search and cursor pagination.
- GitHub Actions verification plus separate web and API deployment workflows.

Apple Login is intentionally not implemented.

## Local development

Requirements: Node.js 22+ and npm 10+.

```bash
npm ci
npm run dev:web
npm run dev:api
```

The web app is `http://localhost:5173`; the Worker is `http://localhost:8787`.

Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars`, then place local Google development credentials in that untracked file.

## Release configuration

Do these steps before running either deployment workflow. Placeholder IDs and `YOUR_DOMAIN` values in `apps/api/wrangler.jsonc` are intentionally not deployable production settings.

1. Create independent D1 databases for staging and production, then replace the matching `database_id` fields in `apps/api/wrangler.jsonc`.

   ```bash
   npx wrangler d1 create smartcart-staging
   npx wrangler d1 create smartcart-production
   ```

2. Choose same-site custom domains, for example `app.example.com` for GitHub Pages and `api.example.com` for the Worker. Update `APP_ORIGIN` and `API_ORIGIN` for both named Worker environments. Add `api.example.com` as a Worker Custom Domain in Cloudflare.

   A custom app domain is important: a `github.io` app calling a `workers.dev` API is cross-site, so it is not a reliable production configuration for the `SameSite=Lax` login session.

3. In Google Cloud, register both redirect URLs:

   ```text
   https://api.example.com/auth/google/callback
   https://api-staging.example.com/auth/google/callback
   ```

4. Set each Worker environment's secrets interactively. Never add them to `wrangler.jsonc`, source code, GitHub Pages variables, or command arguments.

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID --env staging
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
   npx wrangler secret put GOOGLE_CLIENT_ID --env production
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
   ```

5. In the GitHub repository, create the public Actions variable `VITE_API_ORIGIN` with the production API origin, for example `https://api.example.com`. Set `VITE_BASE_PATH` to `/` when using a custom Pages domain, or leave it unset to use `/<repository-name>/` for the default GitHub Pages URL.

6. In **Settings → Pages**, select **GitHub Actions** as the publishing source. Configure the Pages custom domain `app.example.com` there if you use one.

7. Add the GitHub environment secret `CLOUDFLARE_API_TOKEN` to both `staging` and `production`. Give the token only the Workers/D1 permissions needed for this project.

## Deployment order

1. Trigger **Deploy API** manually for `staging`. The workflow applies D1 migrations before deploying the Worker.
2. Verify the staging Google login, UPC lookup, offline queue, sync, history, and product library.
3. Trigger **Deploy web** by merging to `main`, after `VITE_API_ORIGIN` is correct.
4. Repeat the same API workflow for `production`, then run the release checklist below.

The API workflow never runs automatically on a source push. This prevents a code change from changing production schema or Worker code without an explicit environment approval.

## QA checklist

- Google login returns to the exact app origin and logout invalidates the session.
- A known UPC finds a D1 product; a new UPC either imports public Big C data or offers manual entry without bypassing bot protection.
- In Safari and Home Screen mode on iPhone: look up a product, enter Airplane Mode, save a purchase, reconnect, and confirm exactly one record appears in History.
- Confirm pending-sync count is visible and the app warns when persistent storage is unavailable.
- Confirm one account cannot see another account’s history or product totals.
- Test the installed PWA after a successful online load and one refresh; app assets should reopen from the service-worker cache when the network is unavailable.
- Check the API Worker logs after staging and production smoke tests.

## CI and rollback

- **Verify** runs Worker type generation validation, TypeScript checks, API tests, and production dry-run builds on pull requests and pushes to `main`.
- **Deploy web** publishes only the built `apps/web/dist` artifact to GitHub Pages.
- **Deploy API** is manual, environment-gated, and runs D1 migrations before Worker deployment.

To investigate or roll back a Worker release:

```bash
npx wrangler versions list --env production
npx wrangler rollback --env production
```

Before a schema-changing release, export a D1 backup according to your operational policy. Review Cloudflare's D1 and Worker routing documentation for current commands and configuration behavior.


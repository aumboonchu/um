# Big C link → SKU import

Updated: 2026-10-25

## Implemented behavior

1. An authenticated, online user pastes a full Big C product URL in Add Purchase.
2. `POST /api/v1/products/import-bigc` validates the app origin and the bounded JSON body.
3. The API canonicalizes the HTTPS Big C URL and resolves the numeric product ID. It checks the unique D1 source mapping first.
4. For a new source ID, it reads public structured product JSON (JSON-LD / embedded Next data), requiring matching source identity. No JavaScript from the source is executed.
5. One D1 batch creates the product, source mapping, and reference-price snapshot. Repeating the same source ID—including language or tracking-link variants—reuses the existing product. An existing verified UPC reuses the existing product instead of adding a duplicate.
6. A new linked product has an internal SKU such as `BIGC-2354252`. UPC is optional and comes only from explicit GTIN/UPC/barcode data, not a retailer SKU or URL suffix.

The original UPC lookup/manual flow remains available. History/search includes SKU. Purchases and sync identify products by their stable product ID, so a SKU-only product can be purchased and synced.

## Safety and data migration

- Only the exact HTTPS host `www.bigc.co.th` and `/product/<slug>.<id>` or `/en/product/<slug>.<id>` are allowed. No credentials, nonstandard ports, short links, search links, arbitrary hosts, or cross-product redirects.
- Tracking queries/fragments are stripped. Redirects are manual, same-product validated, and bounded. Responses have an 8-second deadline and a streamed 512 KiB size limit.
- Missing/unmatched product identity, source errors, and Challenge pages create no product. The importer does not invent names/barcodes or silently fall back to unrelated recommendations.
- Prices are reference snapshots with timestamps, not guaranteed current store prices. Actual purchase price remains user-confirmed.
- `0004_product_skus.sql` avoids parent-table rebuild/drop, preserving legacy product IDs, barcode values, purchases, overrides, and source snapshots.
- IndexedDB v2 adds an ID-keyed cache and copies old records without deleting the legacy store, queued operations, or metadata. Multiple products with null UPC have distinct cache keys.
- No new paid services, browser automation subscription, CAPTCHA bypass, or source credentials are introduced.

## Verification and limits

- Local API regression suite: 58 tests; web IndexedDB suite: 6 tests (64 total).
- Tests cover URL/redirect validation, identity checks, blocked imports with no database writes, repeat/concurrent imports, existing UPC reuse, SKU-only purchase/history/sync, schema preservation, v1-to-v2 cache migration, and quota-error retention.
- Source HTML fixtures are synthetic and labelled as such. A passing parser test is not a successful live import.
- Direct live probe of a public Big C product page on 2026-10-25 returned HTTP 403 with `cf-mitigated: challenge` and no structured product JSON. Successful live Big C extraction remains unverified; sending a URL does not remove that restriction.
- A full link is required; mobile short links are intentionally rejected rather than followed through untrusted hosts.
- The source may omit fields or change its structure. Appropriate reuse permissions must be confirmed before a broader rollout.
- Account binding/reopening offline and iPhone Safari/Home Screen QA remain separate existing work; this change does not mark those complete.
- Real deployed-browser check: Google login and the link-entry form work. Importing the public test product link returns the explicit Big C blocked message rather than a fabricated product. A stale v1 app tab initially blocked the IndexedDB upgrade; closing that old agent-created test tab allowed recovery without clearing browser data. A regression test covers this case, and the UI now explains the action to take and shows an unknown pending count if the queue cannot be read.

## Rollout

Staging migration 0004 and the matching Worker were deployed successfully on 2026-10-25. Worker version: `241eaf8f-11d1-4d99-bbef-d43abd881574`. Health and Google-login readiness both return HTTP 200. Aggregate row counts are unchanged (1 user, no products/purchases/source snapshots), and `PRAGMA foreign_key_check` returns no violations. Production was not changed.

Apply migration 0004 and deploy the matching API to staging before publishing the frontend. Do not apply to production without its separate release configuration and checks. The older API's inserts are not compatible with the new SKU requirement, so coordinate the migration/API deployment window. Stop on any migration failure.

A private pre-migration staging SQL backup was saved locally under the ignored `work/` backup filename pattern; it is not part of the GitHub publication. Do not roll back the API alone to the pre-SKU implementation after migrating the schema; a rollback needs a separately reviewed compatible schema/data plan.


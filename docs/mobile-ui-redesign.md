# SmartCart mobile UI — 28 October 2026

Implements the approved “Less is more” [Figma design](https://www.figma.com/design/9a03R9XRaCcrpwFkQnja0y?node-id=19-64) using the existing React / TypeScript / CSS app and existing staging API. Hosting remains GitHub Pages; no D1 migration, Worker deployment, new authentication provider or paid service is introduced.

## Experience

- Three bottom tabs: ซื้อสินค้า / รายงาน / สินค้า. Account details move behind the avatar.
- Scan-first empty and saved-round entry, separate numeric barcode entry, minimal new-product form, and focused quantity/price entry with a stepper.
- A missing barcode opens product registration. Screenshot import still supports Big C / Makro Pro, preserves the scanned UPC, and never treats retailer Code as a barcode.
- Cart rows open editing; removal is available before payment. Checkout uses a clear final “ยืนยันชำระแล้ว” action. It records payment only; no money is transferred.
- Confirmation is tied to the draft revision. Changes from another tab disable checkout until the revised total is reviewed.
- Completion distinguishes local/pending from D1-confirmed success. New-round actions open an empty draft without hiding the pending-sync warning.
- Reports use separate round rows, immutable receipt snapshots and CSV. Legacy purchases remain accessible through a disclosure, not regrouped into invented rounds.
- Google session persistence and account-scoped IndexedDB, UUIDs, retries, validation and API ownership checks are retained.

## Design implementation

- Original exported SVGs are bundled locally, with their intrinsic dimensions retained; no temporary Figma URLs are runtime dependencies.
- IBM Plex Sans Thai is bundled, with its OFL license in `public/licenses/`.
- Responsive widths include 320 / 390 / 440 px. Primary controls are 56 px high; smaller actions are at least 48 × 48 px.
- Safe-area insets, Visual Viewport sizing, contextual actions and native numeric/decimal input modes replace the mock phone status bar and keyboard. Device chrome is not rendered as fake web UI.
- Real camera frames replace the prototype's sample barcode after camera startup. Flash is capability-gated. Existing ZXing decoding and track cleanup remain intact.
- Shell cache v3 removes only outdated `smartcart-shell-*` caches. It does not clear IndexedDB, authentication storage or outboxes. Cross-origin API/account requests are not cached.

## Verification

- 272 frontend tests pass, including 15 DOM journeys, 38 asset checks, account switching, multiple lines, frozen-payload retry, stale-tab confirmation, screenshot UPC handling and cache upgrade safety.
- Frontend typecheck and production build pass.
- Browser QA used a local-only synthetic-data harness; no test purchases were inserted in the staging D1 database. The harness is not part of the release source or built app.
- Mobile viewport checks found no horizontal overflow or visible button smaller than 48 px; rendered SVG dimensions match the exported assets.
- Safari / Home Screen, actual camera/torch permissions and real iPhone keyboard behavior still need physical-device validation. Browser viewport checks are not physical iPhone tests.
- Existing dependency advisories remain, including development/test tooling; no forced major dependency upgrade is included.

The existing cold-offline authentication limitation remains: a fresh app session still needs online account verification. Do not promise that unsynced device data cannot be lost.

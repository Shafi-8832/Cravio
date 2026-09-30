# Project review and implemented scope

The existing app already had a useful relational foundation: custom JWT authentication, four roles, restaurant/menu data, modifier choices, PostgreSQL checkout, reviews and an order/delivery model. The major missing work was a coherent frontend, safe setup/migrations, customer account features, operational dashboards, concurrency handling and a trustworthy catalog.

## Important findings addressed

| Finding | Resolution |
|---|---|
| Existing setup could run destructive schema resets | Added a migration runner that bootstraps only an empty schema, then applies checksummed additive migrations in a transaction. |
| Role claims and expired/revoked sessions needed consistent handling | Protected routes resolve the current active user's role from PostgreSQL; revoked/expired tokens fail correctly. No token logging. |
| Concurrent cart changes, checkouts and rider claims could conflict | Cart-parent/checkout row locks serialize mutations; only one checkout/claim commits. Price and modifier totals remain authoritative on the server. |
| Historical receipts depended on mutable menu data | Order items snapshot dish names, photos, prices and modifier selections. Delivery fees are stored on the order. |
| Delivery completion needed atomic multi-table updates | A PostgreSQL procedure completes delivery/order, settles COD and updates rider availability in the same transaction. |
| Manual wallet references could be treated as payment proof | References do not mark payments paid. Owner/admin confirmation is explicit; paid records cannot silently reverse and references are serialized against duplicate reuse. Manual payments are disabled by default. |
| Paid cancellation needed a refund implementation | API returns REFUND_REQUIRED instead of pretending a refund happened. Gateway refunds remain outstanding. |
| Customer addresses/favorites/support were missing | Added ownership-checked account routes, concurrent default-address handling, favorite uniqueness and support tickets. |
| Unassigned jobs exposed too much delivery information | Riders see full customer delivery details only after a successful claim. |
| Frontend fallback invented real-business details | Removed fabricated branch data, ratings, reviews, IDs and prices. API failures now show real errors. Real listings come from attributed official snapshots. |

## Implemented feature matrix

| Customer | Restaurant owner | Rider | Administrator |
|---|---|---|---|
| Signup/login/logout, profile and addresses | Role-specific studio and sales summary | Availability and vehicle profile | Role-specific summary and all-order view |
| Division/cuisine/search filters and pagination | Restaurant metadata/photo editing | Available jobs filtered by division | User list and suspension/reactivation |
| Real directory/menu previews and favorites | Branch creation/open/close, division/fee/minimum/ETA fields | Atomic order claiming | Promotion creation and activation |
| Persistent cart and menu modifiers | Category and menu item creation/editing | Pickup/delivery transitions | Support replies and resolution |
| COD checkout, promo validation | Food photos, veg/availability and modifier management | Active/history views and refresh | Receipt/payment inspection |
| Receipts, status timeline and order history | Accept/reject/prepare order workflow | COD collection reflected on completion | Manual wallet verification when enabled |
| Eligible cancellation and delivered-order reviews | Receipt/manual payment verification | Completed-fee summary | Database role/ownership enforcement |
| Support requests and replies | Support requests | Support requests | API validation and filtered queries |

Shared frontend: cream, coral/orange and deep green styling; floating food emoji; cuisine icons; responsive card/menu layouts; food images throughout menus/cart/receipts; accessible labels, inline errors and loading states. Live order pages poll periodically rather than claiming websocket tracking.

## Verification performed

- **The backend integration suites passed** against an isolated PostgreSQL 16 review database: `backend/tests/e2e.js` (order lifecycle, modifiers, reviews), `marketplace.js` (marketplace, auth, concurrency), `operations.js` (dashboards, support, promos) and `tracking.js` (branch pins, rider location, tracking authorization). Run them with `npm run test:backend` against a `TEST_DATABASE_URL` whose name ends in `_test` or `_review`; the harness refuses to target the application database.
- **The catalog/Places unit tests passed** (`backend/tests/catalog.test.js`, `brandCatalog.test.js`): every catalog entry, every referenced local asset, eight divisions, directory state, live import photo requirements, signed cursor/photo handling and server-side API-key isolation. They use fixture responses and make no Google API calls.

The counts in this section are from the review session that produced this document; re-run the suites for current numbers.
- Frontend ESLint and production Vite build passed.
- All **304 official photo/logo files** were downloaded and checked for an image MIME type. The 139-branch real catalog imported successfully into the separate preview database.
- A desktop homepage and official restaurant detail page were visually inspected; real-name search, source links, logos, gallery and menu preview state were checked in the browser. The full mobile/browser interaction matrix and a live Google Places account have not been verified.
- Your application database and existing `.env` were not replaced. Test seeds and test orders used a separate database on port 55439 during this session.

The backend tests create database users/orders, so run them only through the guarded test harness with a disposable target. The Google unit tests use fixture responses and make no Google API calls.

## Remaining work before real commercial operation

These are missing integrations or operational policies, not features implied to be finished by the UI:

1. **Verified merchant onboarding:** identity/business verification, approval and suspension policy, pairing existing directory entries with the true owner, approved photo rights, branch-specific current menus/taxes and order acceptance contracts. Public owner signup is a coursework workflow, not business verification.
2. **Payment provider integration:** real bKash/Nagad/other checkout sessions, signature-verified webhooks, idempotent settlement, reconciliation, partial/full refunds, merchant payouts and rider cash remittance. Current summaries show gross recorded amounts/fees, not accounting profit or actual paid-out earnings.
3. **Location and dispatch:** delivery zones, geocoding, automatic assignment/redispatch and proof of delivery. Branch map pins, "restaurants near me", rider GPS reporting, a live tracking map with distance/ETA and an admin live-delivery board are implemented — see [live-tracking.md](live-tracking.md). Road distance and duration come from the free public OSRM demo server, which is not a production dependency, and riders still claim jobs themselves rather than being dispatched.
4. **Identity and recovery:** email/phone verification, password *reset* for a locked-out user (an authenticated password *change* exists, `PATCH /api/account/password`) and appropriate staff/admin account protection. The current browser token store is localStorage; harden session handling and add a restrictive deployment CSP before public operation.
5. **Notifications and support operations:** email/SMS/push, durable event jobs/retries, support SLAs, escalation, cancellations after acceptance, refunds and dispute processes. In-app support tickets are present; outgoing communication is not configured.
6. **Catalog completeness:** the official starter has 139 branches (four chains), not every restaurant or 60+ per area. Enable a permitted live directory and obtain owner submissions for the remaining coverage. Catalog snapshots need reviewed updates.
7. **Business controls:** merchant/rider approval screens, scheduling/holidays, inventory/stock counts, variants with merchant-specific taxes, commissions/payout ledger, coupon abuse policies and full audit logs. Branch delivery settings are available on creation; a dedicated branch-settings editor is not included.
8. **Deployment operations:** HTTPS, reverse-proxy configuration, shared rate limiting, managed secrets, backups/restore drills, monitoring, migrations in CI, object storage/image validation, dependency update checks, production terms/privacy and accessibility/device testing. No deployment was performed.

This is a working local full-stack foundation, with honest boundaries around the remaining external services and real-world operations.

See also: [API.md](API.md) for the endpoint list and [DATABASE.md](DATABASE.md) for the schema and database objects.

# API reference

All endpoints are mounted in [`backend/server.js`](../backend/server.js) under
`/api/...`. Request and response bodies are JSON.

**Auth column**

- `—` — no token required.
- `Token` — a valid `Authorization: Bearer <jwt>` header is required.
  `backend/middleware/auth.js` verifies the signature and then checks the
  database on every request, so a logged-out token (its `jti` is in
  `revoked_tokens`) gives 401 and a suspended account gives 403 immediately.

**Role column** — the role allowlist enforced by `requireRole(...)`. Where a
row also says *(own …)*, the handler additionally checks that the object
belongs to the caller, so guessing an id in the URL returns 403 or 404 rather
than someone else's data.

Status codes used throughout: 200, 201, 204, 400, 401, 403, 404, 409, 500.

---

## Auth — `backend/routes/auth.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| POST | `/api/auth/signup` | — | public | Creates a `customer`, `restaurant_owner` or `rider`. The role is taken from a server-side allowlist; `admin` is rejected. Rate-limited. |
| POST | `/api/auth/login` | — | public | Checks email + password, compares the role card the visitor clicked against the role stored on the row, and returns a JWT carrying a `jti`. Rate-limited. |
| POST | `/api/auth/logout` | Token | any | Inserts the token's `jti` into `revoked_tokens`, so that exact token stops working on the next request. |

## Restaurants — `backend/routes/restaurants.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/restaurants` | — | public | Paginated restaurant list with division, cuisine and search filters, plus branch counts and the stored rating. |
| GET | `/api/restaurants/mine` | Token | restaurant_owner | The signed-in owner's own restaurants and their branches. |
| GET | `/api/restaurants/nearby?lat=&lng=&radius_km=` | Token | any | Branches within the radius of a point, closest first. Distance comes from the `distance_km()` SQL function. |
| GET | `/api/restaurants/:id` | — | public | One restaurant with its branches and menu categories. |
| GET | `/api/restaurants/:id/reviews/summary` | Token | any | Star breakdown (how many 1★ … 5★), total and average, aggregated in one query. |
| GET | `/api/restaurants/:id/reviews?limit=&offset=` | Token | any | One page of that restaurant's reviews, newest first, with reviewer names. |
| POST | `/api/restaurants` | Token | restaurant_owner, admin | Creates a restaurant owned by the caller. |
| POST | `/api/restaurants/:id/branches` | Token | restaurant_owner (own), admin | Adds a branch with division, delivery fee, minimum order and ETA. |
| PATCH | `/api/restaurants/branches/:branchId/toggle` | Token | restaurant_owner (own), admin | Opens or closes one branch. |
| PATCH | `/api/restaurants/branches/:branchId/location` | Token | restaurant_owner (own), admin | Sets the branch's map pin — the pickup point used by "near me" and live tracking. |
| PATCH | `/api/restaurants/:id` | Token | restaurant_owner (own), admin | Edits restaurant metadata and photo. |

`/nearby` is declared before `/:id` on purpose, otherwise Express would read
`nearby` as an id.

## Menu — `backend/routes/menu.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/menu/restaurants/:restaurantId` | — | public | The full menu: categories, items, modifier groups and options. |
| POST | `/api/menu/restaurants/:restaurantId/categories` | Token | restaurant_owner (own), admin | Adds a menu category. |
| POST | `/api/menu/categories/:categoryId/items` | Token | restaurant_owner (own), admin | Adds a dish to a category. |
| PATCH | `/api/menu/items/:itemId` | Token | restaurant_owner (own), admin | Edits a dish (name, price, photo, veg flag). |
| PATCH | `/api/menu/items/:itemId/toggle` | Token | restaurant_owner (own), admin | Marks a dish available or unavailable. |
| DELETE | `/api/menu/items/:itemId` | Token | restaurant_owner (own), admin | Removes a dish. |
| POST | `/api/menu/items/:itemId/modifier-groups` | Token | restaurant_owner (own), admin | Adds a choice group ("Size", "Add-ons") to a dish. |
| POST | `/api/menu/modifier-groups/:groupId/options` | Token | restaurant_owner (own), admin | Adds one option to a choice group, with its price delta. |
| PATCH | `/api/menu/modifier-options/:optionId/toggle` | Token | restaurant_owner (own), admin | Marks one option available or unavailable. |
| DELETE | `/api/menu/modifier-groups/:groupId` | Token | restaurant_owner (own), admin | Removes a choice group. |

Ownership on every write here is resolved by walking
`menu_items → menu_categories → restaurants.owner_id`.

## Cart — `backend/routes/cart.js`

One cart per `(user_id, restaurant_id)`, so a customer may hold several carts
at once and every read is keyed by restaurant.

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/cart/:restaurantId` | Token | customer | The caller's cart for that restaurant, with lines, chosen modifiers and server-computed totals. |
| POST | `/api/cart/:restaurantId/items` | Token | customer | Adds a dish with its chosen modifiers. Prices are read from the database, never from the request. |
| PATCH | `/api/cart/items/:itemId` | Token | customer | Sets a line's quantity. |
| PATCH | `/api/cart/items/:itemId/adjust` | Token | customer | Increments or decrements a line. |
| DELETE | `/api/cart/items/:itemId` | Token | customer | Removes a line. |

## Orders — `backend/routes/orders.js` (all DB work in `backend/services/orderService.js`)

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| POST | `/api/orders` | Token | customer | Checkout. Calls the `place_order()` SQL function, which validates cart, branch and promo code and turns the cart into an order in one transaction. |
| GET | `/api/orders/my-orders?status=&page=&limit=` | Token | customer | The caller's own order history. |
| GET | `/api/orders/restaurant?status=&branch_id=&page=&limit=` | Token | restaurant_owner | Orders placed at the caller's own branches. |
| GET | `/api/orders/:id/tracking` | Token | customer, rider, restaurant_owner, admin *(this order only)* | Live map snapshot: rider position, distance remaining, ETA and whether the GPS signal is stale. Polled every 5 s. |
| GET | `/api/orders/:id/route` | Token | customer, rider, restaurant_owner, admin *(this order only)* | The planned road route from branch to drop-off, fetched from OSRM once and cached in `order_routes`. |
| GET | `/api/orders/:id` | Token | customer (own), restaurant_owner (own branch), admin | One receipt: items, modifiers, payment, delivery and the status timeline. |
| PATCH | `/api/orders/:id/status` | Token | restaurant_owner (own), admin | Moves the order forward along the whitelisted owner transitions. |
| PATCH | `/api/orders/:id/cancel` | Token | customer (own) | Cancels an order that is still cancellable. A paid order returns `REFUND_REQUIRED` instead of pretending to refund. |

Literal paths (`/my-orders`, `/restaurant`) are declared before `/:id`.

## Rider — `backend/routes/rider.js` — `router.use(authenticateToken, requireRole('rider'))`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/rider/profile` | Token | rider | The caller's availability and vehicle details. |
| PATCH | `/api/rider/profile` | Token | rider | Updates availability (`online`/`offline`) and vehicle details. |
| GET | `/api/rider/deliveries/available` | Token | rider | Unclaimed jobs in the rider's division. Customer contact details are withheld until the job is claimed. |
| GET | `/api/rider/deliveries/mine` | Token | rider | The caller's active and past deliveries. |
| PUT | `/api/rider/location` | Token | rider | Upserts "where I am now". The rider id comes from the token, never the body, so a rider can only move themselves. 204 on success. |
| POST | `/api/rider/deliveries/:orderId/accept` | Token | rider | Claims a job. Takes row locks so two riders cannot claim the same order and one rider cannot hold two. 201, or 409 if unclaimable. |
| PATCH | `/api/rider/deliveries/:orderId/status` | Token | rider (own delivery) | `assigned → picked_up → delivered`. The final step calls the `complete_delivery()` procedure. |

## Payments — `backend/routes/payments.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/payments/:orderId` | Token | the order's customer, its restaurant owner, or admin *(checked in the handler)* | The payment record for one order. |
| POST | `/api/payments/:orderId/reference` | Token | customer (own order) | Records a bKash/Nagad transaction reference. Deliberately does **not** mark the payment paid. |
| PATCH | `/api/payments/:orderId/status` | Token | restaurant_owner (own), admin | The verification step: the restaurant records whether the money actually arrived. |

Manual wallet payments are off unless `ALLOW_MANUAL_PAYMENTS=true`.

## Reviews — `backend/routes/reviews.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| POST | `/api/reviews/orders/:orderId` | Token | customer (own, delivered order) | Writes the meal review. The `trg_sync_restaurant_rating` trigger recomputes the restaurant's stored rating in the same transaction. |
| POST | `/api/reviews/orders/:orderId/rider` | Token | customer (own, delivered order) | Stars and an optional comment about the rider. Independent of the meal review. |
| GET | `/api/reviews/restaurants/:restaurantId` | — | public | Reviews for one restaurant, newest first, plus the rating summary. |

Rider reviews are write-only for everyone except the admin: no customer, owner
or rider endpoint selects `rider_reviews`. The only reader is
`GET /api/admin/rider-reviews`.

## Owner dashboard — `backend/routes/owner.js` — `router.use(authenticateToken, requireRole('restaurant_owner'))`

The analytics routes also run `requireOwnedRestaurant`, and every analytics
query repeats `AND r.owner_id = $2`, so ownership is enforced twice.

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/owner/analytics/:restaurantId` | Token | restaurant_owner (own) | All reports below in one response. |
| GET | `/api/owner/analytics/:restaurantId/headline` | Token | restaurant_owner (own) | Orders, revenue, average basket and rating for the date range. |
| GET | `/api/owner/analytics/:restaurantId/revenue` | Token | restaurant_owner (own) | Revenue per day. |
| GET | `/api/owner/analytics/:restaurantId/top-items` | Token | restaurant_owner (own) | Most-ordered dishes by quantity and revenue. |
| GET | `/api/owner/analytics/:restaurantId/busiest-hours` | Token | restaurant_owner (own) | Order counts grouped by hour of day. |
| GET | `/api/owner/analytics/:restaurantId/status-breakdown` | Token | restaurant_owner (own) | Order counts per status. |
| GET | `/api/owner/reviews?rating=&unreplied=&sort=&limit=&offset=` | Token | restaurant_owner | The review inbox. Ownership is enforced inside the SQL (`r.owner_id = $1`). |
| GET | `/api/owner/reviews/summary` | Token | restaurant_owner | Star distribution and reply coverage for the owner's restaurants. |
| PUT | `/api/owner/reviews/:id/reply` | Token | restaurant_owner (own) | Writes or replaces the public reply. Ownership is a condition of the `UPDATE` itself. |
| DELETE | `/api/owner/reviews/:id/reply` | Token | restaurant_owner (own) | Removes the reply. |

All date ranges pass through `backend/utils/dateRange.js`.

## Admin — `backend/routes/admin.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/admin/users?role=&page=&limit=` | Token | admin | Lists users. Password hashes are never selected. |
| PATCH | `/api/admin/users/:id/status` | Token | admin | Suspends or reactivates an account. A suspended account is blocked at login *and* on every later request. |
| GET | `/api/admin/stats` | Token | admin | Platform-wide counts of users by role, restaurants and orders by status. |
| GET | `/api/admin/deliveries/live` | Token | admin | Every order currently on the road: rider position, distance remaining, stale-signal flag. Polled every 5 s. |
| GET | `/api/admin/rider-reviews?rider_id=&page=&limit=` | Token | admin | The only endpoint that reads rider feedback: the newest-first feed plus a per-rider scorecard. |

## Admin analytics — `backend/routes/adminAnalytics.js` — `router.use(authenticateToken, requireRole('admin'))`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/admin/analytics?from=&to=` | Token | admin | Every report below in one response. |
| GET | `/api/admin/analytics/headline` | Token | admin | Orders, revenue, active customers for the range. |
| GET | `/api/admin/analytics/trend` | Token | admin | Orders and revenue per day. |
| GET | `/api/admin/analytics/top-restaurants` | Token | admin | Top restaurants by revenue, joined to their owner and stored rating. |
| GET | `/api/admin/analytics/rider-performance` | Token | admin | Deliveries completed and average delivery time per rider. |
| GET | `/api/admin/analytics/user-growth` | Token | admin | Signups per day, and the role composition. |
| GET | `/api/admin/analytics/status-breakdown` | Token | admin | Order counts per status. |

## Account — `backend/routes/account.js` — `router.use(authenticateToken)`, then `router.use(requireRole('customer'))` part-way down the file

Because Express runs middleware in registration order, the three routes above
that second `router.use` are open to every signed-in role; everything below it
is customer-only.

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/account/profile` | Token | any | Name, email, phone and role of the caller. |
| PATCH | `/api/account/profile` | Token | any | Updates name and phone. Email and role cannot be changed here. |
| PATCH | `/api/account/password` | Token | any | Changes the caller's own password after re-checking the current one. |
| GET | `/api/account/addresses` | Token | customer | The caller's saved delivery addresses. |
| POST | `/api/account/addresses` | Token | customer | Adds an address. Takes a row lock so two concurrent "make this default" requests cannot both win. |
| PATCH | `/api/account/addresses/:id` | Token | customer (own) | Edits an address. |
| DELETE | `/api/account/addresses/:id` | Token | customer (own) | Removes an address. |
| GET | `/api/account/favorites` | Token | customer | The caller's favourited restaurants. |
| PUT | `/api/account/favorites/:restaurantId` | Token | customer | Favourites a restaurant (idempotent). |
| DELETE | `/api/account/favorites/:restaurantId` | Token | customer | Un-favourites a restaurant. |

## Profile — `backend/routes/profile.js` — `router.use(authenticateToken)`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/profile` | Token | any | Branches on `req.user.role` and returns that role's dashboard summary. |
| GET | `/api/profile/customer` | Token | customer | Recent orders, addresses and favourites. |
| GET | `/api/profile/rider` | Token | rider | Availability, vehicle and delivery totals. |
| GET | `/api/profile/owner` | Token | restaurant_owner | Restaurants, branches, menu size and order totals. |
| GET | `/api/profile/admin` | Token | admin | Platform-level counts. |

## Operations — `backend/routes/operations.js` — `router.use(authenticateToken)`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/operations/tickets` | Token | any | Support tickets. Scoped in SQL: an admin sees all, anyone else sees only their own. |
| POST | `/api/operations/tickets` | Token | any | Opens a support ticket, optionally about one of the caller's orders. |
| PATCH | `/api/operations/tickets/:id` | Token | admin | Replies to or resolves a ticket. |
| GET | `/api/operations/promos` | Token | any | Active promo codes a customer may use. |
| POST | `/api/operations/promos` | Token | admin | Creates a promo code. |
| PATCH | `/api/operations/promos/:id` | Token | admin | Activates, deactivates or edits a promo code. |
| GET | `/api/operations/orders` | Token | admin | Every order on the platform, with payment state. |
| GET | `/api/operations/summary` | Token | admin, restaurant_owner, rider | Role-scoped operational totals for the caller's own dashboard. |

## Directory — `backend/routes/directory.js` (optional Google Places proxy, no database)

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/directory/config` | — | public | Whether the live directory is enabled, and the supported cities. |
| GET | `/api/directory/search` | — | public | Proxied Places search, rate-limited to 20 requests. The API key stays server-side. |
| GET | `/api/directory/photo` | — | public | Proxied Places photo, rate-limited to 400 requests, addressed by a signed token rather than a raw Places reference. |

Disabled unless `ENABLE_GOOGLE_PLACES=true` and `GOOGLE_PLACES_API_KEY` is set.
See [DATA_SOURCES.md](DATA_SOURCES.md).

## Server level — `backend/server.js`

| Method | Path | Auth | Role | What it does |
|---|---|---|---|---|
| GET | `/api/health` | — | public | Runs `SELECT 1` and reports whether the database answers. |
| GET | `/` | — | public | Plain "the API is up" response. |

---

## Public routes

Eleven endpoints have no auth middleware. Nine are read-only browsing routes
(the restaurant list and detail, the menu, public reviews, the three
`/api/directory` routes, `/api/health` and `/`). The other two are
`POST /api/auth/signup` and `POST /api/auth/login`, which cannot require a
token by definition. **Signup is the only public route that writes**; it is
rate-limited and takes the new account's role from a server-side allowlist.

## Related documents

- Database objects and schema: [DATABASE.md](DATABASE.md)
- Per-feature walkthroughs: [FLOW.md](FLOW.md)
- The map and live-tracking endpoints in depth: [live-tracking.md](live-tracking.md)
- Requirement-to-code map for the course evaluator: [COURSE-REQUIREMENTS.md](COURSE-REQUIREMENTS.md)

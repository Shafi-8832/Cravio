# Database

PostgreSQL, accessed only through raw parameterised SQL over the `pg` library
(`backend/db/pool.js`). There is no ORM and no query builder.

Schema files:

- `backend/db/schema.sql` — the base schema (22 tables). It contains a
  destructive reset and is used **only** to bootstrap an empty database.
- `backend/db/migrations/001..009_*.sql` — additive, checksummed migrations.
- `backend/db/functions/*.sql` — the triggers, functions and the procedure.
  Re-installed on every migration run with `CREATE OR REPLACE`.

`npm run db:migrate` (repo root) runs all three in that order. See
[SETUP.md](SETUP.md).

---

## Schema overview

**Identity**

- `users` — one row per account. `role` is `customer`, `restaurant_owner`,
  `rider` or `admin`, constrained by a `CHECK`. `password_hash` holds a bcrypt
  hash. `is_active` is the suspension switch.
- `rider_profiles` — one row per rider user (`user_id → users`): availability
  and vehicle details.
- `customer_addresses` — saved delivery addresses (`user_id → users`).
- `revoked_tokens` — one row per logged-out JWT (`jti`, `user_id`,
  `expires_at`). This is what makes logout real.

**Catalogue**

- `restaurants` — `owner_id → users`. Also holds the *stored* `avg_rating` and
  `review_count` (see the rating trigger below).
- `restaurant_branches` — `restaurant_id → restaurants`. A branch carries the
  division, delivery fee, minimum order, ETA, open/closed flag and the map pin
  (`latitude`, `longitude`).
- `menu_categories` — `restaurant_id → restaurants`.
- `menu_items` — `category_id → menu_categories` (and `restaurant_id` for
  direct lookups).
- `modifier_groups` — `menu_item_id → menu_items` ("Size", "Add-ons").
- `modifier_options` — `modifier_group_id → modifier_groups`, each with a
  price delta.

**Carts** — one cart per `(user_id, restaurant_id)`, so a customer may hold
several at once.

- `carts` — `user_id → users`, `restaurant_id → restaurants`.
- `cart_items` — `cart_id → carts`, `menu_item_id → menu_items`.
- `cart_item_modifiers` — `cart_item_id → cart_items`,
  `modifier_option_id → modifier_options`.

**Orders**

- `orders` — `customer_id → users`, `branch_id → restaurant_branches`,
  `rider_id → users`, `promo_code_id → promo_codes`. Status runs
  `pending → confirmed → preparing → out_for_delivery → delivered`, plus
  `cancelled`. Holds the delivery address and drop-off coordinates as a
  snapshot, and the delivery fee as charged.
- `order_items` — `order_id → orders`, `menu_item_id → menu_items`. Dish name,
  photo and unit price are **copied** here, so a later menu edit cannot
  rewrite an old receipt.
- `order_item_modifiers` — `order_item_id → order_items`,
  `modifier_option_id → modifier_options`; also snapshotted.
- `payments` — one row per order (`order_id → orders`): method, status,
  optional wallet reference, `paid_at`.
- `deliveries` — `order_id → orders`, `rider_id → users`. Its own status
  machine: `assigned → picked_up → delivered`.
- `order_events` — the append-only status timeline, written by a trigger.
- `order_routes` — one cached OSRM road route per order (`geometry`,
  `distance_m`, `duration_s`). Plain storage, no trigger.

**Reviews**

- `restaurant_reviews` — `order_id → orders`, `UNIQUE`. It stores **no**
  `restaurant_id` and no `customer_id`: the order already knows both. Anything
  relating a review to a restaurant therefore walks
  `restaurant_reviews → orders → restaurant_branches → restaurants`.
- `rider_reviews` — `order_id → orders` (`UNIQUE`), `rider_id → users`. Only
  the admin can read these back.
- `quality_flag_log` — low-rated dishes flagged from review text.

**Operations**

- `promo_codes` — code, discount, validity window, usage cap.
- `support_tickets` — `user_id → users`, optional `order_id`.
- `customer_favorites` — `(user_id, restaurant_id)`, unique.

**Live tracking**

- `rider_current_location` — `rider_id` is the primary key, so exactly one row
  per rider: where they are *now*, plus `accuracy_m` and `updated_at`.
- `delivery_location_log` — the breadcrumb trail, one row per position per
  order. **Never written by application code** — a trigger fills it.

---

## Triggers

| Name | File | What fires it | Reads | Writes | Why it exists |
|---|---|---|---|---|---|
| `trg_sync_restaurant_rating` | `backend/db/functions/restaurant_rating.sql:211` | `AFTER INSERT OR UPDATE OF rating, order_id OR DELETE ON restaurant_reviews`, `FOR EACH ROW` | `restaurant_reviews`, `orders`, `restaurant_branches` | `restaurants` (`avg_rating`, `review_count`) | Ratings are read on nearly every page and written only when a delivered order is reviewed, so they are stored on the restaurant row instead of recomputed per read. The trigger keeps the stored copy correct in the same transaction as the review change, so application code never writes those two columns. |
| `trg_record_order_event` | `backend/db/migrations/003_marketplace.sql:76` | `AFTER INSERT OR UPDATE OF status ON orders`, `FOR EACH ROW` | `orders` (`NEW`/`OLD`) | `order_events` | The status timeline must record every transition, including ones made by the `complete_delivery()` procedure or by hand in psql — not only the ones that went through an Express route. |
| `trg_log_rider_location` | `backend/db/functions/live_tracking.sql:131` | `AFTER INSERT OR UPDATE OF latitude, longitude ON rider_current_location`, `FOR EACH ROW` | `orders` | `delivery_location_log` | `delivery_location_log` is a shadow table of `rider_current_location`; as a trigger the database itself guarantees the two can never disagree, and a failed log insert rolls the position update back with it. |

All three are narrowed with `UPDATE OF <columns>` so they fire only when a
column they care about actually changes. Without that, the rating trigger
would recompute an average every time an owner saved a review *reply*, and the
location trigger would add a phantom point to a customer's trail when only
`accuracy_m` was touched.

## Functions

| Name | File | Called by | Reads | Writes | Why it exists |
|---|---|---|---|---|---|
| `restaurant_avg_rating(p_restaurant_id INTEGER) → NUMERIC` <br> `LANGUAGE sql STABLE` | `backend/db/functions/restaurant_rating.sql:50` | `sync_restaurant_rating()` and the one-time backfill at the bottom of the same file | `restaurant_reviews`, `orders`, `restaurant_branches` | — | The "returns a computed statistical value" function. It owns the three-table walk from review to restaurant in one place, so the trigger and the backfill cannot drift apart. |
| `sync_restaurant_rating() → TRIGGER` <br> plpgsql | `backend/db/functions/restaurant_rating.sql:88` | `trg_sync_restaurant_rating` | `orders`, `restaurant_branches`, `restaurant_reviews` | `restaurants` | Works out which restaurant(s) a review change affects — an `UPDATE` that re-points a review touches two — and rewrites their stored rating and count. |
| `record_order_event() → TRIGGER` <br> plpgsql | `backend/db/migrations/003_marketplace.sql:65` | `trg_record_order_event` | `orders` (`NEW`/`OLD`) | `order_events` | Appends one timeline row on insert, and one more whenever the status actually changes (`IS DISTINCT FROM`). |
| `log_rider_location() → TRIGGER` <br> plpgsql | `backend/db/functions/live_tracking.sql:92` | `trg_log_rider_location` | `orders` | `delivery_location_log` | One `INSERT ... SELECT` copies the new position into the trail of every order that rider is carrying with status `out_for_delivery`. An idle rider inserts nothing. |
| `distance_km(lat1, lng1, lat2, lng2) → NUMERIC` <br> `LANGUAGE sql IMMUTABLE STRICT` | `backend/db/functions/live_tracking.sql:42` | `GET /api/restaurants/nearby`, the order tracking query in `backend/services/orderService.js`, and the admin live board in `backend/routes/admin.js` | — | — | Haversine great-circle distance. It lives in SQL because the database does the "within 5 km, closest first" filtering and sorting; computing it in JavaScript would mean shipping every branch to Node first. `STRICT` returns `NULL` for a rider with no fix yet. |
| `place_order(p_customer_id, p_branch_id, p_delivery_address, p_payment_method, p_promo_code) → TABLE(...)` <br> plpgsql | `backend/db/functions/place_order.sql:20` | `backend/services/orderService.js` — `SELECT ... FROM place_order($1,$2,$3,$4,$5)` | `users`, `restaurant_branches`, `carts`, `cart_items`, `cart_item_modifiers`, `menu_items`, `modifier_groups`, `modifier_options`, `promo_codes` | `orders`, `order_items`, `order_item_modifiers`, `payments` | Checkout. It validates the customer, branch, cart and promo code, computes the totals from database prices, and converts the cart into an order — all in one round trip, so no partly-created order can exist. Failures are `RAISE EXCEPTION` with named codes (`CART_EMPTY`, `BRANCH_CLOSED`, `PROMO_CODE_EXPIRED`, …) which `CHECKOUT_ERROR_MAP` in `orderService.js` maps to an HTTP status and a client-facing code. |

## Procedures

| Name | File | Called by | Reads | Writes | Why it exists |
|---|---|---|---|---|---|
| `complete_delivery(p_order_id INTEGER, p_rider_id INTEGER)` <br> plpgsql, `SECURITY INVOKER`, `SET search_path = public, pg_temp` | `backend/db/functions/complete_delivery.sql:3` | `backend/routes/rider.js` — `CALL complete_delivery($1, $2)` inside that route's transaction, when a rider marks a delivery delivered | `rider_profiles`, `orders`, `deliveries` (all `FOR UPDATE`), `payments` | `deliveries`, `orders`, `payments`, `rider_profiles` | "Delivered" is four writes that must all happen or none: close the delivery, mark the order delivered and review-eligible, settle cash-on-delivery, and put the rider back to `online`. It takes the row locks itself, so the same logic is safe from any caller — not only the Express route. |

## Views

None. The project has no views.

## Complex queries

The multi-table/aggregate queries are marked in the source with a
`GRADED COMPLEX QUERY` comment. The main ones:

| Query | File | Shape |
|---|---|---|
| Top restaurants by revenue | `backend/routes/adminAnalytics.js` (`TOP_RESTAURANTS_SQL`) | `orders → restaurant_branches → restaurants → users`, aggregated, joined to the stored rating |
| Most-ordered items | `backend/routes/owner.js` (`TOP_ITEMS_SQL`) | `order_items → orders → menu_items → restaurant_branches → restaurants`, `SUM`/`COUNT`, ordered |
| Rider performance | `backend/routes/adminAnalytics.js` (`RIDER_PERFORMANCE_SQL`) | `deliveries → orders → users`, average delivery time per rider |
| Restaurants near me | `backend/routes/restaurants.js` (`GET /nearby`) | branch/restaurant join with `distance_km()` in a subquery, filtered and sorted by the computed distance |
| Star breakdown | `backend/routes/restaurants.js` (`GET /:id/reviews/summary`) | a generated 1–5 star series `LEFT JOIN`ed to the reviews, with window functions for totals and percentages |
| Live delivery board | `backend/routes/admin.js` (`GET /deliveries/live`) | CTE over `deliveries → orders → users → restaurant_branches` plus `rider_current_location`, aggregated into one summary row |
| Order tracking snapshot | `backend/services/orderService.js` (`getOrderTracking`) | order/branch/rider/location join; distance, ETA and the stale-signal flag all computed in SQL |
| Owner revenue, busiest hours, status breakdown | `backend/routes/owner.js` | date-bucketed aggregates, each repeating `AND r.owner_id = $2` |

## Transactions

Every multi-statement write opens an explicit transaction:
`pool.connect()` → `BEGIN` → statements → `COMMIT`, with `ROLLBACK` in the
`catch` and `client.release()` in `finally`. There are 42 such blocks across
`backend/routes` and `backend/services`; `grep -rn "BEGIN" backend/routes
backend/services` lists them. `backend/routes/auth.js` (signup) is the
reference example.

Concurrency is handled with row locks rather than application checks:
`SELECT ... FOR UPDATE` on the cart parent at checkout, on the rider profile
and order when a rider claims a job, on the user row when an address is made
default, and inside `complete_delivery()`.

## Related documents

- Endpoint reference: [API.md](API.md)
- Per-feature walkthroughs: [FLOW.md](FLOW.md)
- The map and live tracking, in depth: [live-tracking.md](live-tracking.md)
- Requirement-to-code map for the course evaluator: [COURSE-REQUIREMENTS.md](COURSE-REQUIREMENTS.md)

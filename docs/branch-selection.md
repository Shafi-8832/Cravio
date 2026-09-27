# Automatic branch selection by location

When a customer opens a restaurant, Cravio picks the **nearest branch that is
open and whose delivery radius covers the customer**, shows which branch was
chosen, and lets the customer change it. The **database is the final judge**:
an order can never be stored for a branch that cannot deliver to the order's
delivery pin, no matter which code path tries to insert it.

A few words used below:

- **Branch** — one physical outlet of a restaurant (`restaurant_branches`). A
  restaurant such as Sultan's Dine has several.
- **Pin** — a latitude/longitude pair: one point on the map.
- **Delivery radius** — how far (in km, straight line) a branch will deliver.
- **Function** — SQL code stored in the database that returns a value or rows.
- **Trigger** — SQL code the database runs *by itself* when a row is inserted,
  updated or deleted.
- **Transaction** — a group of SQL statements that either all succeed
  (`COMMIT`) or are all undone (`ROLLBACK`).
- **SQLSTATE** — a five-character error code PostgreSQL attaches to every
  error. We invent our own: `CRV01`.

---

## 1. What already existed (Phase 0 findings)

| Question | Answer |
|---|---|
| Branch table? | Yes: `restaurant_branches`, linked by `restaurant_id → restaurants(id)`. |
| Where do coordinates live? | **Only on branches** (`restaurant_branches.latitude/longitude`, `DECIMAL(9,6)` with range and "both or neither" CHECKs from migration 008). `restaurants` has no coordinates. |
| Do orders reference a branch? | Yes: `orders.branch_id` (foreign key). There is no `orders.restaurant_id`; the restaurant is always found through the branch. |
| Menus per branch or per restaurant? | Per **restaurant** (`menu_items.restaurant_id`). Every branch serves the same menu, so switching branch keeps the cart. |
| Active flag / hours / radius? | No branch-level active flag (we use `restaurants.ordering_enabled` + the owner's `users.is_active`, exactly like `place_order()`); a manual `is_open` switch; **no** hours and **no** radius → added by this feature. |
| Database timezone | `GMT` (`SHOW timezone;`) — that is why the hours check converts to `Asia/Dhaka`. |

---

## 2. The full flow

1. **Location.** The customer opens a restaurant page. `LocationContext`
   (shared by every page) asks the browser for the GPS position **once per
   session**. If the customer refuses, it falls back to their saved delivery
   address that has a map pin. The result is `{ lat, lng, source }` and is
   kept in `sessionStorage`, so other pages do not ask again.
2. **Ask the server.** The page calls
   `GET /api/restaurants/:id/branches?lat=..&lng=..`.
   *Middleware* (code that runs before the route handler) checks the login
   token: no token → **401**. The handler then checks that the id is a positive
   integer and that `lat`/`lng` are real numbers in range (`"abc"`, `NaN`,
   `Infinity`, `95` → **400**), and that the restaurant exists (→ **404**).
3. **The function decides.** The handler runs one query:
   `SELECT ... FROM branches_by_distance($1, $2, $3)`. The function computes
   each branch's distance, whether it is open, and whether it can deliver, and
   sorts the rows "can deliver first, then nearest first".
4. **Auto-select.** The server returns
   `{ selected_branch_id, branches }`, where `selected_branch_id` is the first
   row with `can_deliver = true` (or `null` if none). The page stores that id
   in the cart state (`CartContext`, as `restaurant.branch_id`) and shows
   *"Delivering from Dhanmondi, Dhaka · 0.2 km away · Change"*.
   - **Change** opens every branch in the returned order with its distance and
     a *Closed* or *Out of delivery range* badge. Those that cannot deliver are
     visible but disabled.
   - **No branch can deliver** → *"No branch of X delivers to your location
     right now"*; the menu is still browsable but "Add" is disabled.
   - **No location at all** → the page asks the customer to allow location
     access (with a "try again" button) or set a pin at checkout, and lists all
     branches without selecting one.
5. **Cart.** The cart is tied to one branch. Because menus are shared by every
   branch, switching branch **keeps the items** (no "your cart will be
   cleared" dialog is needed; it would only be needed if menus were
   per-branch).
6. **Checkout pin.** On `/checkout` the customer must set a drop-off pin
   (starting from a saved address or their last location). Every time the pin
   is set or moved, the page calls `/branches` again **with the pin's
   coordinates** (not the device's). If the cart's branch cannot deliver to
   the pin, a warning explains why and offers *"Switch to <suggested branch>"*
   (the bag is kept).
7. **Order insert.** "Place order" sends `branch_id`, `delivery_latitude`,
   `delivery_longitude` to `POST /api/orders`. The server checks the shape of
   the input (missing or invalid pin → **400**), opens a transaction (`BEGIN`)
   and calls `place_order(...)`, which inserts the order **with** the pin.
8. **Trigger.** Just before that row is written, the database runs
   `trg_validate_order_branch_range`. If the branch is closed, inactive, has no
   pin, or is too far from the delivery pin, it raises an error with SQLSTATE
   `CRV01`.
9. **Rollback and 409.** The error aborts `place_order()`. The service runs
   `ROLLBACK` — the order, its items and its timeline event all vanish — and
   turns `CRV01` into **409 Conflict** with the trigger's message, e.g.
   *"This branch doesn't deliver to your location (14.6 km away; it delivers
   within 5.0 km)."* The page shows that message; the cart is untouched.
   On success the service runs `COMMIT` and answers **201**.

---

## 3. The SQL, explained

### 3.1 New columns (`backend/db/migrations/010_branch_selection.sql`)

```sql
ALTER TABLE restaurant_branches
  ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC(4,1) NOT NULL DEFAULT 5;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_delivery_radius
  CHECK (delivery_radius_km > 0 AND delivery_radius_km <= 30);

ALTER TABLE restaurant_branches ADD COLUMN IF NOT EXISTS opens_at TIME;
ALTER TABLE restaurant_branches ADD COLUMN IF NOT EXISTS closes_at TIME;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_hours_pair
  CHECK ((opens_at IS NULL) = (closes_at IS NULL));
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_hours_not_equal
  CHECK (opens_at <> closes_at);
```

- `DEFAULT 5` + `NOT NULL`: every existing branch immediately gets a 5 km
  radius. The CHECK forbids 0 (delivers nowhere) and anything over 30 km.
- Both hours `NULL` = "no fixed hours" (open whenever the owner's `is_open`
  switch is on). The pair CHECK stops "opens at 10:00, closes at ???".
  The not-equal CHECK removes the ambiguity of 10:00–10:00.
- The migration also moves two branches that shared exact coordinates with
  another branch ~130 m apart (`ROW_NUMBER() OVER (PARTITION BY latitude,
  longitude ORDER BY id)`), and sets demo hours:
  Chuli Kitchen Dhanmondi 11:00–23:00, Kacchi Bhai Dhanmondi 18:00–02:00.
- Nothing about existing orders changes. `orders.branch_id` already had its
  foreign key, so no new FK was needed.

### 3.2 `branch_is_open(p_opens, p_closes)` — FUNCTION

```sql
CREATE OR REPLACE FUNCTION branch_is_open(p_opens TIME, p_closes TIME)
RETURNS BOOLEAN AS $$
    SELECT CASE
        WHEN p_opens IS NULL OR p_closes IS NULL THEN TRUE
        WHEN p_opens < p_closes THEN dhaka.now_time >= p_opens AND dhaka.now_time < p_closes
        ELSE dhaka.now_time >= p_opens OR dhaka.now_time < p_closes
    END
    FROM (SELECT (now() AT TIME ZONE 'Asia/Dhaka')::time AS now_time) AS dhaka;
$$ LANGUAGE sql STABLE;
```

Line by line:

- `FROM (SELECT (now() AT TIME ZONE 'Asia/Dhaka')::time AS now_time) AS dhaka`
  — computes the current **Dhaka** wall-clock time once and names it
  `dhaka.now_time`.
- `WHEN p_opens IS NULL ...` — no hours → always open.
- `WHEN p_opens < p_closes` — a normal day, e.g. 11:00–23:00: open from the
  opening time up to (not including) the closing time.
- `ELSE` — overnight, e.g. 18:00–02:00. The open period crosses midnight, so
  it is open **either** in the evening (`t >= 18:00`) **or** after midnight
  (`t < 02:00`). At 01:00 → open; at 15:00 → closed. Using `AND` here (as in
  the normal case) would never be true, which is the classic bug.
- `STABLE` — it reads `now()`, which changes between transactions, so it is
  not `IMMUTABLE`; within one statement it gives one answer.

**The timezone problem.** The database server runs in GMT. `now()::time` at
12:00 in Dhaka is 06:00 GMT, so an 11:00–23:00 branch would look *closed* at
lunchtime and *open* until 05:00 the next morning. `now() AT TIME ZONE
'Asia/Dhaka'` converts the moment into Dhaka local time first, so the check is
right no matter where the server is hosted.

### 3.3 `branches_by_distance(p_restaurant_id, p_lat, p_lng)` — FUNCTION + complex query

```sql
SELECT b.branch_id, b.branch_name, b.address, b.latitude, b.longitude,
       b.distance_km, b.delivery_radius_km, b.is_open,
       (b.is_open AND b.distance_km <= b.delivery_radius_km) AS can_deliver
FROM (
    SELECT rb.id AS branch_id,
           rb.area || ', ' || rb.city AS branch_name,
           rb.address, rb.latitude, rb.longitude,
           distance_km(p_lat, p_lng, rb.latitude, rb.longitude) AS distance_km,
           rb.delivery_radius_km,
           (COALESCE(rb.is_open, false) AND branch_is_open(rb.opens_at, rb.closes_at)) AS is_open
    FROM restaurant_branches rb
    JOIN restaurants r ON r.id = rb.restaurant_id
    JOIN users u       ON u.id = r.owner_id
    WHERE rb.restaurant_id = p_restaurant_id
      AND r.ordering_enabled = true
      AND u.is_active = true
      AND rb.latitude IS NOT NULL AND rb.longitude IS NOT NULL
) AS b
ORDER BY can_deliver DESC, b.distance_km ASC, b.branch_id;
```

- **Inner query** — one row per branch of this restaurant.
  - `JOIN restaurants` / `JOIN users` — a *join* combines rows of two tables
    that match on a column. We need them for the two "may take orders" rules:
    ordering is enabled for the restaurant, and the owner's account is active
    (the same rules `place_order()` uses).
  - `latitude IS NOT NULL` — a branch without a pin has no distance.
  - `distance_km(...)` — the existing Haversine function (unchanged).
  - `is_open` — the owner's manual switch **and** the opening hours.
    `COALESCE(rb.is_open, false)` turns a NULL switch into "closed", so the
    result is never NULL.
- **Outer query** — `can_deliver` needs `is_open` and `distance_km`, and SQL
  does not allow reusing a column alias inside the same SELECT list, hence
  the two levels.
- **`ORDER BY can_deliver DESC, distance_km ASC`** — `TRUE` sorts before
  `FALSE` when descending, so the deliverable branches come first, nearest at
  the top. The first `can_deliver` row is the one the app auto-selects.
  `branch_id` is a final tie-breaker so the order is always the same.
- Why a function: the result is pure computation with no side effects, and
  the rule is needed in more than one place (the menu page and the checkout
  pin check), so it lives once, in the database.
- `STABLE` because it reads tables and `now()`; `STRICT` so a NULL `lat`/`lng`
  returns no rows instead of rows full of NULL distances.

Example row: `231 | Khilgaon, Dhaka | ... | 0.412 | 5.0 | true | true`.

### 3.4 `trg_validate_order_branch_range` — TRIGGER

```sql
CREATE OR REPLACE FUNCTION validate_order_branch_range() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_branch RECORD;
    v_distance NUMERIC;
BEGIN
    IF NEW.delivery_latitude IS NULL OR NEW.delivery_longitude IS NULL THEN
        RAISE EXCEPTION 'Every order needs a delivery pin on the map.' USING ERRCODE = 'CRV01';
    END IF;

    SELECT rb.latitude, rb.longitude, rb.delivery_radius_km,
           (COALESCE(rb.is_open, false) AND branch_is_open(rb.opens_at, rb.closes_at)) AS is_open,
           (r.ordering_enabled AND u.is_active) AS is_active
    INTO v_branch
    FROM restaurant_branches rb
    JOIN restaurants r ON r.id = rb.restaurant_id
    JOIN users u ON u.id = r.owner_id
    WHERE rb.id = NEW.branch_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'This branch does not exist.' USING ERRCODE = 'CRV01'; END IF;
    IF v_branch.is_active IS NOT TRUE THEN RAISE EXCEPTION 'This restaurant is not accepting orders right now.' USING ERRCODE = 'CRV01'; END IF;
    IF NOT v_branch.is_open THEN RAISE EXCEPTION 'This branch is closed right now.' USING ERRCODE = 'CRV01'; END IF;
    IF v_branch.latitude IS NULL OR v_branch.longitude IS NULL THEN
        RAISE EXCEPTION 'This branch has no map location yet, so it cannot deliver.' USING ERRCODE = 'CRV01';
    END IF;

    v_distance := distance_km(v_branch.latitude, v_branch.longitude,
                              NEW.delivery_latitude, NEW.delivery_longitude);
    IF v_distance > v_branch.delivery_radius_km THEN
        RAISE EXCEPTION 'This branch doesn''t deliver to your location (% km away; it delivers within % km).',
            ROUND(v_distance, 1), v_branch.delivery_radius_km USING ERRCODE = 'CRV01';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_order_branch_range
BEFORE INSERT OR UPDATE OF branch_id, delivery_latitude, delivery_longitude
ON orders FOR EACH ROW
EXECUTE FUNCTION validate_order_branch_range();
```

- `NEW` is the row that is about to be written.
- First check: every new order must carry a delivery pin.
- `SELECT ... INTO v_branch` loads the branch plus the two "may take orders"
  flags in one query; `NOT FOUND` means the branch id does not exist.
- Then, in order: restaurant/owner active, branch open (switch + hours), branch
  has a pin, distance within the radius. Each failure has its own readable
  message but the **same** code `CRV01`, so the API can recognise the whole
  family with one `if`.
- `RETURN NEW` — all good, write the row as it is.
- **`BEFORE`** — the check runs before the row is stored, so an invalid row
  never exists, even for an instant.
- **`UPDATE OF branch_id, delivery_latitude, delivery_longitude`** — only
  updates that touch these columns re-check. Status changes (confirm,
  deliver, cancel) do not fire it, so the 12 old orders without a pin keep
  moving through their life cycle normally.
- "The branch belongs to the order's restaurant" needs no check: orders have
  no `restaurant_id`; the restaurant is *defined* by the branch.

This is **data validation before DML** (DML = INSERT/UPDATE/DELETE).

### 3.5 `place_order()` change

`place_order()` used to insert the order **without** a pin; the JavaScript
added it afterwards with an `UPDATE`. A `BEFORE INSERT` trigger that requires a
pin would then reject every order. So `place_order()` now takes
`p_delivery_latitude, p_delivery_longitude` (before `p_promo_code`, because a
parameter with a DEFAULT must come last) and writes them in the same INSERT.
The file first runs `DROP FUNCTION IF EXISTS place_order(INTEGER, INTEGER,
TEXT, VARCHAR, VARCHAR)`: in PostgreSQL a function is identified by its name
**and** parameter types, so without the DROP the old 5-parameter version would
stay behind next to the new one.

---

## 4. Why the trigger (not JavaScript) enforces the range

- **One rule, one place.** The API route, `place_order()`, a psql session, a
  seed script or a future admin tool all insert through the same table. Only a
  rule attached to the table covers them all.
- **No race window.** The check runs inside the same transaction as the
  insert. A JavaScript pre-check could pass, then the owner closes the branch,
  then the insert happens.
- **The JavaScript does not duplicate it.** `orderService.placeOrder` only
  validates the *shape* of the input (numbers in range → otherwise 400). The
  "can this branch deliver here?" decision exists only in SQL.

## 5. How the exception becomes a ROLLBACK and a 409

```js
try {
  await client.query('BEGIN')
  const result = await client.query('SELECT * FROM place_order($1, $2, $3, $4, $5, $6, $7)', [...])
  // ...
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK')
  if (error.code === 'CRV01') {
    throw new OrderServiceError(409, 'BRANCH_CANNOT_DELIVER', error.message)
  }
  throw mapCheckoutError(error)
} finally {
  client.release()
}
```

1. The trigger's `RAISE` aborts the INSERT inside `place_order()`, which
   aborts the whole `SELECT place_order(...)` statement.
2. `pg` rejects the query promise; the error object carries
   `code = 'CRV01'` and the trigger's message.
3. `ROLLBACK` undoes everything since `BEGIN`: the order row, its
   `order_items`, the `order_events` row and any promo-code usage.
4. `CRV01` → **409 Conflict**: the request was well-formed, but it conflicts
   with the current state of the data (where the branch is, its radius, its
   hours). Everything else keeps the existing error handling (unknown errors →
   500 with a generic message; SQL details are only logged on the server).
5. `client.release()` in `finally` returns the connection to the pool in
   every case.

---

## 6. Verification (run on 2026-09-27)

**Migrations are idempotent** — `npm run db:migrate` twice: the first run
applied `009_order_routes.sql` and `010_branch_selection.sql`; the second
applied nothing new and only re-installed the `CREATE OR REPLACE` function
files.

**Different locations pick different branches** (Sultan's Dine, id 10):

```
SELECT branch_id, branch_name, distance_km, delivery_radius_km, is_open, can_deliver
FROM branches_by_distance(10, 23.7465, 90.3760);   -- from Dhanmondi
 177 | Dhanmondi, Dhaka |  0.167 | 5.0 | t | t     <- auto-selected
 176 | Khilgaon, Dhaka  |  4.747 | 5.0 | t | t
 179 | Mirpur, Dhaka    |  8.630 | 5.0 | t | f
 178 | Uttara, Dhaka    | 14.398 | 5.0 | t | f

FROM branches_by_distance(10, 23.8759, 90.3795);   -- from Uttara
 178 | Uttara, Dhaka    |  0.153 | 5.0 | t | t     <- auto-selected
 179 | Mirpur, Dhaka    |  5.902 | 5.0 | t | f
 177 | Dhanmondi, Dhaka | 14.560 | 5.0 | t | f
 176 | Khilgaon, Dhaka  | 14.688 | 5.0 | t | f
```

**Trigger + rollback in psql:**

```sql
BEGIN;
-- valid: branch 177 (Dhanmondi) -> pin in Dhanmondi
INSERT INTO orders (customer_id, branch_id, delivery_address, subtotal, total_amount, delivery_latitude, delivery_longitude)
VALUES (1, 177, 'TRIGGER DEMO', 450, 499, 23.7465, 90.3760) RETURNING id;          -- id 29
INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, item_name)
SELECT id, 243, 1, 450, 'demo item' FROM orders WHERE delivery_address = 'TRIGGER DEMO';
-- out of range: same branch -> pin in Uttara
INSERT INTO orders (customer_id, branch_id, delivery_address, subtotal, total_amount, delivery_latitude, delivery_longitude)
VALUES (1, 177, 'TRIGGER DEMO', 450, 499, 23.8759, 90.3795);
-- ERROR:  CRV01: This branch doesn't deliver to your location (14.6 km away; it delivers within 5.0 km).
ROLLBACK;
SELECT (SELECT count(*) FROM orders WHERE delivery_address = 'TRIGGER DEMO') AS demo_orders,
       (SELECT count(*) FROM order_items WHERE item_name = 'demo item') AS demo_items;
-- demo_orders = 0, demo_items = 0
```

Also shown: an order with no pin →
`CRV01: Every order needs a delivery pin on the map.`; an order for the
switched-off Kacchi Bhai Badda branch → `CRV01: This branch is closed right now.`

**HTTP status codes** (`$TOKEN` = a customer's login token):

```bash
API=http://localhost:8000/api
# 401 — no session
curl -i "$API/restaurants/10/branches?lat=23.7465&lng=90.3760"
# 400 — bad lat/lng ("abc", NaN, Infinity, 95, missing lng all rejected)
curl -i -H "Authorization: Bearer $TOKEN" "$API/restaurants/10/branches?lat=abc&lng=90.3760"
# 404 — unknown restaurant
curl -i -H "Authorization: Bearer $TOKEN" "$API/restaurants/99999/branches?lat=23.7465&lng=90.3760"
# 200 — selected_branch_id: 178 (Uttara)
curl -i -H "Authorization: Bearer $TOKEN" "$API/restaurants/10/branches?lat=23.8759&lng=90.3795"
# 409 — Dhanmondi branch 177, pin in Uttara, sent directly (bypassing the UI)
curl -i -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"branch_id":177,"delivery_address":"House 1, Road 1, Uttara, 01700000000","payment_method":"cash_on_delivery","delivery_latitude":23.8759,"delivery_longitude":90.3795}' \
  "$API/orders"
# -> {"error":"This branch doesn't deliver to your location (14.6 km away; it delivers within 5.0 km).","code":"BRANCH_CANNOT_DELIVER"}
# 201 — Uttara branch 178, same pin
curl -i -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"branch_id":178,"delivery_address":"House 1, Road 1, Uttara, 01700000000","payment_method":"cash_on_delivery","delivery_latitude":23.8759,"delivery_longitude":90.3795}' \
  "$API/orders"
```

Observed: 401, 400 (×5), 404, 200, 400 for an order without a pin, 409 (the
cart still held its item afterwards), 201, and 403 when a restaurant owner
calls `POST /api/orders`. The 201 test order (id 34) was then cancelled
through `PATCH /api/orders/34/cancel`; cancelling only changes `status`, so
it did not re-fire the range trigger.

---

## 7. Graded requirements this satisfies

| Requirement | Where |
|---|---|
| FUNCTION returning a computed value | `branch_is_open()` — open/closed from hours and the Dhaka clock. |
| FUNCTION / complex query (3-table join + computed columns + ordering) | `branches_by_distance()`, used by `GET /api/restaurants/:id/branches` and the checkout pin check. |
| TRIGGER (data validation before DML) | `trg_validate_order_branch_range` on `orders`. |
| Transactions with explicit BEGIN / COMMIT / ROLLBACK | `placeOrder()` in `orderService.js`; the trigger's error rolls back the order and its items. |
| REST endpoint with correct status codes | `GET /api/restaurants/:id/branches` (200/400/401/404/500); `POST /api/orders` (201/400/401/403/409/500). |
| Server-side auth & validation | `authenticateToken` (401), `requireRole('customer')` on orders (403), `parseId` / `parseCoordinates` (400); user id always from the token. |
| Parameterized SQL only | Every query uses `$1, $2, ...`. |

Each new object has a real use: the hours function is needed in two places
(the listing and the trigger), the distance-ranking function in two places
(menu page and checkout), and the trigger is the only way to guarantee the
rule for every writer.

---

## 8. Files

- `backend/db/migrations/010_branch_selection.sql` — radius + hours columns, CHECKs, de-duplicated pins, demo hours
- `backend/db/functions/restaurant_branches.sql` — `branch_is_open`, `branches_by_distance`, `validate_order_branch_range` + trigger
- `backend/db/functions/place_order.sql` — pin parameters, old signature dropped
- `backend/services/orderService.js` — pin required, `CRV01` → 409
- `backend/routes/restaurants.js` — `GET /:id/branches`; `GET /:id` returns hours-aware `is_open`, hours and radius
- `backend/scripts/doctor.js` — checks the new `place_order` signature
- `backend/tests/tracking.js`, `marketplace.js`, `e2e.js` — orders now send pins; new branch-selection and 409 checks
- `frontend/src/context/LocationContext.jsx` (new), `frontend/src/components/BranchSelector.jsx` (new)
- `frontend/src/context/CartContext.jsx` — `branch_id` in cart state, `selectBranch()`
- `frontend/src/pages/RestaurantPage.jsx`, `frontend/src/pages/CheckoutPage.jsx`
- `frontend/src/components/map/NearbyRestaurants.jsx` — uses the shared location
- `frontend/src/services/restaurantApi.js`, `frontend/src/App.jsx`, `frontend/eslint.config.js`

## 9. Known limits / TODO

- **Restaurant-level coordinates:** none exist; every coordinate reader
  (`/nearby`, tracking, route caching, admin live board, rider jobs) already
  uses branch coordinates. Nothing to migrate.
- `recommend_restaurants` does not exist in this codebase.
- 98 branches outside Dhaka have no map pin, so they are not listed by
  `branches_by_distance()` and cannot take orders until an owner sets a pin.
- On a **fresh** database, `seed:real` inserts branches *after* migration
  008's one-time pin backfill has run, so those branches start without pins.
- Owners cannot yet edit `delivery_radius_km` or opening hours from the
  dashboard (only via SQL).
- `GET /api/restaurants` ("Open now" filter) and `/nearby` still use the
  manual `is_open` switch only, not the opening hours.
- Old orders (12) have no delivery pin; the trigger does not touch them
  because status updates do not fire it.

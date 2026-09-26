# Map + live rider tracking

This document explains the map and live-tracking feature from end to end, in
plain English. Read it top to bottom once and you should be able to explain
any line of it in a viva.

---

## 0. The big picture in one paragraph

Every restaurant **branch** can have a pin on the map (a latitude and a
longitude). When a customer checks out, they may drop a pin for where the food
should go; that pin is **copied onto the order**. Once a rider picks up the
food, the rider's phone sends its GPS position to the server every 5 seconds.
The server keeps **one row per rider** saying where they are *now*, and a
**trigger** automatically copies each new position into a **log table** for
the order the rider is carrying. The customer's page asks the server every 5
seconds "where is my food?", and one SQL query answers with the rider's
position, the distance left, an ETA, and whether the signal has gone stale.
All the maths — distance, ETA, "seconds ago", "stale" — happens **inside
PostgreSQL**, not in JavaScript.

### Words used in this document

- **Latitude / longitude** — two numbers that pin a point on Earth. Latitude
  goes north–south (−90 to 90), longitude goes east–west (−180 to 180). Dhaka
  is about latitude 23.81, longitude 90.41.
- **Endpoint** — one URL + HTTP method the backend answers, e.g.
  `PUT /api/rider/location`.
- **Middleware** — a function Express runs *before* the real handler, e.g. to
  check who is logged in. If it says no, the handler never runs.
- **JWT (JSON Web Token)** — the signed "login ticket" the browser sends with
  every request. The server checks the signature, so the user id and role
  inside it cannot be faked.
- **Transaction** — a group of SQL statements that either *all* happen
  (`COMMIT`) or *none* happen (`ROLLBACK`).
- **Join** — combining rows of two tables where a column matches, e.g. an
  order with the branch it was placed at.
- **LEFT JOIN** — a join that keeps the left row even when there is no match
  on the right; the missing columns come back as `NULL`.
- **Trigger** — a piece of SQL the database runs by itself whenever a row in a
  certain table is inserted/updated/deleted.
- **Function** — a named, reusable SQL calculation, like a formula in a
  spreadsheet.
- **Upsert** — "insert, or update if it already exists", done in one statement
  with `INSERT ... ON CONFLICT ... DO UPDATE`.
- **Polling** — the browser asking the server again and again on a timer.
- **Leaflet** — a free JavaScript library that draws maps. **OpenStreetMap
  (OSM)** — the free, community-made map images ("tiles") Leaflet shows. No
  API key is needed.

---

## 1. Why the pin lives on the branch, not the restaurant

In this database a restaurant (e.g. "KFC") has **many branches**, and an order
is placed at **one branch** (`orders.branch_id`). A single pin on
`restaurants` would put every KFC branch on the same spot. So the pickup point
is `restaurant_branches.latitude / longitude`. Those two columns already
existed; this feature only added the missing CHECK rules.

---

## 2. Database changes

Files:
- `backend/db/migrations/008_live_tracking.sql` — tables, columns, CHECKs,
  one-time demo pins. Runs once.
- `backend/db/functions/live_tracking.sql` — the `distance_km` function and the
  trigger. Re-installed on every `npm run db:migrate`, so it can be edited later
  without a new migration.

Everything is **idempotent** (safe to run twice): `ADD COLUMN IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then `ADD
CONSTRAINT`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` then
`CREATE TRIGGER`.

### 2.1 Columns added or constrained

| Table | Column(s) | Why it exists |
|---|---|---|
| `restaurant_branches` | `latitude`, `longitude` (already existed) | The pickup point. New CHECKs: lat in −90..90, lng in −180..180, and **both or neither** — half a location is not a place. |
| `customer_addresses` | `latitude`, `longitude` (already existed) | A saved address can carry its own pin, which checkout uses as the starting pin. New CHECK: both or neither. |
| `orders` | `delivery_latitude`, `delivery_longitude` (new, `NUMERIC(9,6)`, nullable) | The drop-off point, **copied** at checkout (see §6). Nullable because older orders and customers who skip the pin have none. Same three CHECKs. |

`NUMERIC(9,6)` means up to 9 digits in total, 6 after the decimal point —
about 10 cm of precision.

### 2.2 New table `rider_current_location` — "where is each rider now?"

| Column | Why it exists |
|---|---|
| `rider_id INTEGER PRIMARY KEY → users(id) ON DELETE CASCADE` | One row per rider, never more. The PRIMARY KEY is what makes the upsert work. Riders are users with role `rider`, so it points at `users(id)` like `orders.rider_id` does. CASCADE: a deleted account has no position to keep. |
| `latitude`, `longitude NUMERIC(9,6) NOT NULL` + CHECKs | The position. NOT NULL because a location row without a location makes no sense. |
| `accuracy_m NUMERIC(8,2) NULL CHECK (>= 0)` | How many metres off the phone thinks it may be. Optional; not every browser reports it. |
| `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` | When the last fix arrived. The "stale signal" check compares this with `now()`. `TIMESTAMPTZ` (with time zone) keeps "seconds ago" correct whatever time zone the server is in. |

### 2.3 New table `delivery_location_log` — the breadcrumb trail

| Column | Why it exists |
|---|---|
| `log_id BIGSERIAL PRIMARY KEY` | A row arrives every few seconds per rider, so this is the table most likely to outgrow a normal 32-bit id. |
| `order_id → orders(id) ON DELETE CASCADE` | The trail belongs to an **order**, so a customer only ever sees the path of *their* food, never the rider's earlier trips. |
| `rider_id → users(id) ON DELETE CASCADE` | Who drove it. |
| `latitude`, `longitude NOT NULL` + CHECKs | The point. |
| `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()` | When; the trail is drawn in this order. |

Index: `(order_id, recorded_at)` — the trail query is always "this order's
points, in time order", so the index matches it exactly.

**Nobody's code inserts into this table.** Only the trigger does (§3.2).

### 2.4 Demo pins for Dhaka

The migration gives every Dhaka branch that had **no** pin an approximate one:
the centre of its neighbourhood (Dhanmondi, Gulshan, Banani, Mirpur, Uttara,
Mohammadpur, …) plus a small offset from its id (steps of about 150 m) so
branches in the same area do not sit on the same pixel. Unknown areas fall
back to the city centre (23.8103, 90.4125). Existing pins are never
overwritten (`WHERE latitude IS NULL AND longitude IS NULL`). Owners can move
any pin from their dashboard.

---

## 3. The SQL objects (graded: FUNCTION + TRIGGER)

### 3.1 FUNCTION `distance_km(lat1, lng1, lat2, lng2)` — Haversine

```sql
CREATE OR REPLACE FUNCTION distance_km(
    p_lat1 NUMERIC, p_lng1 NUMERIC, p_lat2 NUMERIC, p_lng2 NUMERIC
)
RETURNS NUMERIC
AS $$
    SELECT ROUND((
        2 * 6371 * asin(
            sqrt(
                LEAST(
                    1,
                    power(sin(radians(p_lat2 - p_lat1) / 2), 2)
                    + cos(radians(p_lat1)) * cos(radians(p_lat2))
                      * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
                )
            )
        )
    )::NUMERIC, 3);
$$ LANGUAGE sql IMMUTABLE STRICT;
```

Line by line:
1. The Earth is a ball, so the distance between two points is an **arc**, not
   a straight line on a flat map. Haversine is the standard formula for it.
2. `radians(...)` — trig functions work in radians, not degrees.
3. `power(sin(Δlat / 2), 2)` — the north–south part.
4. `cos(lat1) * cos(lat2) * power(sin(Δlng / 2), 2)` — the east–west part.
   The `cos` factors shrink it away from the equator, because lines of
   longitude get closer together there.
5. The sum is called **a**. `2 * asin(sqrt(a))` turns it into the angle between
   the two points, measured from the centre of the Earth.
6. `* 6371` — angle × Earth's radius in km = distance along the surface.
7. `LEAST(1, ...)` — rounding errors could push **a** a hair above 1, and
   `asin` of more than 1 is an error. This clamps it.
8. `ROUND(..., 3)` — 3 decimals of a km = 1 metre.
9. `IMMUTABLE` — same inputs always give the same output and no table is
   read, so PostgreSQL may cache it.
10. `STRICT` — if **any** input is `NULL`, the function returns `NULL`
    without running. That is exactly right for "rider has not sent a
    position yet" or "order has no drop-off pin".

Sanity check: `distance_km(23.7465, 90.3760, 23.7925, 90.4078)` (Dhanmondi to
Gulshan) = **6.053 km**.

### 3.2 TRIGGER `trg_log_rider_location`

```sql
CREATE OR REPLACE FUNCTION log_rider_location()
RETURNS TRIGGER
AS $$
BEGIN
    INSERT INTO delivery_location_log (order_id, rider_id, latitude, longitude, recorded_at)
    SELECT o.id, NEW.rider_id, NEW.latitude, NEW.longitude, NEW.updated_at
    FROM orders o
    WHERE o.rider_id = NEW.rider_id
      AND o.status = 'out_for_delivery';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_rider_location ON rider_current_location;

CREATE TRIGGER trg_log_rider_location
    AFTER INSERT OR UPDATE OF latitude, longitude
    ON rider_current_location
    FOR EACH ROW
    EXECUTE FUNCTION log_rider_location();
```

Line by line:
1. `NEW` is the row just written to `rider_current_location` (the rider's new
   position).
2. The `SELECT` finds every order this rider is **carrying right now**:
   `o.rider_id = NEW.rider_id AND o.status = 'out_for_delivery'`.
3. `INSERT ... SELECT` inserts one log row per order found. Rider idle → 0
   rows. One delivery → 1 row. It would even handle stacked deliveries with
   no code change. (Today the accept route allows only one active delivery
   per rider.)
4. `RETURN NULL` — an AFTER row trigger's return value is ignored.
5. `AFTER` — only a position that passed its CHECKs is logged.
6. `INSERT OR UPDATE` — a rider's first ever position is an INSERT; every
   later one is an UPDATE (the upsert's conflict branch).
7. `UPDATE OF latitude, longitude` — fires only when a statement writes a
   **position**. The API's upsert always sets both, so every GPS report counts.
   But someone touching only `updated_at` or `accuracy_m` in psql is not
   movement and must not add a fake point to a customer's trail. (The existing
   rating trigger uses `UPDATE OF rating, order_id` for the same reason.)
8. `FOR EACH ROW` — the function needs `NEW`.

**Why a trigger and not a second INSERT in the Express route?** The log is a
*shadow table* of `rider_current_location`: every position change must be
recorded. A trigger makes the **database** guarantee that, no matter which
code moves the rider (the API, psql, a future script). It also runs inside
the same transaction, so if the log insert fails the position update rolls
back too, and the two tables can never disagree.

**Why only `out_for_delivery`?** That status is set when the rider confirms
pickup. Before that the rider is riding *to the restaurant*, which is not
part of the customer's delivery.

---

## 4. Feature flows, step by step

### 4.1 Owner sets a branch's location

1. The owner opens **Restaurant studio** (`/owner`), picks a restaurant, and
   clicks **📍 Set location** next to a branch
   (`BranchLocationEditor.jsx`).
2. A map appears (`LocationPicker.jsx`). They click to drop a pin, drag it to
   adjust, or press **Use my current location** (the browser's
   `navigator.geolocation.getCurrentPosition`). If permission is denied, a
   friendly message says to click the map instead.
3. **Save location** calls `PATCH /api/restaurants/branches/:branchId/location`
   with `{ latitude, longitude }` (`services/ownerApi.js`).
4. `authenticateToken` middleware checks the JWT → 401 if missing or invalid.
5. `requireRole('restaurant_owner', 'admin')` → 403 for customers and riders.
6. The handler validates the numbers (`parseCoordinates` in
   `utils/validation.js`) → 400 for `999`, `"abc"`, `NaN`, `Infinity`.
7. `BEGIN`, then it reads the branch **with its owner**, locking the row:
   ```sql
   SELECT rb.id, r.owner_id
   FROM restaurant_branches rb JOIN restaurants r ON r.id = rb.restaurant_id
   WHERE rb.id = $1
   FOR UPDATE OF rb
   ```
   No row → 404. `owner_id` ≠ the token's user id (and not admin) → 403.
   This is the **object-level ownership check**.
8. `UPDATE restaurant_branches SET latitude=$1, longitude=$2 WHERE id=$3`,
   then `COMMIT`. Any error → `ROLLBACK` and a generic 500.

### 4.2 Customer: "Near me"

1. On the home page a signed-in user clicks **📍 Near me**
   (`NearbyRestaurants.jsx`).
2. The browser asks for the position. If denied, it searches around Dhaka
   city centre and says so.
3. It calls `GET /api/restaurants/nearby?lat=&lng=&radius_km=` (default 5,
   max 25). Must be logged in (401 otherwise).
4. The **graded complex query** runs (§5.1). The page shows a map with a
   marker per branch plus a list with "2.3 km" next to each.

### 4.3 Customer: checkout with a drop-off pin

1. On `/checkout` there is a **Drop-off pin** map (`LocationPicker`). If the
   chosen saved address has coordinates, they become the starting pin.
2. **Place order** sends `delivery_latitude` / `delivery_longitude` along with
   the existing fields to `POST /api/orders`.
3. `orderService.placeOrder` validates them: both missing = fine (checkout
   works exactly as before), one missing or invalid = 400.
4. Inside the **existing** transaction: `SELECT * FROM place_order(...)`
   creates the order (unchanged), then
   `UPDATE orders SET delivery_latitude=$1, delivery_longitude=$2 WHERE id=$3`
   snapshots the pin, then `COMMIT`. If anything fails, both roll back.
   (`place_order()` itself was not changed: adding parameters would leave the
   old 5-argument version behind as an ambiguous overload.)

### 4.4 Rider: sharing location

1. The rider accepts a job, and on the **Active** tab of `/rider` each job
   card shows **📡 Start sharing location** (`RiderLocationSharing.jsx`).
2. Start calls `navigator.geolocation.watchPosition`, which reports every new
   GPS fix. The marker on the rider's own map moves every time.
3. **Throttle:** a fix is *sent* only if 5 seconds have passed since the last
   send (`lastSentAtRef`). The rest only move the local marker.
4. Each send is `PUT /api/rider/location` with
   `{ latitude, longitude, accuracy_m }`. **No rider id is sent.**
5. `router.use(authenticateToken, requireRole('rider'))` → 401 without a
   token, 403 for any other role.
6. Validation → 400 for bad numbers or negative accuracy.
7. `BEGIN`, then the **upsert**:
   ```sql
   INSERT INTO rider_current_location (rider_id, latitude, longitude, accuracy_m, updated_at)
   VALUES ($1, $2, $3, $4, now())
   ON CONFLICT (rider_id) DO UPDATE
   SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       accuracy_m = EXCLUDED.accuracy_m, updated_at = now()
   ```
   `$1` is `req.user.id` from the token. `EXCLUDED` means "the row we tried to
   insert".
8. The **trigger** fires (§3.2) and, if the order is out for delivery, writes
   a trail row. `COMMIT` saves both, or `ROLLBACK` undoes both. That is why
   this single statement still gets an explicit transaction.
9. Response: **204 No Content**.
10. **Stop sharing** calls `clearWatch`. Leaving the page or finishing the
    delivery unmounts the component, which also calls `clearWatch`.

**Demo simulator (development builds only).** A 🧪 **Simulate route** button
appears only when `import.meta.env.DEV` is true (it is `false` in
`npm run build`). It walks 30 points in a straight line from the branch pin
to the drop-off pin, one every 3 seconds, and sends each through the **same
real `PUT /api/rider/location`**. Only the *source* of the coordinates is fake;
the upsert, trigger, trail and customer map are all real.

### 4.5 Customer: live tracking map

1. On `/orders`, expanding an order whose status is `out_for_delivery` shows
   `LiveTrackingMap.jsx`.
2. It calls `GET /api/orders/:id/tracking` immediately, then every **5
   seconds** with `setInterval`.
3. The server (`orderService.getOrderTracking`):
   - reads the order's `customer_id`, `rider_id` and restaurant `owner_id`.
     Not found → 404.
   - allows only: the customer who owns it, the rider assigned to it, the
     owner of its restaurant, or an admin. Anyone else → **403**, even if they
     guess the order id.
   - if the status is not `out_for_delivery`, returns
     `{ tracking_active: false, status }`. For a **delivered** order this means
     the rider's current position is **not** returned, so a past customer
     cannot keep following a rider around the city.
   - otherwise runs the **graded complex query** (§5.2) and the trail query.
4. The page shows the restaurant, drop-off and rider markers, a blue
   **Polyline** (a line through the trail points), "About X min away · Y km to
   go", "Updated Ns ago", and a red **"Rider signal lost"** warning when
   `is_stale` is true.
5. **Polling stops** when `tracking_active` is false (delivered, cancelled,
   not picked up), on a 403/404, and on unmount (the cleanup function calls
   `clearInterval`).

### 4.6 Admin: live deliveries board

1. Admins get a **Live map** link in the navbar (and a button on the control
   room) → `/admin/live` (`AdminLiveDeliveriesPage.jsx`).
2. It polls `GET /api/admin/deliveries/live` every 5 seconds.
   `requireRole('admin')` → 403 for everyone else.
3. The **graded complex query** (§5.3) returns the counts and the list in one
   row.
4. The page shows **Active deliveries** and **Riders with stale signal**, all
   riders on one map (blue = live, grey = stale), and a table.

---

## 5. The graded complex queries, line by line

### 5.1 Restaurants near me (`routes/restaurants.js`)

```sql
SELECT nearby.*
FROM (
  SELECT
    r.id AS restaurant_id, r.name, r.cuisine, r.image_url, r.logo_url,
    r.ordering_enabled, r.avg_rating::float8 AS avg_rating, r.review_count,
    rb.id AS branch_id, rb.area, rb.city, rb.is_open,
    rb.latitude::float8 AS latitude, rb.longitude::float8 AS longitude,
    distance_km($1, $2, rb.latitude, rb.longitude)::float8 AS distance_km
  FROM restaurant_branches rb
  JOIN restaurants r ON r.id = rb.restaurant_id
  WHERE rb.latitude IS NOT NULL AND rb.longitude IS NOT NULL
) AS nearby
WHERE nearby.distance_km <= $3
ORDER BY nearby.distance_km ASC, nearby.branch_id
LIMIT 100
```

- **Inner query:** joins each branch to its restaurant (for name, cuisine and
  rating), skips branches with no pin, and computes the distance from the
  user (`$1`, `$2`) with our function.
- **Why two levels?** SQL cannot use a column alias (`distance_km`) in the
  `WHERE` of the same `SELECT`. So the inner query computes it, and the outer
  query filters (`<= $3`, the radius) and sorts by it.
- `r.avg_rating` is the **stored** rating kept correct by
  `trg_sync_restaurant_rating`, so it is not recomputed per row.
- `::float8` makes the `pg` driver send JSON numbers, not the strings it uses
  for `NUMERIC`.
- `LIMIT 100` caps the response size.

### 5.2 Live tracking snapshot (`services/orderService.js`)

```sql
SELECT
  live.*,
  CEIL(live.distance_remaining_km / 20.0 * 60)::int AS eta_minutes
FROM (
  SELECT
    o.id AS order_id, o.status,
    r.name AS restaurant_name, rb.area AS branch_area,
    rb.latitude::float8 AS restaurant_latitude, rb.longitude::float8 AS restaurant_longitude,
    o.delivery_latitude::float8 AS delivery_latitude, o.delivery_longitude::float8 AS delivery_longitude,
    rider.name AS rider_name,
    loc.latitude::float8 AS rider_latitude, loc.longitude::float8 AS rider_longitude,
    loc.updated_at AS rider_updated_at,
    distance_km(loc.latitude, loc.longitude,
                o.delivery_latitude, o.delivery_longitude)::float8 AS distance_remaining_km,
    FLOOR(EXTRACT(EPOCH FROM now() - loc.updated_at))::int AS seconds_since_update,
    COALESCE(now() - loc.updated_at > interval '60 seconds', true) AS is_stale
  FROM orders o
  JOIN restaurant_branches rb ON rb.id = o.branch_id
  JOIN restaurants r ON r.id = rb.restaurant_id
  LEFT JOIN users rider ON rider.id = o.rider_id
  LEFT JOIN rider_current_location loc ON loc.rider_id = o.rider_id
  WHERE o.id = $1
) AS live
```

- **Five tables joined:** the order → its branch (pickup pin) → its
  restaurant (name) → the rider's user row (name) → the rider's current
  location.
- **LEFT JOIN** on the rider and the location: a rider who has not sent a
  position yet has no `rider_current_location` row. An inner join would make
  the whole order vanish; a LEFT JOIN keeps it with `NULL`s.
- `distance_km(rider → drop-off)` — `NULL` if either point is missing
  (`STRICT`), so an order with no drop-off pin does not crash anything.
- `now() - loc.updated_at` is an **interval** (a length of time).
  `EXTRACT(EPOCH FROM ...)` turns it into seconds.
- `is_stale` — true when the last fix is older than 60 seconds. `COALESCE(...,
  true)` also makes it true when there has **never** been a fix
  (`NULL > interval` is `NULL`).
- **ETA assumption:** an average of **20 km/h** in Dhaka traffic, over the
  straight-line distance. km ÷ (km/h) = hours; × 60 = minutes; `CEIL` rounds
  **up**, so we never promise "0 minutes" early.
- The outer query exists so the ETA can reuse `distance_remaining_km`
  instead of calling the function twice.

The **trail** (second query):

```sql
SELECT latest.latitude, latest.longitude
FROM (
  SELECT log_id, recorded_at, latitude::float8 AS latitude, longitude::float8 AS longitude
  FROM delivery_location_log
  WHERE order_id = $1
  ORDER BY recorded_at DESC, log_id DESC
  LIMIT 200
) AS latest
ORDER BY latest.recorded_at, latest.log_id
```

The inner query takes the **newest** 200 points (a long ride cannot send an
unbounded list). The outer query puts them back in time order so the line is
drawn in the order the rider drove it. It uses the `(order_id, recorded_at)`
index.

### 5.3 Admin live board (`routes/admin.js`)

```sql
WITH live AS (
  SELECT
    o.id AS order_id, r.name AS restaurant_name, rb.area AS branch_area,
    ...pickup, drop-off and rider coordinates...,
    rider.id AS rider_id, rider.name AS rider_name,
    loc.updated_at AS rider_updated_at,
    FLOOR(EXTRACT(EPOCH FROM now() - loc.updated_at))::int AS seconds_since_update,
    COALESCE(now() - loc.updated_at > interval '60 seconds', true) AS is_stale,
    distance_km(loc.latitude, loc.longitude,
                o.delivery_latitude, o.delivery_longitude)::float8 AS distance_remaining_km
  FROM orders o
  JOIN restaurant_branches rb ON rb.id = o.branch_id
  JOIN restaurants r ON r.id = rb.restaurant_id
  LEFT JOIN users rider ON rider.id = o.rider_id
  LEFT JOIN rider_current_location loc ON loc.rider_id = o.rider_id
  WHERE o.status = 'out_for_delivery'
)
SELECT
  COUNT(*)::int AS active_deliveries,
  COUNT(DISTINCT live.rider_id) FILTER (WHERE live.is_stale)::int AS stale_riders,
  COALESCE(json_agg(live ORDER BY live.order_id), '[]'::json) AS deliveries
FROM live
```

- `WITH live AS (...)` is a **CTE** (Common Table Expression): a named
  temporary result used by the query below it. It has the same joins as §5.2,
  but for **every** order that is out for delivery.
- The outer `SELECT` **aggregates** it into exactly one row:
  - `COUNT(*)` — number of active deliveries.
  - `COUNT(DISTINCT rider_id) FILTER (WHERE is_stale)` — number of different
    riders whose signal is stale. `FILTER` counts only the matching rows.
  - `json_agg(live ...)` — the rows themselves, as a JSON array.
- Doing counts and list in **one** statement means the summary and the list
  always describe the same moment.
- `COALESCE(..., '[]')` — `json_agg` of zero rows is `NULL`; this turns it
  into an empty list.

---

## 6. Design questions you may be asked

**Why does the order store a snapshot of the delivery coordinates?**
For the same reason `order_items.unit_price` is a snapshot. The customer may
later edit or delete their saved address, but an order already on the road
must still point at the place the food is actually going. An order is a
historical record, so its data is copied, not referenced.

**Why does the rider id come from the token and not the request body?**
Anything in the body is typed by the client and can be changed with Postman.
If the body said `rider_id: 7`, any rider could move rider 7 on every
customer's map. The token is signed by the server's secret, so `req.user.id`
is the verified logged-in user. The endpoint takes **no** id at all, so a
rider can only ever move themselves.

**Why polling instead of WebSockets?**
- A position every 5 seconds is slow enough that a normal `GET` is plenty.
- Polling reuses everything we already have: the same Express routes, the
  same JWT middleware, the same 401/403 checks on every request. WebSockets
  would need a second server-side protocol and its own authentication.
- It is easy to reason about and to demonstrate with curl.
- The cost (one small query per viewer every 5 s) is fine at coursework
  scale. A production app with thousands of watchers would switch to push.

**Why is distance computed in SQL and not JavaScript?**
The database does the filtering and sorting ("within 5 km, closest first"), so
it must know the distance. Computing it in JS would mean sending **every**
branch to Node first. It also makes `distance_km` a reusable, graded SQL
function used by three queries.

**Why did we not use PostGIS?**
It is a separate extension to install, and the Haversine formula is short
enough to write and explain ourselves.

**Why Leaflet + OpenStreetMap?** Both are free and need no API key or secret.

---

## 7. Which graded requirement each piece satisfies

| Requirement | Where |
|---|---|
| **TRIGGER** | `trg_log_rider_location` → `log_rider_location()` (automatic shadow-table logging). |
| **FUNCTION** | `distance_km()` — returns a computed value, used by three queries. |
| **Complex queries** | Nearby restaurants (§5.1), live tracking snapshot (§5.2), admin live board with aggregation (§5.3). |
| **Transactions** | Branch pin PATCH, rider location PUT (upsert + trigger commit together), checkout (pin written in the same transaction as `place_order`). All use `BEGIN` / `COMMIT` / `ROLLBACK` / `release()`. |
| **Parameterized SQL** | Every value is `$1, $2, …`. No user input is ever placed in SQL text. |
| **Role authorization (401/403)** | `authenticateToken` → 401; `requireRole(...)` → 403 on every new endpoint. |
| **Object-level ownership** | Branch pin: `owner_id` must equal the token's user. Tracking: only this order's customer, rider, restaurant owner or an admin. |
| **Input validation (400)** | `parseCoordinates()` rejects non-numbers, `NaN`, `Infinity` and out-of-range values; radius 0–25; accuracy ≥ 0. |
| **Role-aware UI** | "Near me" for signed-in users, pin editor only in the owner studio, sharing only on the rider page, "Live map" link only for admins. |

---

## 8. Demo with curl (proving the backend is the real gate)

Log in first to get tokens (replace the emails and passwords with your accounts):

```bash
API=http://localhost:8000/api
login() { curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$2\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token'; }
CUSTOMER_A=$(login customerA@example.com password123)
CUSTOMER_B=$(login customerB@example.com password123)
OWNER=$(login owner@example.com password123)
RIDER=$(login rider@example.com password123)
```

```bash
# 401 — no session at all
curl -i -X PUT $API/rider/location -H 'Content-Type: application/json' \
  -d '{"latitude":23.78,"longitude":90.40}'

# 403 — a customer pretending to be a rider
curl -i -X PUT $API/rider/location -H "Authorization: Bearer $CUSTOMER_A" \
  -H 'Content-Type: application/json' -d '{"latitude":23.78,"longitude":90.40}'

# 403 — customer A tracking customer B's order (use one of B's order ids)
curl -i $API/orders/<B_ORDER_ID>/tracking -H "Authorization: Bearer $CUSTOMER_A"

# 403 — an owner moving a branch of ANOTHER owner's restaurant
curl -i -X PATCH $API/restaurants/branches/<OTHER_OWNERS_BRANCH_ID>/location \
  -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"latitude":23.78,"longitude":90.40}'

# 403 — a non-admin opening the admin live board
curl -i $API/admin/deliveries/live -H "Authorization: Bearer $CUSTOMER_A"

# 400 — latitude out of range
curl -i -X PUT $API/rider/location -H "Authorization: Bearer $RIDER" \
  -H 'Content-Type: application/json' -d '{"latitude":999,"longitude":90.40}'

# 400 — latitude is not a number
curl -i -X PUT $API/rider/location -H "Authorization: Bearer $RIDER" \
  -H 'Content-Type: application/json' -d '{"latitude":"abc","longitude":90.40}'

# 204 — a real rider update (then check the trail in psql)
curl -i -X PUT $API/rider/location -H "Authorization: Bearer $RIDER" \
  -H 'Content-Type: application/json' -d '{"latitude":23.78,"longitude":90.40,"accuracy_m":8}'
```

To find ids for the demo: `SELECT id FROM orders WHERE customer_id = <B's user id>`,
and `SELECT rb.id FROM restaurant_branches rb JOIN restaurants r ON r.id =
rb.restaurant_id WHERE r.owner_id <> <your owner id> LIMIT 1`.

The same checks run automatically in `backend/tests/tracking.js`
(`npm run test:backend`, with a separate `TEST_DATABASE_URL`).

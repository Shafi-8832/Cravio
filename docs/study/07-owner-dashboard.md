# 07 — Restaurant owner dashboard

## Files involved

**Frontend**
- `frontend/src/pages/OwnerDashboardPage.jsx` — the studio: Restaurants & Menu, Orders and Analytics tabs.
- `frontend/src/pages/OwnerAnalyticsPage.jsx` — the standalone analytics page at `/owner/analytics`.
- `frontend/src/components/OwnerAnalytics.jsx` — the analytics component, used by both.
- `frontend/src/pages/OwnerReviewsPage.jsx` — the review inbox (detailed in unit 06).
- `frontend/src/components/RestaurantSettings.jsx`, `OwnerItemEditor.jsx`, `BusinessSummary.jsx`.
- `frontend/src/components/DateRangePicker.jsx` — shared with the admin dashboard.
- `frontend/src/services/ownerApi.js` — every call in this slice.

**Route**
- `backend/routes/owner.js` — six analytics routes (`:324-339`) and four review routes (`:402-620`), all behind `router.use(authenticateToken, requireRole('restaurant_owner'))` at `:12`.
- `backend/routes/menu.js` — the nine menu-management writes (`:189`, `:282`, `:423`, `:556`, `:655`, `:764`, `:879`, `:988`, `:1074`).
- `backend/routes/restaurants.js` — `GET /mine` (`:73`), `POST /` (`:209`), `POST /:id/branches` (`:261`), `PATCH /branches/:branchId/toggle` (`:370`), `PATCH /:id` (`:451`).
- `backend/routes/orders.js:76` — `GET /restaurant`, the incoming-order queue.

**Controller**
- `backend/services/orderService.js:548` — `listRestaurantOrders`; `:642` — `updateOrderStatus` (unit 05).
- `backend/utils/dateRange.js` — the shared date validator.

**Middleware**
- `owner.js:12` — the router-wide gate.
- `owner.js:26-52` — **`requireOwnedRestaurant`, the project's only dedicated ownership middleware.**
- `menu.js` / `restaurants.js` use `requireRole('restaurant_owner','admin')` per route plus an in-handler ownership check.

**SQL**
- Reads across `orders`, `order_items`, `menu_items`, `restaurant_branches`, `restaurants`, `restaurant_reviews`.
- Writes to `restaurants`, `restaurant_branches`, `menu_categories`, `menu_items`, `modifier_groups`, `modifier_options`, `restaurant_reviews.owner_reply`.

---

## Flow

### The ownership gate

`GET /api/owner/analytics/:restaurantId` puts a restaurant id in the URL. **That id is a request, not a permission.** Three things happen before any report runs:

1. `owner.js:12` — logged in, and a restaurant owner. Otherwise 401/403.
2. `requireOwnedRestaurant` (`:26-52`) — `:27` parses the id → **400**; `:32-35` loads the restaurant → **404** if absent; `:41` compares `owner_id` with `req.user.id` → **403** if it is not theirs. It then stashes `req.restaurant` and validates the date range (`:47-49`) → **400**.
3. **Every analytics query repeats `AND r.owner_id = $2`** on top of that. The comment at `:23-24` says why: if the middleware were ever removed or wrongly edited, the queries would return *nothing* rather than another owner's revenue.

`params` (`:60`) binds the same four values for every report: restaurant id, **owner id from the token**, range start, range end.

### Analytics

1. `OwnerAnalytics` calls `GET /api/owner/analytics/:id?from=&to=` (`ownerApi.getAnalytics`).
2. `:339` runs all five reports in parallel and returns them together; each also has its own address (`:324-327`, `:331`).
3. The page renders headline stats with period-over-period deltas, then revenue trend, top items, busiest hours, and the status breakdown.
4. Clicking a status row opens the Orders tab already filtered to it (`OwnerDashboardPage.jsx`), or navigates there from the standalone page.

### Managing the restaurant and menu

1. `GET /api/restaurants/mine` (`:73`) lists only this owner's restaurants — `WHERE r.owner_id = $1` (`:103`).
2. `POST /api/restaurants` (`:209`) creates one with `owner_id` taken from the token.
3. `POST /api/restaurants/:id/branches` (`:261`) — `BEGIN` at `:300`, ownership SELECT at `:302-307`, 403 at `:310-318`, INSERT at `:321`.
4. `PATCH /api/restaurants/:id` (`:451`) — the ownership test is **inside the UPDATE** (`:467`), zero rows → **404**.
5. The nine `menu.js` writes all follow one shape: fetch the row joined up to `restaurants.owner_id`, compare, then write. **All nine are now wrapped in transactions** (Task A), so the check and the write share one connection.

### The order queue

`GET /api/orders/restaurant` (`orders.js:76`) → `listRestaurantOrders(req.user.id, req.query)` (`orderService.js:548`). The owner id comes from the token; the service joins up to `restaurants.owner_id`. Accepting or rejecting an order is `PATCH /api/orders/:id/status` — unit 05.

---

## The SQL

### The ownership pattern — shown once

Every owner-scoped query in this slice ends in the same three lines:
```sql
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
```
Read it as a sentence: take the orders, find each one's branch, find that branch's restaurant, and keep only rows where that restaurant is the one asked about **and** is owned by the person asking. `$1` comes from the URL, `$2` from the token. An order stores a branch, not a restaurant, which is why it takes two hops.

The middleware version is the same test without the orders:
```sql
SELECT id, name, owner_id FROM restaurants WHERE id = $1
```
`owner.js:33`. `$1` = the URL id; the comparison happens in JavaScript at `:41` so the 404 and 403 cases can be told apart — something a `WHERE owner_id = $2` filter alone cannot do.

### The five reports

**1. Revenue over time** — `owner.js:75-101`
```sql
WITH owned_orders AS (
    SELECT o.id, o.total_amount, o.created_at
    FROM orders o
    JOIN restaurant_branches b ON b.id = o.branch_id
    JOIN restaurants r ON r.id = b.restaurant_id
    WHERE r.id = $1
      AND r.owner_id = $2
      AND o.status <> 'cancelled'
      AND o.created_at >= $3::date
      AND o.created_at < ($4::date + INTERVAL '1 day')
  )
  SELECT
    to_char(series.day, 'YYYY-MM-DD') AS day,
    COUNT(oo.id)::INTEGER AS order_count,
    COALESCE(SUM(oo.total_amount), 0) AS revenue
  FROM generate_series($3::date, $4::date, INTERVAL '1 day') AS series(day)
  LEFT JOIN owned_orders oo
    ON oo.created_at >= series.day
   AND oo.created_at < series.day + INTERVAL '1 day'
  GROUP BY series.day
  ORDER BY series.day
```
The CTE is a named temporary result: *this owner's orders in this window*, and it is where ownership is proved. `generate_series` then manufactures the calendar and the orders are `LEFT JOIN`ed onto it, so a day that sold nothing appears as a zero instead of vanishing and making the trend look shorter than it is.

`to_char` rather than a bare date is deliberate, and the comment at `:87-90` explains it: a `DATE` arrives in Node as a JavaScript `Date` at local midnight and serialises to UTC, which moves the label to the previous day for readers east of Greenwich. **I hit this bug in testing** — every day was labelled one day early in Dhaka.

**2. Top selling items** — `owner.js:113-133`
```sql
SELECT
    mi.id,
    mi.name,
    SUM(oi.quantity)::INTEGER AS quantity_sold,
    SUM(oi.quantity * oi.unit_price) AS revenue,
    COUNT(DISTINCT o.id)::INTEGER AS order_count
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN menu_items mi ON mi.id = oi.menu_item_id
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
    AND o.status <> 'cancelled'
    AND o.created_at >= $3::date
    AND o.created_at < ($4::date + INTERVAL '1 day')
  GROUP BY mi.id, mi.name
  ORDER BY quantity_sold DESC, revenue DESC
  LIMIT 5
```
Five tables. An order line knows its dish and its order, the order knows its branch, the branch knows the restaurant, the restaurant knows its owner. Revenue multiplies by **`oi.unit_price`** — the price recorded on the line at the time — not today's menu price, so raising a price now does not rewrite last month's takings.

**3. Headline with period comparison** — `owner.js:164-281`
Identical in technique to the platform headline documented in **unit 08**: a `bounds` CTE derives the previous window, one `LEFT JOIN` fetches the whole span, and each aggregate's `FILTER` claims its half. Two differences only:
- the dates are `$3`/`$4` (because `$1`/`$2` are already the restaurant and owner);
- the ownership proof is a sub-select inside the join condition —
```sql
AND o.branch_id IN (
       SELECT b.id
       FROM restaurant_branches b
       JOIN restaurants r ON r.id = b.restaurant_id
       WHERE r.id = $1 AND r.owner_id = $2
     )
```
written as a sub-select rather than another join **so the `LEFT JOIN` still yields its single row of zeros** when the restaurant has no orders at all. That is what keeps a brand-new restaurant rendering zeros instead of a blank page.

The rating is a separate bracketed sub-select (`:242-253`) because a review hangs off an order — joining reviews into the main query would multiply the order rows and inflate the revenue. It is a lifetime figure and deliberately ignores the date range.

**4. Busiest hours** — `owner.js:265-281`
```sql
SELECT
    EXTRACT(HOUR FROM o.created_at)::INTEGER AS hour,
    COUNT(o.id)::INTEGER AS order_count,
    COALESCE(SUM(o.total_amount), 0) AS revenue
  FROM orders o
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
    AND o.status <> 'cancelled'
    AND o.created_at >= $3::date
    AND o.created_at < ($4::date + INTERVAL '1 day')
  GROUP BY hour
  ORDER BY hour
```
`EXTRACT(HOUR FROM …)` pulls just the hour number (0-23) out of the timestamp and throws the date away, so `GROUP BY` collapses every order placed in that hour on any day into one row. "We are busiest at 8pm" is one query, not a scan in the browser.

**5. Status breakdown** — `owner.js:289-304`
```sql
SELECT
    o.status,
    COUNT(o.id)::INTEGER AS order_count,
    COALESCE(SUM(o.total_amount), 0) AS order_value
  FROM orders o
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
    AND o.created_at >= $3::date
    AND o.created_at < ($4::date + INTERVAL '1 day')
  GROUP BY o.status
  ORDER BY order_count DESC
```
**The one report that does *not* exclude cancelled orders** — the comment at `:286-288` says why: this is the one place the owner needs to see them, because "how many did we lose" is the point of the breakdown.

### Managing the restaurant

**My restaurants** — `restaurants.js:100-104`
```sql
        FROM restaurants r
        LEFT JOIN restaurant_branches rb
        …
        WHERE r.owner_id = $1
```
`$1` = the token's id. No restaurant id is accepted, so this route cannot be pointed elsewhere.

**Branch ownership check** — `restaurants.js:302-307`
```sql
SELECT id
        FROM restaurants
        WHERE id = $1
          AND owner_id = $2
```
Inside the transaction opened at `:300`; zero rows and not an admin → **403** (`:310-318`).

**Edit the restaurant, ownership in the write** — `restaurants.js:465-468`
```sql
UPDATE restaurants SET name=$1,description=$2,cuisine=$3,
      image_url=$4,image_credit=$5,image_source_url=$6
      WHERE id=$7 AND (owner_id=$8 OR $9='admin') RETURNING *
```
**The admin escape hatch is a bound parameter** (`$9='admin'`), not a branch in JavaScript. Zero rows → 404 (`:472`).

**The menu-write pattern** — shown once, `menu.js:476-483`
```sql
SELECT
          mi.id,
          mi.restaurant_id,
          r.owner_id
        FROM menu_items mi
        JOIN restaurants r
          ON mi.restaurant_id = r.id
        WHERE mi.id = $1
```
then the comparison at `:496-504`. The eight other menu writes are the same shape with a different climb — `menu_categories → restaurants`, or up to four hops for a modifier option. Unit 02 tabulates all nine with only their differences.

---

## Transactions

**Analytics — none, correctly.** Every report is read-only.

**Menu and restaurant writes — all wrapped.** The nine `menu.js` handlers were wrapped in this session's Task A (`BEGIN` at `:213`, `:329`, `:464`, `:573`, `:672`, `:818`, `:916`, `:1005`, `:1091`), joining the three `restaurants.js` writes that already were (`:226`, `:300`, `:387`) plus `PATCH /:id` (`:464`).

This matters for a specific reason. Before Task A, `menu.js` read `owner_id` in one statement and wrote in another with **nothing between them** — a time-of-check-to-time-of-use gap. Now the ownership SELECT and the write share one transaction on one connection, matching what `restaurants.js` already did.

**Review replies — wrapped** (`owner.js:568`, `:628`), with the ownership test inside the UPDATE. See unit 06.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Any analytics read; menu item edited/toggled/deleted; restaurant edited; branch toggled. |
| **201** | Restaurant, branch, category, item, modifier group or option created. |
| **400** | Restaurant id not a positive integer (`owner.js:29`); a malformed, impossible or reversed date, or a range over a year (`utils/dateRange.js` via `owner.js:47-49`); menu field validation (`menu.js:664` and siblings); review filter/sort values (`owner.js:406-431`). |
| **401 / 403** | Not logged in / not an owner. **403** also for a restaurant that is not yours (`owner.js:42`, `restaurants.js:315`), or a menu row that is not yours (`menu.js:503` and eight siblings). |
| **404** | Restaurant does not exist (`owner.js:38`); menu item/category/group/option not found; `PATCH /restaurants/:id` with a restaurant that is not yours (`restaurants.js:472`) — **404 not 403, because the check is inside the write**. |
| **500** | Unexpected failure, per handler. |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **Object-level ownership** | The richest example in the project, enforced **twice**: dedicated middleware (`owner.js:26-52`) for correct status codes, plus `AND r.owner_id = $2` repeated in every query as defence in depth. |
| **Complex query** | Five analytics reports: a CTE + `generate_series` + `LEFT JOIN` calendar; a five-table join with `SUM`/`COUNT(DISTINCT)`; a two-window `FILTER` comparison with percentages; `EXTRACT(HOUR …)` grouping; a `GROUP BY status` breakdown. |
| **No JS aggregation** | Every figure computed in SQL, including the percent changes. |
| **Explicit transaction** | Thirteen writing routes in this slice, all wrapped. |
| **Role authorization** | `requireRole('restaurant_owner')` router-wide on `owner.js`; `requireRole('restaurant_owner','admin')` per route on menu and restaurant management. |
| **TRIGGER (consumed)** | The headline rating reads `restaurants.avg_rating`, maintained by `trg_sync_restaurant_rating`. |
| **Parameterised SQL** | All four analytics parameters bound; `sort` handled by an allowlist, never interpolated as user text. |

---

## Likely viva questions

**1. Show me the join that stops one owner seeing another's revenue.**
`owner.js:78-82` and the same three lines in every other report:
```sql
FROM orders o
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE r.id = $1 AND r.owner_id = $2
```
`$1` is the id from the URL, `$2` is the owner id from the verified token. An order only survives if its branch's restaurant is both the one asked for and owned by the caller. I tested it two ways: owner A calling owner B's restaurant gets 403 from the middleware, and running the query directly with the wrong owner id returns 0 orders and ৳0 instead of the real 2 orders and ৳685.60.

**2. If the middleware already returns 403, why repeat the ownership filter in every query? (design justification)**
Defence in depth, and the two do different jobs. The middleware distinguishes **404** (no such restaurant) from **403** (exists, not yours) — a `WHERE` filter alone cannot tell those apart, it just returns nothing. The repeated filter means that if someone later adds a route and forgets the middleware, or edits the middleware wrongly, the worst case is an empty result rather than another owner's takings. The comment at `owner.js:23-24` states exactly this. It is cheap insurance on the highest-value data in the app.

**3. Why does the headline query prove ownership with a sub-select instead of a join, when every other report uses a join?**
Because that query needs a row even when there are no orders. It is a `LEFT JOIN` from `bounds` to `orders`, and the aggregates must still return zeros so a brand-new restaurant renders zeros rather than a blank page. If ownership were another join in that chain, a restaurant with no matching orders would produce no row at all. As a sub-select inside the join condition (`AND o.branch_id IN (...)`), it filters the orders without affecting whether the `bounds` row survives.

**4. Why is `to_char` used for the day label instead of returning the date?**
Because a `DATE` comes back to Node as a JavaScript `Date` object at local midnight, and serialising that to JSON converts it to UTC. In Dhaka (UTC+6) local midnight is 18:00 UTC the previous day, so every label shifted back one day — I saw it in testing, Sept 10 rendering as Sept 9. Returning the text form means the day the database grouped by is exactly the day displayed.

**5. Your status breakdown includes cancelled orders but every other report excludes them. Is that a bug?**
No, deliberate, and commented at `owner.js:285-287`. Revenue, top items and busiest hours all answer "how did the business do", and a cancelled order was never money, so including it would overstate everything. The status breakdown answers a different question — "where did my orders end up" — and "how many did we lose" is the whole point of it. Excluding cancellations there would hide the one number the owner most needs.

---

## Gaps and defects

**DML with no transaction**
- **None remaining.** All nine `menu.js` writes and all four `restaurants.js` writes are wrapped. Before this session's Task A, the nine menu writes were read-then-write pairs with no transaction and no row lock — that defect is now fixed, and it is worth knowing it existed because `restaurants.js` had always done it correctly, which made the inconsistency hard to defend.

**Ownership bypassable via an id in the URL or body**
- None found. Every analytics route is double-guarded; `GET /restaurants/mine` accepts no id at all; the menu writes climb to `owner_id` before writing; `PATCH /restaurants/:id` puts the test inside the UPDATE.
- Two notes, not holes: the menu and restaurant routes allow **`admin`** as well as the owner (`menu.js:426`, `restaurants.js:451`), so an admin can edit any restaurant's menu — intended, but it means the 403 is skipped entirely for admins. And `PATCH /restaurants/:id` returns **404** where the branch routes return **403** for the same situation, because one puts the check in the write and the other checks first.

**SQL built by string concatenation**
- None carrying user text. `${OWNED_REVIEWS_FROM}` (`owner.js:465`, `:481`, `:521`, `:540`) is a fixed constant defined at `:376-381`; `${REVIEW_SORTS[sort]}` (`:470`) is one of four literals chosen after validation at `:406-408`; `${MAX_REVIEW_LIMIT}` and `${MAX_REPLY_LENGTH}` appear only in error messages.

**Other defects**

1. **Three ownership idioms for one rule.** `owner.js` uses middleware + repeated filter; `menu.js` uses fetch-then-compare in JavaScript; `restaurants.js` uses both (`:302` for branches, `:467` inside the write). All three are correct, but having three ways to express one rule is how one of them eventually gets forgotten.
2. **The analytics date range is capped at one year** (`utils/dateRange.js`) with a 400, but the UI's custom picker does not prevent choosing a longer one — the user gets an error they could not have predicted.
3. **No index supports the analytics date scans.** Every report filters `orders.created_at` for one restaurant; `idx_orders_branch_status_created` (`place_order.sql:13`) leads with `branch_id`, which helps only if the planner can push the branch set down. There is no index on `(branch_id, created_at)` alone.
4. **`DELETE /api/menu/items/:itemId` hard-deletes** (`menu.js:707`). `order_items.menu_item_id` references `menu_items` with no `ON DELETE` clause (`schema.sql:477-508`), so deleting an item that was ever ordered fails on a foreign key — surfacing as a **500**, not a clean 409. Items that have never sold delete fine, which makes the failure look random.
5. **The owner sees revenue but never a payout.** Every figure is gross collected value; nothing models commission, rider pay or settlement, and `BusinessSummary.jsx` says so in a footnote. Worth stating before an examiner asks whether "revenue" is the owner's money.
6. **The analytics headline's rating ignores the date range** while every other figure respects it — correct (a lifetime rating is the useful one) but it sits in the same row of tiles as four period-scoped numbers with only a small "lifetime" caption to distinguish it.
7. **No bulk menu operations.** Toggling twenty items means twenty requests, twenty transactions and twenty ownership climbs.

---

## Explain-it-in-60-seconds

The owner dashboard is where object-level ownership really has to work, because the restaurant id sits right there in the URL and anyone could type a different number. So it's guarded twice. First there's a dedicated middleware that loads the restaurant, returns 404 if it doesn't exist and 403 if the `owner_id` doesn't match the id in the token — you need both statuses, and a WHERE filter alone can't tell them apart. Then, on top of that, every single analytics query repeats `AND r.owner_id = $2`. That's deliberate redundancy: if someone later adds a route and forgets the middleware, the query returns nothing instead of another owner's revenue.

The join itself is three lines and appears in every report: orders → branches → restaurants, filtered on both the restaurant id and the owner id. It takes two hops because an order stores which *branch* it was placed at, not which restaurant.

There are five reports and all the arithmetic is in SQL. Revenue-by-day uses a CTE for this owner's orders plus generate_series to manufacture the calendar, so quiet days come back as zeros rather than disappearing. Top items joins five tables and values each sale at the price stored on the order line, not today's menu price. The headline does period-over-period in one pass — one join fetches both windows and FILTER splits them — and it proves ownership with a sub-select rather than a join, specifically so a restaurant with no orders still gets a row of zeros instead of a blank page.

One detail I got wrong first time: the day label. A DATE comes back to Node as a Date object and serialises to UTC, so in Dhaka every day was labelled one day early. Returning `to_char(...)` text fixed it.

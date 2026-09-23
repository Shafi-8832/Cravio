# 08 — Admin, analytics & platform operations

> Includes `routes/operations.js` (support tickets, promo codes, platform orders) — six of its eight routes are admin-gated, so it belongs here rather than in a unit of its own.

## Files involved

**Frontend**
- `frontend/src/pages/AdminDashboardPage.jsx` — the control room: orders, users, promos, support tabs.
- `frontend/src/pages/AdminAnalyticsPage.jsx` — the platform analytics page at `/admin/analytics`.
- `frontend/src/components/DateRangePicker.jsx` — the Today / 7 / 30 / Custom selector, shared with the owner dashboard.
- `frontend/src/utils/dateRange.js` — preset helpers, kept out of the component file.
- `frontend/src/components/SupportPanel.jsx`, `BusinessSummary.jsx`.
- `frontend/src/services/adminApi.js`, `operationsApi.js`.

**Route**
- `backend/routes/admin.js` — `GET /users` (`:17`), `PATCH /users/:id/status` (`:107`), `GET /stats` (`:182`).
- `backend/routes/adminAnalytics.js` — mounted at `/api/admin/analytics` (`server.js:71`, **before** the general admin router). Seven routes.
- `backend/routes/operations.js` — eight routes; `router.use(authenticateToken)` at `:7`, then `requireRole('admin')` per route.

**Controller**
- None. `backend/utils/dateRange.js` holds the shared `resolveRange` validator.

**Middleware**
- `adminAnalytics.js:18` — **`router.use(authenticateToken, requireRole('admin'))`**, one line covering all seven routes.
- `admin.js` applies both per-route (`:19-20`, `:109-110`, `:184-185`).

**SQL**
- No dedicated schema. Reads across `users`, `orders`, `restaurants`, `restaurant_branches`, `deliveries`, `restaurant_reviews`, `payments`; writes to `users.is_active`, `support_tickets`, `promo_codes`.
- `backend/db/migrations/004_operations.sql` — `support_tickets`.
- `backend/db/schema.sql:370-410` — `promo_codes`.

---

## Flow

### The gate — and why it matters more here

Unlike the owner dashboard, **there is no ownership scoping to fall back on**: an admin is supposed to see everything, so the role check is the entire defence. It is one line, `adminAnalytics.js:18`, applied with `router.use` so any route added below it is guarded by default rather than by remembering.

1. `authenticateToken` — bad/missing/revoked token → **401**; suspended account → **403**. It re-reads the row, so `req.user.role` is the database's answer. **Editing `role` inside a token breaks the signature**, so forging admin is a 401, not a promotion.
2. `requireRole('admin')` — any authenticated customer, rider or owner → **403**.

### Platform analytics

1. `AdminAnalyticsPage` calls `GET /api/admin/analytics?from=&to=` (`adminApi.js`).
2. `withRange` (`adminAnalytics.js:23-31`) validates the dates through the shared `resolveRange` (`utils/dateRange.js`) → **400** for a bad shape, an impossible calendar day, a reversed range, or a window over a year.
3. `:329` runs all six reports in parallel and returns them in one response.
4. Each report also has its own address (`:305-308`, `:311`, `:318`) behind the identical gate.
5. The page renders headline stats with deltas, then trend, top restaurants, rider performance, user growth, and the status breakdown.

### Managing users

1. `GET /api/admin/users?role=&page=&limit=` (`:17`) — validates `page`, `limit` (max 100) and `role` against `ALLOWED_ROLES` (`:8`) → **400**.
2. `:44-49` builds the optional `WHERE` by pushing values and `$n` **placeholder numbers**, never the values themselves.
3. `PATCH /api/admin/users/:id/status` (`:107`) — `:127-131` **refuses self-suspension server-side**, not only in the UI → **400**. `:136` `BEGIN`, `:138-143` the UPDATE, no rows → **404**, else COMMIT → **200**.
4. A suspended account is locked out on its **next request**, not at next login, because `authenticateToken` re-reads `is_active` every time.

### Support tickets and promos

1. `GET /api/operations/tickets` (`:10`) — any authenticated user; **the scope is in the SQL**: `WHERE ($1 = 'admin' OR t.user_id = $2)`.
2. `POST /api/operations/tickets` (`:20`) — if an `order_id` is supplied, `:31-35` proves the caller is connected to that order in **any of four capacities** → **404** otherwise. `BEGIN` at `:29`.
3. `PATCH /api/operations/tickets/:id` (`:52`), `POST/PATCH /promos` (`:88`, `:114`) — admin only, each wrapped.
4. `GET /api/operations/orders` (`:135`) and `/summary` (`:149`) — the summary serves three roles from one query.

---

## The SQL

### The recurring pattern: period-over-period in one row

Both dashboards use the same technique, so it is shown once here in full.

**Platform headline** — `adminAnalytics.js:49-118`
```sql
WITH bounds AS (
    SELECT
      $1::date AS current_from,
      $2::date AS current_to,
      ($2::date - $1::date + 1) AS period_days,
      ($1::date - ($2::date - $1::date + 1)) AS previous_from,
      ($1::date - 1) AS previous_to
  ),
  order_totals AS (
    SELECT
      COUNT(o.id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER AS current_orders,
      COUNT(o.id) FILTER (WHERE o.created_at < bounds.current_from)::INTEGER AS previous_orders,
      COALESCE(SUM(o.total_amount) FILTER (
        WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled'), 0) AS current_revenue,
      …
    FROM bounds
    LEFT JOIN orders o
      ON o.created_at >= bounds.previous_from
     AND o.created_at < (bounds.current_to + INTERVAL '1 day')
    GROUP BY bounds.current_from
  ),
  user_totals AS ( … same shape over users … )
  SELECT
    (SELECT COUNT(*) FROM users)::INTEGER AS total_users,
    (SELECT COUNT(*) FROM restaurants)::INTEGER AS total_restaurants,
    order_totals.*, user_totals.*,
    ROUND((order_totals.current_revenue - order_totals.previous_revenue)
          / NULLIF(order_totals.previous_revenue, 0) * 100, 1) AS revenue_change_pct,
    …
  FROM order_totals, user_totals, bounds
```
Three parts:
- **`bounds`** derives the comparison window in SQL. Its length is the current window's length; it ends the day before. Ask for 1-30 September and you are compared against 2-31 August, with no arithmetic in Node.
- **`order_totals`** is the trick: the `LEFT JOIN` fetches the *whole* span — previous start to current end — in **one scan**, and each aggregate's `FILTER` claims its half. Two windows, one pass, one row. Orders and users are separate CTEs because they are unrelated tables; joining them would multiply rows and invent numbers.
- **The final SELECT** computes the percentages, also in SQL. `NULLIF(previous, 0)` makes the divisor NULL when the previous period was empty, and `x / NULL` is NULL — which the page reads as "no comparison" instead of dividing by zero.

The owner dashboard's headline (`owner.js:164-281`) follows this pattern exactly; its only differences are `$3`/`$4` for the dates instead of `$1`/`$2`, and an ownership filter (`AND r.owner_id = $2`) inside the join. See unit 07.

### The other five platform reports

**Trend** — `adminAnalytics.js:121-137`
```sql
SELECT
    to_char(series.day, 'YYYY-MM-DD') AS day,
    COUNT(o.id)::INTEGER AS order_count,
    COUNT(o.id) FILTER (WHERE o.status = 'cancelled')::INTEGER AS cancelled_count,
    COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0) AS revenue,
    COUNT(DISTINCT o.customer_id)::INTEGER AS customers
  FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS series(day)
  LEFT JOIN orders o
    ON o.created_at >= series.day
   AND o.created_at < series.day + INTERVAL '1 day'
  GROUP BY series.day
  ORDER BY series.day
```
`generate_series` manufactures the calendar so a quiet day appears as a zero rather than dropping out and making the trend look shorter. `to_char` rather than a bare date is deliberate: a `DATE` arrives in Node as a JavaScript `Date` and serialises to UTC, which can move the label a day for readers east of Greenwich.

**Top restaurants** — `adminAnalytics.js:148-175`. Walks `orders → restaurant_branches → restaurants`, plus `LEFT JOIN users` for the owner's name. The rating is a **correlated sub-select**, not a fifth join — a review hangs off an order, so joining reviews here too would multiply the order rows and inflate the revenue.

**Rider performance** — `adminAnalytics.js:191-228`
```sql
ROUND(
      100.0 * COUNT(d.id) FILTER (
        WHERE d.delivery_status = 'delivered'
          AND d.delivery_time IS NOT NULL
          AND d.delivery_time <= o.created_at + make_interval(mins => b.eta_max)
      ) / NULLIF(COUNT(d.id) FILTER (WHERE d.delivery_status = 'delivered'), 0),
      1
    ) AS on_time_rate_pct
```
Joins `deliveries → orders → users → restaurant_branches`. **On-time is answerable from the existing schema** because `restaurant_branches.eta_max` is the outer end of the quoted window: the food arrived no later than order time plus that many minutes. `make_interval` turns the stored integer into something addable to a timestamp.

**User growth** — `adminAnalytics.js:234-250`. Same calendar trick over `users.created_at`, with the roles split by `FILTER` so one row per day carries that day's whole composition rather than one row per day per role.

**User composition** — `adminAnalytics.js:257-266`
```sql
SELECT
    u.role,
    COUNT(*)::INTEGER AS user_count,
    COUNT(*) FILTER (WHERE u.is_active)::INTEGER AS active_count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct
  FROM users u
  GROUP BY u.role
  ORDER BY user_count DESC
```

**Status breakdown** — `adminAnalytics.js:277-289`
```sql
SELECT
    o.status,
    COUNT(*)::INTEGER AS order_count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS percentage,
    COALESCE(SUM(o.total_amount), 0) AS order_value
  FROM orders o
  WHERE o.created_at >= $1::date
    AND o.created_at < ($2::date + INTERVAL '1 day')
  GROUP BY o.status
  ORDER BY order_count DESC
```
**The share is computed in SQL by a window function.** `COUNT(*)` is this status's own count; `SUM(COUNT(*)) OVER ()` adds those counts across every row the `GROUP BY` produced — the grand total — so each row becomes a percentage of the whole without a second query. `100.0` not `100`, or integer division would floor every share to a whole number.

### Admin user management

**Paged user list** — `admin.js:60-78`
```sql
SELECT
  id,
  name,
  email,
  role,
  phone,
  is_active,
  created_at,
  COUNT(*) OVER()::INTEGER AS total_count
FROM users
${whereClause}
ORDER BY created_at DESC
LIMIT $${values.length - 1}
OFFSET $${values.length}
```
The interpolations are **placeholder numbers and a clause assembled from a fixed template** (`:44-52`) — the `role` value itself is pushed into `values` and bound. Password is never selected. `COUNT(*) OVER()` (`:69`) again supplies the total alongside the page.

**Suspend / reactivate** — `admin.js:139-144`
```sql
UPDATE users
        SET is_active = $1
        WHERE id = $2
        RETURNING id, name, email, role, phone, is_active, created_at
```
`$1` boolean, `$2` the target id from the URL — **no ownership check, correctly**: that is the admin's entire job. Self-suspension is blocked before this runs (`:127-131`).

**Legacy stats** — `admin.js:189-191`
```sql
SELECT role, COUNT(*)::INTEGER AS count FROM users GROUP BY role
```
```sql
SELECT status, COUNT(*)::INTEGER AS count FROM orders GROUP BY status
```

### Operations — role folded into the WHERE

**Tickets** — `operations.js:12-15`
```sql
SELECT t.*, u.name AS user_name, u.role AS user_role
      FROM support_tickets t JOIN users u ON u.id = t.user_id
      WHERE ($1 = 'admin' OR t.user_id = $2)
      ORDER BY t.created_at DESC LIMIT 100
```
One query, two audiences: an admin sees everything, anyone else sees only their own. `$1` role and `$2` id, both from the token.

**Ticket order check** — `operations.js:31-34`
```sql
SELECT o.id FROM orders o
        JOIN restaurant_branches b ON b.id = o.branch_id JOIN restaurants r ON r.id = b.restaurant_id
        WHERE o.id = $1 AND ($2 = 'admin' OR o.customer_id = $3 OR o.rider_id = $3 OR r.owner_id = $3)
```
Proves the caller is connected to that order as **customer, rider, owner or admin** before letting them file a ticket against it. No match → 404.

**Business summary** — `operations.js:149-159`
```sql
FROM orders o JOIN restaurant_branches b ON b.id = o.branch_id
      JOIN restaurants r ON r.id = b.restaurant_id LEFT JOIN payments p ON p.order_id = o.id
      WHERE ($1 = 'admin' OR ($1 = 'restaurant_owner' AND r.owner_id = $2) OR ($1 = 'rider' AND o.rider_id = $2))
```
Three roles, one query, each seeing only its own slice. The `LEFT JOIN payments` lets the aggregate count collected money per role.

---

## Transactions

Analytics is entirely read-only and opens none, correctly.

The five writes in this slice are all wrapped — **all five were wrapped during this session's Task A**:

| Route | BEGIN | Contains |
|---|---|---|
| `PATCH /api/admin/users/:id/status` | `admin.js:136` | one UPDATE |
| `POST /api/operations/tickets` | `operations.js:29` | the order-ownership SELECT **and** the INSERT — a genuine multi-statement case |
| `PATCH /api/operations/tickets/:id` | `operations.js:61` | one UPDATE |
| `POST /api/operations/promos` | `operations.js:100` | one INSERT; the `23505` duplicate branch now rolls back first |
| `PATCH /api/operations/promos/:id` | `operations.js:119` | one UPDATE |

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Any analytics read; user list; suspension changed (`admin.js:155`); ticket or promo updated. |
| **201** | Ticket created (`operations.js:43`), promo created (`operations.js:104`). |
| **400** | Bad `page`/`limit` (`admin.js:27`, `:33`), unknown `role` (`:39`), bad target id or non-boolean `is_active` (`:116`, `:122`), **self-suspension** (`:127-131`); malformed/impossible/reversed dates or a range over a year (`utils/dateRange.js` via `adminAnalytics.js:25-26`); ticket or promo validation (`operations.js:24`, `:26`, `:56`, `:90`). |
| **401** | No, invalid, expired or revoked token — including a token whose `role` was edited. |
| **403** | **Any authenticated non-admin** on every analytics route and the six admin-gated operations routes. |
| **404** | User not found (`admin.js:148`), ticket or promo not found (`operations.js:66`, `:123`), order not yours when filing a ticket (`operations.js:37`). |
| **409** | Duplicate promo code (`operations.js:107`, the `23505` path). |
| **500** | Unexpected failure (`admin.js:165`, `:203`) or the global handler. |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **Role authorization** | The headline requirement of this slice. One `router.use` line guards seven analytics routes; the rubric's 401/403 split is exact. Verified by calling every endpoint as customer, rider, owner, admin, no-token, and with a forged-role token. |
| **Complex query** | Six reports, every one multi-table or aggregate: CTEs with `FILTER` for period comparison, `generate_series` + `LEFT JOIN` for calendars, a four-table rider join with interval arithmetic, window functions for shares. |
| **No JS aggregation** | Every number is computed in SQL, including the percentages. |
| **Parameterised SQL** | All dates and filters bound. The two interpolations in `admin.js` are placeholder numbers, not values. |
| **Explicit transaction** | Five writes, all wrapped. |
| **Object-level ownership** | Deliberately absent for admins — and *present* in the same file for non-admins, via the `($1 = 'admin' OR …)` pattern in `operations.js`. |
| Trigger / function / procedure | None in this slice; it reads what the others maintain. |

---

## Likely viva questions

**1. What exactly protects the admin analytics, and how do you know it works?**
Two middleware, applied once at `adminAnalytics.js:18`: `authenticateToken` for 401 and `requireRole('admin')` for 403. I tested all seven routes against five identities — no token, customer, rider, owner, admin — and the matrix is 401 / 403 / 403 / 403 / 200 with no exceptions. I also took a customer's valid token, edited `role` to `admin` in the payload, and re-sent it: **401**, because changing the payload breaks the HMAC signature.

**2. Why does the role check matter more here than on the owner dashboard? (design justification)**
Because the owner dashboard has two independent defences — the role gate *and* an ownership filter in every query — so a mistake in one still leaves the other. An admin is supposed to see the whole platform, so there is no ownership filter to fall back on: the role check is the entire defence. That is exactly why it is applied with `router.use` at the top of the file rather than per route — a new endpoint added below is guarded by default instead of relying on someone remembering.

**3. How do you compute a period-over-period change without two round trips?**
`bounds` derives the previous window in SQL — same length, ending the day before. Then the join fetches the whole span at once and every aggregate uses `FILTER` to say which half it wants: `>= current_from` is this period, `< current_from` is the one before. One scan, one row, both numbers. The percentage is computed in the outer SELECT too, with `NULLIF(previous, 0)` so an empty previous period gives NULL — "no comparison" — rather than a division by zero.

**4. Why is the status percentage a window function rather than JavaScript?**
Because `GROUP BY o.status` gives me each status's count but not the total, and the rubric forbids aggregating in JS. `SUM(COUNT(*)) OVER ()` sums the counts *across the grouped rows* — a window over the result of the aggregation — which is the grand total. So each row can express itself as a share of the whole in the same statement. The `100.0` is deliberate: with an integer `100`, Postgres would do integer division and floor every share.

**5. Your `admin.js` user list interpolates `${whereClause}` and `$${values.length}` into the SQL. Justify that.**
Neither interpolates a *value*. `whereClause` is built at `:44-52` from a fixed template — `role = $n` — and the role itself is pushed into the `values` array and bound; `role` was also validated against `ALLOWED_ROLES` at `:38`. `$${values.length}` interpolates a **placeholder number**, so the text that lands in the query is literally `$3`. Nothing a user typed becomes part of the statement.

---

## Gaps and defects

**DML with no transaction**
- None remaining. All five writes were wrapped in this session's Task A.

**Ownership bypassable via an id in the URL or body**
- `PATCH /api/admin/users/:id/status` takes a target id with no ownership check — **correct by design**, it is the admin capability. Self-suspension is blocked server-side at `:127-131`, so an admin cannot lock themselves out.
- No bypass found elsewhere. The operations routes fold the identity into the `WHERE` from the token (`:14`, `:33`, `:158`), so a non-admin cannot widen their view by changing an id.

**SQL built by string concatenation**
- Two occurrences in `admin.js`, both safe and both explained above: `${whereClause}` (`:71`) and `$${values.length}` (`:74-75`). Neither carries user text.
- None anywhere in `adminAnalytics.js` or `operations.js`.

**Other defects**

1. **`GET /api/admin/stats` is dead weight.** `admin.js:182-197` returns counts by role and by status that `adminAnalytics.js` now computes better (`:257`, `:277`). Two endpoints answer the same question with different shapes, and the older one has no date range.
2. **No audit trail for admin actions.** Suspending a user (`admin.js:139`) writes nothing anywhere. Orders have `order_events` and logouts have `revoked_tokens`, but the most consequential action in the app — disabling an account — leaves no record of who did it or when.
3. **A suspended user's live sessions are not revoked**, only blocked. `authenticateToken:42` returns 403 on every request, which is the right outcome, but the token stays valid in `revoked_tokens` terms — so reactivating the account silently restores every session that existed before suspension.
4. **The one-year range cap is arbitrary and undocumented to the client.** `utils/dateRange.js` rejects a longer window with a 400, but nothing in the UI prevents picking one, so a custom range of 400 days fails with an error the user cannot predict.
5. **`GET /api/operations/tickets` caps at 100 rows with no pagination** (`operations.js:15`). An admin on a busy platform silently sees only the newest hundred.
6. **Promo codes are uppercased on create** (`operations.js:103`) but nothing normalises them on redemption, so the matching depends on `place_order`'s own handling — two places that must agree about case.
7. **Analytics has no caching and no index support for the date scans.** Every report scans `orders` by `created_at`; `idx_orders_customer_created` and `idx_orders_branch_status_created` (`place_order.sql:10`, `:13`) both lead with another column, so a platform-wide date range cannot use either.

---

## Explain-it-in-60-seconds

The admin side is the one place where the role check is the *only* thing protecting the data, because an admin is supposed to see everything — there's no ownership filter to fall back on like there is on the owner dashboard. So it's one line at the top of the file, `router.use(authenticateToken, requireRole('admin'))`, which means any route added below it is guarded by default. I tested all seven analytics endpoints against every identity, including a token where I edited the role to admin — that comes back 401, because editing the payload breaks the signature.

Every number is computed in SQL. The headline stats do period-over-period comparison in a single query: a CTE works out the previous window — same length, ending the day before — then one join fetches the whole span and each aggregate uses FILTER to claim its half. Two periods, one scan, one row, and the percentage change is calculated in SQL too, with NULLIF so an empty previous period gives "no comparison" rather than dividing by zero.

The trend and growth reports use generate_series to manufacture the calendar and LEFT JOIN onto it, so a quiet day shows a zero instead of vanishing and making the chart look shorter. The status breakdown gets its percentage from a window function — `SUM(COUNT(*)) OVER ()` is the grand total across the grouped rows, so each status becomes a share of the whole without a second query.

And in the operations file there's a nice contrast: the same queries serve non-admins by folding the identity into the WHERE clause — "is admin, OR this row is yours" — so one statement serves three roles and each sees only its own slice. The gap I'd own up to: suspending a user leaves no audit record at all.

# 09 — Account & profile

> **Unit added by me, not in the original list.** `routes/account.js` (10 routes) and `routes/profile.js` (5 routes) are 15 of the API's ~88 routes and fit none of the eight units given. Leaving them out would leave a hole an examiner could walk into — they contain the password change, the address book, and the role-branching profile.

## Files involved

**Frontend**
- `frontend/src/pages/AccountPage.jsx` — one page, served at both `/account` and `/profile`; branches on the role the **server** returns (`:19-30`).
- `frontend/src/components/profile/ProfileIdentity.jsx` — the block every role shares: name, phone, read-only email, change password.
- `frontend/src/components/profile/CustomerProfile.jsx` — stats, recent orders, the address book CRUD, favourites.
- `frontend/src/components/profile/RiderProfile.jsx` — availability toggle, vehicle, delivery record.
- `frontend/src/components/profile/OwnerProfile.jsx` — restaurants owned, counts, rating.
- `frontend/src/components/profile/AdminProfile.jsx` — platform totals, deliberately thin.
- `frontend/src/services/profileApi.js`, `accountApi.js` — the wrappers.

**Route**
- `backend/routes/account.js` — `router.use(authenticateToken)` at `:10`, then **`router.use(requireRole('customer'))` at `:85`**. Everything above line 85 is open to all four roles; everything below is customer-only.
- `backend/routes/profile.js` — `router.use(authenticateToken)` at `:13`; `GET /` at `:275` plus four role-scoped variants at `:303-306`.

**Controller**
- None. Both files query directly. `profile.js` uses five builder functions (`:20`, `:36`, `:94`, `:157`, `:229`) dispatched through a table at `:262`.

**Middleware**
- `authenticateToken` on both routers; `requireRole('customer')` on the lower half of `account.js`; `requireRole(<role>)` per variant in `profile.js:296`.

**SQL**
- `backend/db/schema.sql:131-164` — `customer_addresses`; `003_marketplace.sql:29-34` adds division/city/phone/lat/long.
- `003_marketplace.sql:36-41` — `customer_favorites`, primary key `(user_id, restaurant_id)`.

---

## Flow

### Opening the profile

1. `AccountPage` mounts and calls `GET /api/profile` **with no arguments at all** (`AccountPage.jsx:40`).
2. `profile.js:13` verifies the session. `:276` loads the shared account block by `req.user.id`.
3. `:281` looks `req.user.role` up in `PROFILE_BUILDERS` (`:262-267`) and runs the matching builder, passing only the token's id (`:282`).
4. The response carries `{ user, role, ...role-specific }`; React reads `profile.role` — **the server's answer, not the localStorage copy** — and renders one of four components (`AccountPage.jsx:19-30`).
5. The four variants `/api/profile/customer|rider|owner|admin` (`:303-306`) return the same payloads, each behind `requireRole`, so each answers **403** to anyone else. The page does not use them; they exist so the enforcement is written down rather than implied by the dispatch table (comment at `:288-293`).

### Editing shared details

1. `PATCH /api/account/profile` — name and phone only. `account.js:21-23` validates → **400**.
2. `:26` `BEGIN`, `:28-31` the UPDATE, `:33` COMMIT → **200**. **`role` and `email` are not in the SET list**, so this endpoint cannot change who the account is.

### Changing the password

1. `PATCH /api/account/password` with `{ current_password, new_password }`.
2. `:48-54` validates: current present, new 8-72 bytes, and different from the current → **400**.
3. `:56` `BEGIN`. `:59` reads the stored hash by `id = req.user.id`. Missing → **404**.
4. `:65` `bcrypt.compare` proves the current password → **403** if wrong. **A stolen open session is not enough to lock the real owner out.**
5. `:71-73` hashes and writes the new one, `:75` COMMIT → **200**.

### The address book

1. `GET /api/account/addresses` (`:87`) — filtered by `user_id = req.user.id`, default first.
2. `POST` / `PATCH` share `saveAddress` (`:94`, wired at `:151-152`). `:116` `BEGIN`, then **`:118` locks the user row `FOR UPDATE`** — the comment says why: two concurrent requests must not each create a default address.
3. On an edit, `:120-126` proves the address belongs to the caller → **404** if not.
4. `:128-130` caps the book at 20 → **409**; the first address is forced default (`:131`).
5. `:132` clears any existing default before setting a new one. `:136-143` inserts or updates. COMMIT → **201** or **200**.
6. `DELETE /addresses/:id` (`:153`) — `BEGIN` at `:158`, `DELETE … AND user_id=$2 RETURNING id`; no rows → **404**; else **204**.

### Favourites

`PUT /favorites/:restaurantId` (`:180`) upserts; `DELETE` (`:203`) removes. Both wrapped, both keyed on the token's id.

---

## The SQL

**1. The shared account block** — `profile.js:22-24`
```sql
SELECT id, name, email, phone, role, created_at
     FROM users
     WHERE id = $1
```
`$1` = `req.user.id`. **The password column is never selected.** No user id is accepted from the caller, so this cannot be pointed at another account.

**2. Customer lifetime totals** — `profile.js:43-50`
```sql
SELECT
       COUNT(*)::INTEGER AS total_orders,
       COUNT(*) FILTER (WHERE status = 'delivered')::INTEGER AS delivered_orders,
       COUNT(*) FILTER (WHERE status = 'cancelled')::INTEGER AS cancelled_orders,
       COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS total_spent,
       COALESCE(AVG(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS average_order_value
     FROM orders
     WHERE customer_id = $1
```
One scan answering five questions. `FILTER` splits them: everything is counted, but only non-cancelled orders are added up — a cancelled order happened, but was never paid for. `COALESCE` turns the NULL of an empty sum into `0`, which is what stops a new account rendering `NaN`.

**3. Recent orders** — `profile.js:58-72`
```sql
SELECT
       o.id,
       o.status,
       o.total_amount,
       o.created_at,
       r.name AS restaurant_name,
       b.area AS branch_area
     FROM orders o
     JOIN restaurant_branches b ON b.id = o.branch_id
     JOIN restaurants r ON r.id = b.restaurant_id
     WHERE o.customer_id = $1
     ORDER BY o.created_at DESC
     LIMIT 5
```
An order stores a branch, not a restaurant, so the two joins walk order → branch → restaurant for the name.

**4. Saved counts, in SQL not JavaScript** — `profile.js:76-78`
```sql
SELECT
       (SELECT COUNT(*) FROM customer_addresses WHERE user_id = $1)::INTEGER AS address_count,
       (SELECT COUNT(*) FROM customer_favorites WHERE user_id = $1)::INTEGER AS favorite_count
```
Two independent aggregates as columns of one row — deliberately not `list.length` in the browser.

**5. Rider record** — `profile.js:109-121`
```sql
SELECT
       COUNT(*)::INTEGER AS deliveries_assigned,
       COUNT(*) FILTER (WHERE d.delivery_status = 'delivered')::INTEGER AS deliveries_completed,
       ROUND(
         EXTRACT(EPOCH FROM AVG(d.delivery_time - o.created_at)
           FILTER (WHERE d.delivery_status = 'delivered' AND d.delivery_time IS NOT NULL)
         ) / 60
       )::INTEGER AS average_delivery_minutes,
       COALESCE(SUM(o.delivery_fee) FILTER (WHERE d.delivery_status = 'delivered'), 0) AS delivery_fees_earned
     FROM deliveries d
     JOIN orders o ON o.id = d.order_id
     WHERE d.rider_id = $1
```
`deliveries` knows when the food arrived, `orders` knows when it was ordered — hence the join. Subtracting two timestamps gives an interval; `AVG` averages intervals; `EXTRACT(EPOCH …)/60` turns the result into whole minutes.

**6. Owner restaurants** — `profile.js:165-179`
```sql
SELECT
       r.id,
       r.name,
       r.cuisine,
       r.avg_rating,
       r.review_count,
       COUNT(DISTINCT b.id)::INTEGER AS branch_count,
       COUNT(DISTINCT mi.id)::INTEGER AS menu_item_count
     FROM restaurants r
     LEFT JOIN restaurant_branches b ON b.restaurant_id = r.id
     LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
     WHERE r.owner_id = $1
     GROUP BY r.id, r.name, r.cuisine, r.avg_rating, r.review_count
     ORDER BY r.name
```
Two independent `LEFT JOIN`s multiply the rows — 10 branches × 55 items = 550 combinations — which is exactly why both counts are `COUNT(DISTINCT …)`. `LEFT` keeps a brand-new restaurant with no branches and no menu visible, showing zeros.

**7. Owner weighted rating** — `profile.js:205-215`
```sql
SELECT
       ROUND(
         SUM(r.avg_rating * r.review_count) / NULLIF(SUM(r.review_count), 0),
         2
       ) AS average_rating,
       COALESCE(SUM(r.review_count), 0)::INTEGER AS review_count,
       COUNT(*)::INTEGER AS restaurant_count
     FROM restaurants r
     WHERE r.owner_id = $1
```
Averaging the averages would let a restaurant with 2 reviews weigh as much as one with 200, so each average is multiplied by its own review count before dividing. `NULLIF(…, 0)` turns a zero divisor into NULL — "no rating yet" — instead of a division-by-zero error.

**8. Admin composition** — `profile.js:234-237`
```sql
SELECT role, COUNT(*)::INTEGER AS count
     FROM users
     GROUP BY role
     ORDER BY role
```
Collapses the whole users table into four rows, counted by the database.

**9. Address-book serialisation lock** — `account.js:118`
```sql
SELECT id FROM users WHERE id = $1 FOR UPDATE
```
`$1` = the token's id. It selects nothing useful — **it is taken purely for the lock**, so two concurrent saves cannot both pass the "clear the old default" step and leave two defaults.

**10. Address ownership on edit** — `account.js:121`
```sql
SELECT id FROM customer_addresses WHERE id = $1 AND user_id = $2
```
`$1` address id from the URL, `$2` the token's id. No match → 404.

**11. Save the address** — `account.js:136-143`
```sql
UPDATE customer_addresses SET label=$2, area=$3, full_address=$4,
          division=$5, city=$6, phone=$7, is_default=$8, latitude=$9, longitude=$10
          WHERE user_id=$1 AND id=$11 RETURNING *
```
Note `WHERE user_id=$1` is present **again** even though ownership was already proved at `:121` — the write itself is scoped, so the two statements cannot disagree.

**12. Favourite upsert** — `account.js:186-189`
```sql
INSERT INTO customer_favorites(user_id,restaurant_id)
      SELECT $1,id FROM restaurants WHERE id=$2
      ON CONFLICT (user_id,restaurant_id) DO UPDATE SET restaurant_id=EXCLUDED.restaurant_id
      RETURNING restaurant_id
```
`INSERT … SELECT` so a nonexistent restaurant inserts nothing and `rowCount` is 0 → **404**; `ON CONFLICT` makes favouriting twice harmless.

---

## Transactions

Every write in this slice is wrapped. Six of the seven were wrapped during this session's Task A; only `saveAddress` had one already.

| Route | BEGIN | Contains |
|---|---|---|
| `PATCH /account/profile` | `:26` | one UPDATE |
| `PATCH /account/password` | `:57` | SELECT hash → bcrypt compare → UPDATE — **a genuine multi-step read-then-write** |
| `POST`/`PATCH /account/addresses` | `:116` | user row lock, ownership SELECT, count check, clear-default UPDATE, INSERT-or-UPDATE |
| `DELETE /account/addresses/:id` | `:158` | one DELETE |
| `PUT /account/favorites/:id` | `:185` | one upsert |
| `DELETE /account/favorites/:id` | `:208` | one DELETE |

`profile.js` is entirely read-only and opens no transaction, correctly.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Profile read (`profile.js:285`), details saved (`account.js:34`), password changed (`:74`), address edited, favourite added (`:193`). |
| **201** | Address created (`account.js:148`). |
| **204** | Address deleted (`:167`), favourite removed (`:214`). |
| **400** | Bad name/phone (`account.js:22`), password rules (`:49`, `:52`), invalid address fields (`:107`), bad id (`:155`, `:182`, `:205`). |
| **401 / 403** | Standard. **403** also for a wrong current password (`account.js:68`) and for calling another role's profile variant (`profile.js:296`). |
| **404** | Account row missing (`profile.js:277`, `account.js:62`), address not yours (`:124`, `:162`), restaurant not found (`:190`). |
| **409** | More than 20 saved addresses (`account.js:129`). |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **Object-level ownership** | The strongest form in the project: **no id is accepted at all.** Every query is keyed on `req.user.id`. Where an id *is* in the URL (address, favourite), it is always paired with `user_id = $n` in the same statement. |
| **Explicit transaction** | Six routes, listed above. The password change is the genuine multi-step case. |
| **Role authorization** | Two mechanisms: positional (`account.js:85` splits the file into all-roles and customer-only halves) and explicit (`profile.js:296`). |
| **Custom auth** | The password change re-proves the current password with bcrypt before writing (`account.js:65`). |
| **Complex query** | The owner builder's double `LEFT JOIN` with `COUNT(DISTINCT)`; the weighted-rating query; the rider interval arithmetic. |
| **No JS aggregation** | Every count, sum and average here is computed in SQL, including the address and favourite counts. |
| Trigger / function / procedure | None in this slice. |

---

## Likely viva questions

**1. How does the profile page know which version to show?**
It asks. `GET /api/profile` takes no arguments; the server reads `req.user.role` — which `authenticateToken` re-read from the database — looks it up in a table of four builder functions, and returns `{ user, role, ... }`. React switches on `profile.role` from that response. It deliberately does **not** use the AuthContext copy, because that is rehydrated from `localStorage` and a user could edit it.

**2. If the page only uses `GET /api/profile`, why do the four role-scoped endpoints exist? (design justification)**
Because the dispatch table enforces roles only *implicitly* — a customer gets the customer payload because that is what their role maps to, not because anything refused them. The four variants make it explicit: `/api/profile/admin` has `requireRole('admin')` and returns a real 403. The comment at `:288-293` says exactly this. The alternative — relying on the dispatch table alone — would mean the enforcement is a side effect rather than a rule, and side effects are what get broken by the next edit.

**3. Why lock the `users` row when saving an address?**
`account.js:118`. Saving a default address is two steps: clear the existing default, then write the new one. Two concurrent saves could both clear and both set, leaving two defaults — the data is then simply wrong and nothing detects it. The lock serialises them. It selects `id` and discards it; the row is not the point, the lock is.

**4. Your password change proves the old password. Why, if the user is already logged in?**
Because being logged in proves you hold a session, not that you are the owner. If someone walks up to an unlocked laptop, or a token leaks, re-proving the password is what stops them locking the real owner out. `account.js:65` does the bcrypt compare before any write. The honest gap — which the endpoint’s own success message admits at `:74` — is that changing the password does **not** revoke existing sessions.

**5. Can this endpoint be used to change someone's role?**
No, and deliberately. `PATCH /api/account/profile` writes `SET name = $1, phone = $2` only (`account.js:29`) — `role` and `email` are absent from the SET list, so there is nothing to smuggle in. More broadly, **no route in the entire project writes `users.role`**; I verified that by grep. The only way a role is set is at signup, from a server-side allowlist.

---

## Gaps and defects

**DML with no transaction**
- None remaining. All six writes are wrapped (this session's Task A wrapped five of them; `saveAddress` already had one).

**Ownership bypassable via an id in the URL or body**
- None found. `profile.js` accepts no ids whatsoever. `account.js` accepts an address id and a restaurant id, and both appear in the same statement as `user_id = req.user.id`.
- **One thing to name explicitly:** the split at `account.js:85` means `GET/PATCH /profile` and `PATCH /password` are open to all four roles purely because they are declared *above* that line. That is intended — a rider must be able to change their password — but it is enforced by **line ordering**, which is invisible when reading a single route. Moving one of those three declarations below line 85 would silently lock out three roles; moving an address route above it would silently expose one.

**SQL built by string concatenation**
- None. Every query in both files is a plain parameterised template with no interpolation at all.

**Other defects**

1. **Changing the password does not revoke outstanding tokens.** `account.js:71-73` rewrites the hash and writes nothing to `revoked_tokens`; the success message at `:74` admits it. If you change your password *because* you think a session is compromised, you have not locked that session out. (Also listed in unit 01 — it is the same defect seen from both sides.)
2. **The 20-address cap is enforced in JavaScript only** (`account.js:128-130`). No constraint backs it.
3. **`profile.js` runs 3-5 separate queries per request** (`:40`, `:56`, `:75` for a customer) where several could be combined, and there is no caching. Correct, but it is the slowest read in the app.
4. **The owner's weighted rating reads `restaurants.avg_rating`**, a trigger-maintained column, rather than the reviews themselves. Consistent with the design, but it means the profile inherits any drift the trigger ever allows — it is one layer further from the source than unit 06's query.
5. **Two routes serve the same page** — `/account` and `/profile` both render `AccountPage` (`App.jsx:48`, `:50`). Harmless, but it means the "one route" claim needs the caveat that the second is an alias.
6. **No account deletion anywhere.** There is no route for a user to remove their own account, which the schema is ready for (`ON DELETE CASCADE` on every dependent table).

---

## Explain-it-in-60-seconds

This is the one slice where ownership is trivially safe, because no endpoint accepts a user id. `GET /api/profile` takes no arguments at all — the server reads the role off the token, which it already re-read from the database, looks it up in a table of four builder functions, and returns whichever payload matches. React then switches on the role *from the response*, not from localStorage, so editing localStorage changes nothing. There are also four explicit per-role endpoints that the page doesn't use, purely so the role check is a written rule with a real 403 rather than a side effect of the dispatch table.

Everything numeric is computed in SQL. The customer's totals are one scan with FILTER splitting counted-versus-summed, so cancelled orders are counted but not added up. The owner's restaurant list uses two independent LEFT JOINs, which multiply rows, so the branch and menu counts are COUNT(DISTINCT) — and the overall rating is weighted by review count, because averaging averages would let two reviews outweigh two hundred.

The two bits worth pointing at: the password change re-proves the current password with bcrypt before writing, because holding a session isn't the same as being the owner — though I'd flag honestly that it doesn't revoke other sessions yet. And saving an address locks the user row first, because setting a default is clear-then-set, and two concurrent saves could otherwise leave you with two default addresses and nothing to detect it.

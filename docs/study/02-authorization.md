# 02 — Authorization (role gates + ownership checks)

## Files involved

**Frontend**
- `frontend/src/App.jsx` — `RoleRoute` (`:21-26`) and `PublicOnly` (`:27-30`). **UX only, never the real gate.** `RoleRoute` reads the user from React state, which is rehydrated from `localStorage`; a user can edit that and see any screen. The screen will then be empty, because every endpoint behind it refuses.
- `frontend/src/utils/api.js:9-18` — response interceptor: a 401 on any non-auth request clears storage and fires `cravio:session-ended`. A **403 is deliberately left alone** so the page can render the server's refusal inline.

**Route** — every file, since authorization is the cross-cutting concern. The distinct shapes live in:
- `backend/routes/owner.js:26-52` — `requireOwnedRestaurant`, the only dedicated ownership middleware.
- `backend/routes/menu.js` — the fetch-then-compare pattern, eight times.
- `backend/routes/operations.js` — role folded into the SQL `WHERE`, three times.
- `backend/routes/account.js`, `backend/routes/profile.js` — the no-id-accepted shape.

**Controller**
- `backend/services/orderService.js:216-233` — `getOrderDetailsWithDb` builds its `WHERE` differently per role; `:642-786` `updateOrderStatus` gates the state machine.

**Middleware**
- `backend/middleware/auth.js` — proves *who* (401/403 for suspension).
- `backend/middleware/roleCheck.js` — proves *what kind* (`requireRole`, 401/403).
- `backend/routes/roleCheck.js` — **deleted.** It was a stale duplicate of the middleware copy that nothing imported (confirmed by grep; `diff` showed only comment differences).

**SQL**
- `backend/db/schema.sql:67-75` — the `role` CHECK constraint, the last line of defence on what a role can even be.
- `backend/db/schema.sql:169-171` — `restaurants.owner_id` (FK to `users`), the column every owner-side ownership check walks to.

---

## Flow

Authorization runs in three layers, and **all three must agree** when a feature is added.

1. **Layer 1 — are you anyone?** `authenticateToken` (`middleware/auth.js:5`). Verifies the JWT signature, then re-reads the account from the database (`:27-28`). No/bad token → **401**. Revoked token → **401** (`:40`). Suspended account → **403** (`:42`). On success it writes `req.user = { id, email, role, jti, exp }` (`:44`) — **this object is the only trusted identity in the entire backend.**

2. **Layer 2 — are you the right kind of person?** `requireRole(...roles)` (`middleware/roleCheck.js:6`). Compares `req.user.role` against an allowlist. Missing `req.user` → 401 (`:9`), wrong role → **403** (`:15`). Applied either per-route (`orders.js:37-38`) or once for a whole router (`rider.js:7`, `owner.js:12`, `adminAnalytics.js:18`).

3. **Layer 3 — is this particular row yours?** Role alone is not enough: every restaurant owner passes `requireRole('restaurant_owner')`, so something else must stop owner A editing owner B's menu. This is the **object-level ownership check**, and the codebase uses five distinct shapes — described once each below.

Where the layers sit for a write like `PATCH /api/menu/items/:itemId`:
`server.js:67` mount → `menu.js:425` `authenticateToken` → `menu.js:426` `requireRole('restaurant_owner','admin')` → `menu.js:476-483` ownership SELECT → `menu.js:496-504` comparison → `menu.js:511` the UPDATE.

---

## The SQL

Five ownership shapes. Each is shown **once in full**, then the routes that follow it are listed with only their differences.

### Shape 1 — No id is accepted at all *(the strongest)*

`account.js:88`
```sql
SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, id DESC
```
`$1` = `req.user.id`. There is **no user id and no address id in the request**, so there is nothing to tamper with. This shape cannot be bypassed by any URL edit, because there is no URL parameter.

Routes following it, with their differences:

| Route | File:line | Difference |
|---|---|---|
| `GET /api/account/profile` | `account.js:14` | `SELECT ... FROM users WHERE id = $1` |
| `PATCH /api/account/profile` | `account.js:28` | `UPDATE users SET name=$1, phone=$2 WHERE id=$3` — **cannot touch `role`**; the column is not in the SET list |
| `PATCH /api/account/password` | `account.js:59, :73` | reads the hash by `id=$1`, updates by `id=$2` |
| `GET /api/account/favorites` | `account.js:175` | joins `restaurants`, still filtered `f.user_id=$1` |
| `GET /api/profile` + the four role-scoped variants | `profile.js:23, :49, :98, :173, :192` | every builder takes `req.user.id` as its only argument (`profile.js:282`) |
| `GET /api/rider/profile` | `rider.js:11` | `WHERE user_id=$1` |

### Shape 2 — Fetch, then compare in JavaScript *(the most common — 14 sites)*

`menu.js:476-483`
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
followed by `menu.js:496-504`:
```js
if (req.user.role !== 'admin' && item.owner_id !== req.user.id) {
  return res.status(403).json({ error: 'You can only modify your own restaurant menu.' })
}
```
**The join exists purely to reach `owner_id`** — a menu item does not store who owns it, so the query climbs `menu_items → restaurants` to find out. `$1` = the id from the URL. Not found → 404; found but not yours → 403.

Routes following it, with only their differences:

| Route | File:line | Climb |
|---|---|---|
| `POST /api/menu/restaurants/:id/categories` | `menu.js:217-221`, check at `:234-240` | no join — reads `restaurants.owner_id` directly |
| `POST /api/menu/categories/:categoryId/items` | `menu.js:342-347`, check at `:362-368` | `menu_categories → restaurants` |
| `PATCH /api/menu/items/:itemId/toggle` | `menu.js:582-587`, check at `:601-607` | same as the full example |
| `DELETE /api/menu/items/:itemId` | `menu.js:675-680`, check at `:694-700` | same |
| `POST /api/menu/items/:itemId/modifier-groups` | `menu.js:746-751`, check at `:830` | same |
| `POST /api/menu/modifier-groups/:groupId/options` | `menu.js:919-926`, check at `:938-944` | `modifier_groups → menu_items → restaurants` (three hops) |
| `PATCH /api/menu/modifier-options/:optionId/toggle` | `menu.js:1008-1019`, check at `:1028-1034` | `modifier_options → modifier_groups → menu_items → restaurants` (four hops) |
| `DELETE /api/menu/modifier-groups/:groupId` | `menu.js:1094-1101`, check at `:1113-1119` | three hops |
| `POST /api/restaurants/:id/branches` | `restaurants.js:302-307` | `WHERE id=$1 AND owner_id=$2` (`:306`), then `rows.length === 0 && role !== 'admin'` → 403 (`:310-318`) |
| `PATCH /api/restaurants/branches/:branchId/toggle` | `restaurants.js:390-396` (`:395`), check at `:399` | `restaurant_branches → restaurants`, same comparison |
| `POST /api/reviews/orders/:orderId` | `reviews.js:74-85`, check at `:97` | customer side: `order.customer_id !== req.user.id` → 403 |
| `GET /api/payments/:orderId` | `payments.js:47-52`, check at `:99-102` | allows **customer OR owner OR admin** |
| `POST /api/payments/:orderId/reference` | check at `payments.js:174` | customer only |
| `PATCH /api/payments/:orderId/status` | check at `payments.js:293` | owner or admin |
| `PATCH /api/rider/deliveries/:orderId/status` | `rider.js:113`, check at `:115` | `delivery.rider_id !== req.user.id` → 403, and **404 when the delivery does not exist** (`:104`) |

### Shape 3 — Ownership inside the writing statement *(the safest for writes)*

`owner.js:581-590`
```sql
UPDATE restaurant_reviews rv
SET owner_reply = $1,
    owner_replied_at = NOW()
FROM orders o, restaurant_branches b, restaurants r
WHERE rv.id = $2
  AND o.id = rv.order_id
  AND b.id = o.branch_id
  AND r.id = b.restaurant_id
  AND r.owner_id = $3
RETURNING rv.id, rv.owner_reply, rv.owner_replied_at
```
`$1` reply text, `$2` review id from the URL, `$3` = `req.user.id`. The extra tables in `FROM` are a join: the row is updated **only if** the chain review → order → branch → restaurant can be walked *and* that restaurant's owner is the caller. No match → zero rows → 404 (`owner.js:595-601`). There is no separate check to get out of step with the write, and no window between checking and writing.

Routes following it:

| Route | File:line | Difference |
|---|---|---|
| `DELETE /api/owner/reviews/:id/reply` | `owner.js:634-645` | `SET owner_reply = NULL, owner_replied_at = NULL`; 204 on success |
| `PATCH /api/restaurants/:id` | `restaurants.js:465-468` | `WHERE id=$7 AND (owner_id=$8 OR $9='admin')` (`:467`) — the admin escape hatch is a bound parameter, not a branch in JS; zero rows → 404 (`:470`) |

### Shape 4 — Role folded into the reading query's `WHERE`

`operations.js:158`
```sql
WHERE ($1 = 'admin' OR ($1 = 'restaurant_owner' AND r.owner_id = $2) OR ($1 = 'rider' AND o.rider_id = $2))
```
`$1` = `req.user.role`, `$2` = `req.user.id`, both from the token. One query serves three roles and each sees only its own slice; an admin sees everything. The whole statement is `operations.js:149-159`, joining `orders → restaurant_branches → restaurants` with a `LEFT JOIN payments` so the aggregate can be computed per role.

Routes following it:

| Route | File:line | Difference |
|---|---|---|
| `GET /api/operations/tickets` | `operations.js:14` | `WHERE ($1 = 'admin' OR t.user_id = $2)` |
| `POST /api/operations/tickets` | `operations.js:31-35`, 404 at `:37` | proves the order belongs to the caller **in any of four capacities** before letting them file a ticket against it; no match → 404 |
| `GET /api/owner/reviews` | `owner.js:467` | `WHERE r.owner_id = $1` after the shared `OWNED_REVIEWS_FROM` chain (`owner.js:376-381`) |
| `GET /api/owner/reviews/summary` | `owner.js:521, :540` | same chain, aggregated |
| the six owner analytics queries | `owner.js:81-82, :125-126, :212-213, :271-272, :295-296` | every one repeats `AND r.owner_id = $2` **on top of** the middleware check |

### Shape 5 — Conditions assembled per role, then bound

`orderService.js:217-231`
```js
const conditions = ['o.id = $1']
const values = [orderId]
if (actor.role === 'customer') { values.push(actor.id); conditions.push(`o.customer_id = $${values.length}`) }
else if (actor.role === 'restaurant_owner') { values.push(actor.id); conditions.push(`r.owner_id = $${values.length}`) }
else if (actor.role !== 'admin') { throw new OrderServiceError(403, 'ACCESS_DENIED', ...) }
```
This is the one place SQL *text* is built at runtime, and it is safe: the only thing interpolated is `$${values.length}` — a **placeholder number**, not a value. The actor's id goes into `values` and is bound. An admin adds no condition and sees any order; any other role is refused outright. Zero rows → 404 (`orderService.js:272-278`), so a customer guessing an order id gets "not found", never someone else's order.

### The dedicated ownership middleware

`owner.js:26-52` — `requireOwnedRestaurant`:
```sql
SELECT id, name, owner_id FROM restaurants WHERE id = $1
```
Not found → **404** (`:38`); `owner_id !== req.user.id` → **403** (`:42`). It then stashes `req.restaurant` and validates the date range (`:47-49`). It is Shape 2 promoted to middleware so six analytics routes share it — and the queries behind it *still* repeat `AND r.owner_id = $2`, which is belt and braces by design (comment at `owner.js:23-24`).

---

## Transactions

Authorization itself writes nothing, so most checks need no transaction. What matters is **whether the check and the write it guards are in the same transaction.**

**Inside a transaction (check and write cannot drift apart):**
- `restaurants.js:300` `BEGIN` → `:302-307` ownership SELECT → `:321` INSERT branch → COMMIT.
- `restaurants.js:387` `BEGIN` → `:390-396` ownership SELECT → `:410` UPDATE → COMMIT.
- `reviews.js:69` `BEGIN` → `:74-85` order SELECT **`FOR UPDATE`** → `:97` ownership check → `:130` INSERT → COMMIT.
- `rider.js:97` `BEGIN` → `:98-100` three `FOR UPDATE` locks → `:102` ownership check → `:113` `CALL complete_delivery` → COMMIT.
- `payments.js:162` / `:281` `BEGIN` → `findPaymentForOrder(client, …, true)` (the `true` takes a row lock) → ownership check → UPDATE → COMMIT.
- `owner.js:568` / `:628` `BEGIN` → the Shape-3 UPDATE that *contains* the check → COMMIT.

**Not inside a transaction (check and write are separate statements):**
- **(Fixed since this file was written.)** All nine `menu.js` write routes were read-then-write pairs with no transaction; they are now wrapped (`menu.js:213, 329, 464, 573, 672, 818, 916, 1005, 1091`), so the ownership SELECT and the write share one transaction on one connection.
- `restaurants.js:465` PATCH `/:id` — now wrapped too (`BEGIN` at `:464`), though it needed none: the check *is* the write (Shape 3).

---

## Status codes

| Code | Trigger |
|---|---|
| **401** | No `Authorization` header (`middleware/auth.js:8`); bad signature or expiry (`:21`); payload missing `id`/`jti`/`exp` (`:16`); token revoked or user row gone (`:40`); `requireRole` reached with no `req.user` (`roleCheck.js:9`). |
| **403** | Suspended account (`middleware/auth.js:42`). Wrong role (`roleCheck.js:15`). Not your restaurant (`owner.js:42`, `restaurants.js:315`, `:403`). Not your menu item (`menu.js:503` and the eight siblings). Not your order (`reviews.js:100`, `orderService.js:227`). Not your payment (`payments.js:103`, `:177`, `:293`). Not your delivery (`rider.js:117`, when the row exists). Admin changing their own status (**400**, not 403 — `admin.js:128`). |
| **404** | Used deliberately **instead of 403** where confirming existence would leak: Shape 3 zero-rows (`owner.js:598`, `restaurants.js:470`), Shape 5 zero-rows (`orderService.js:274`), ticket-order check (`operations.js:33`), and a delivery that does not exist (`rider.js:117`). |
| **400** | Malformed id before any lookup (`parseId` → `menu.js:664`, `payments.js:86`, `owner.js:29`, `rider.js:55`). |

**The 403-vs-404 split is a deliberate design choice, not an inconsistency.** Where the id is a guessable small integer and the resource's *existence* is itself information (an order, a review), the code returns 404 so an attacker cannot enumerate. Where the caller already legitimately knows the resource exists (their own restaurant's menu), 403 is clearer.

---

## Graded requirements touched

| Requirement | How this slice satisfies it |
|---|---|
| **Role authorization, backend-enforced** | `requireRole` on every non-public route; 401 for no session, 403 for wrong role, exactly as the rubric words it. Reachable by curl with no frontend involved. |
| **Object-level ownership** | All five shapes above. The headline example for a viva is Shape 3 (`owner.js:581-590`) because the check is *inside* the UPDATE. |
| **Role stored in DB, resolved server-side** | `middleware/auth.js:27-28` re-reads `u.role` from `users` on **every** request rather than trusting the token's copy. **No route anywhere writes `users.role`** — verified by grep; there is no role-change endpoint to abuse, and `PATCH /api/account/profile` (`account.js:28`) omits the column from its SET list. |
| **Hiding a button is not authorization** | `App.jsx:21-26` is explicitly UX; the endpoints refuse independently. Demonstrable by calling any owner route with a customer token. |
| **Complex query** | Shape 4's three-role `WHERE` (`operations.js:149-159`) and the four-hop ownership climb (`menu.js:1008-1019`) are both multi-table joins doing real authorization work. |
| **Explicit transaction** | The six check-and-write pairs listed under Transactions. |
| Trigger / function / procedure | None in this slice. |

---

## Likely viva questions

**1. A customer copies an owner's URL and calls `PATCH /api/menu/items/12` with their own token. Walk me through what stops them.**
Three things, in order. `authenticateToken` verifies their token and sets `req.user.role = 'customer'` from the **database row**, not the token's claim (`middleware/auth.js:18-25`). Then `requireRole('restaurant_owner','admin')` at `menu.js:398` sees `customer` is not in the allowlist and returns 403 before the handler runs. Even if they somehow had the owner role, `menu.js:476-483` climbs from the item to `restaurants.owner_id` and `:462` compares it to their id → 403.

**2. Why is the ownership check inside the UPDATE for review replies, but a separate SELECT for menu items? Which is better? (design justification)**
Inside is better, and the review reply (`owner.js:581-590`) is the newer code. Two reasons. First, **there is no gap** — a separate check leaves a window between "yes you own this" and the write in which the restaurant could change hands; the menu routes have exactly that window because they are not even in a transaction. Second, **one definition** — a separate check is a second place that must agree about what ownership means, and two copies of a rule are two chances to write it differently. The statement cannot disagree with itself. The menu routes are the older pattern; I would migrate them, and they are listed as a defect below rather than defended.

**3. Sometimes you return 403 and sometimes 404 for the same kind of failure. Why?**
It is deliberate. 404 is used where the id is a small guessable integer and existence is itself information — orders, reviews, tickets (`orderService.js:274`, `owner.js:598`, `operations.js:33`). If those returned 403, someone could walk ids and learn which are real, which is **resource enumeration**. 403 is used where the caller already knows the thing exists because it is their own dashboard's data, and a clear "not yours" is more useful than a lie.

**4. Your frontend has `RoleRoute`. Isn't that your authorization?**
No — it is navigation. It reads the user from React state (`App.jsx:22`), which `AuthContext.jsx:5-8` rehydrates from `localStorage`. A user can edit that value in DevTools and render the admin dashboard. They will see an empty shell, because every request that page makes gets a 403 from `requireRole`. The rubric is explicit that hiding a button is not authorization, and this codebase treats the frontend as a convenience layer only.

**5. Why does `requireOwnedRestaurant` exist *and* every analytics query still repeat `AND r.owner_id = $2`? Isn't that redundant?**
It is redundant, on purpose. The middleware (`owner.js:26-52`) gives the right status codes — 404 for a restaurant that does not exist, 403 for one that is not yours — which a query filter alone cannot distinguish. The repeated `WHERE` clause means that if someone later adds a route and forgets the middleware, or edits the middleware wrongly, the queries return **nothing** rather than another owner's revenue. The comment at `owner.js:23-24` states exactly this. Cheap insurance on the highest-value data in the app.

---

## Gaps and defects

**DML statements with no surrounding BEGIN/COMMIT (complete list, app-wide)**

Single-statement writes — atomic on their own, **not defects**, listed for completeness:
- `account.js:25` UPDATE users · `account.js:52` UPDATE users · `account.js:128` DELETE address · `account.js:142` INSERT favorite · `account.js:152` DELETE favorite
- `admin.js:135` UPDATE users
- `auth.js:518` revoke token (CTE + INSERT, one statement)
- `operations.js:35` INSERT ticket · `:49` UPDATE ticket · `:77` INSERT promo · `:90` UPDATE promo
- `restaurants.js:462` UPDATE restaurant
- `rider.js:21` UPDATE rider profile
- `menu.js:239, :353, :476, :565, :643, :761, :859, :935, :1006` — the nine menu writes

**Multi-step sequences with no transaction — genuine finding:**
- **The eight `menu.js` write routes are read-then-write pairs with no `BEGIN` and no row lock.** Example: `menu.js:443` reads `owner_id`, `:476` performs the UPDATE. Between those two statements the restaurant could be transferred, or the item deleted, and the write would proceed on a stale authorization decision. The window is small and the blast radius is a menu item, but it is the textbook time-of-check-to-time-of-use gap, and it is the pattern an examiner comparing `menu.js` to `owner.js` will notice. `restaurants.js:300` and `:387` do the same thing *correctly* — same check, wrapped in a transaction — which makes the inconsistency harder to defend.

**Ownership checks bypassable by changing an id in the URL or body**

I traced every route that accepts an id. **I found no bypass.** Specifically:
- Every id from the URL is passed as a bound parameter and always accompanied by `req.user.id` from the token.
- `PATCH /api/account/profile` (`account.js:28`) targets `WHERE id = $3` with `req.user.id` — **you cannot name another user**, and `role` is absent from the SET list, so there is no privilege-escalation path.
- `PATCH /api/admin/users/:id/status` (`admin.js:137-142`) takes a target id from the URL with no ownership check — **correct**, that is the admin's whole job; self-suspension is blocked server-side at `:127-131`, not only in the UI.
- **No route writes `users.role`** (verified by grep). There is no role-change endpoint at all.

Two things that are not bypasses but deserve naming:
- `GET /api/payments/:orderId` (`payments.js:78-80`) has `authenticateToken` but **no `requireRole`** — it is the only authenticated route in the app with no role gate. The handler check at `:99-102` covers it correctly, but the route line alone looks unguarded, and an examiner skimming the middleware chains will stop there.
- `GET /api/account/profile`, `PATCH /api/account/profile` and `PATCH /api/account/password` sit **above** `router.use(requireRole('customer'))` at `account.js:85`, so they are open to all four roles. That is intended — a rider needs to change their password too — but it depends entirely on **line ordering**, which is invisible when reading a single route. Moving one of those three lines below line 57 would silently lock out three roles; moving an address route above it would silently expose one.

**SQL built by string concatenation instead of `$n`**

**None.** I grepped every `${...}` inside a query template in `routes/` and `services/`. Every hit is one of:
- an error-message string (`payments.js:329`, `rider.js:119`, `menu.js:703`, `orderService.js:139`, `cart.js:428`, `:438`, `owner.js:414`, `:562`);
- a **placeholder number** — `$${values.length}` (`admin.js:49`, `:74`, `orderService.js:222`, `:225`);
- a fixed internal constant — `OWNED_REVIEWS_FROM` (`owner.js:465`, `:481`, `:521`, `:540`), which is a string literal defined at `owner.js:376-381` and contains no user input;
- a value chosen from an allowlist that was validated first — `orderBy` (`restaurants.js:49`, validated at `:27`) and `REVIEW_SORTS[sort]` (`owner.js:470`, validated at `:406-408`).

Sorting is the only place user input influences SQL text, and it does so by **selecting between strings written in the file**, never by being inserted into one. That is the correct way to handle `ORDER BY`, which cannot take a parameter.

**Other defects**

1. ~~**`backend/routes/roleCheck.js` is a stale duplicate.**~~ **Resolved** — the file has been deleted after confirming by grep that nothing imported it.
2. **`requireRole` builds its 403 message from the allowlist** — `Access denied. Required role: ${allowedRoles.join(' or ')}` (`roleCheck.js:16`). It tells an unauthorized caller exactly which role they would need. Harmless here, mildly chatty in general.
3. **The admin bypass is expressed two different ways.** Sometimes a JS branch (`req.user.role !== 'admin' && ...`, `menu.js:497`), sometimes a bound SQL parameter (`$9='admin'`, `restaurants.js:467`), sometimes a skipped condition (`orderService.js:227`). All three are correct; having three idioms for one rule is how one of them eventually gets forgotten.
4. **No audit trail for authorization failures.** A 403 is returned and nothing is recorded. `order_events` audits order changes and `revoked_tokens` records logouts, but repeated failed attempts to reach another owner's data leave no trace.

---

## Explain-it-in-60-seconds

Authorization happens in three layers and the frontend isn't one of them. First, `authenticateToken` checks the JWT signature and then goes back to the database to re-read that user's row — so the role we act on is the database's answer, not whatever the token claims. No token is a 401, suspended account is a 403. Second, `requireRole` compares that role against an allowlist on the route: wrong role, 403, before the handler runs at all.

But role isn't enough, because every restaurant owner passes `requireRole('restaurant_owner')` — so the third layer is object-level ownership, proving this particular row is yours. We do that five ways. The best one is putting the ownership condition inside the statement that writes: for review replies the UPDATE joins review → order → branch → restaurant and requires `owner_id` to equal the id from the token, so a review that isn't yours simply matches zero rows and we return 404. No gap between checking and writing, and no second copy of the rule to drift. The older menu routes do it the weaker way — a SELECT that climbs to `owner_id`, then a comparison in JavaScript — and I'd flag that those eight routes aren't wrapped in a transaction, so there's a small time-of-check-to-time-of-use window.

One deliberate detail: we return 404 rather than 403 when the id is a guessable number, like an order or a review, because a 403 would confirm the row exists and let someone enumerate the table. And the React `RoleRoute` is navigation only — you can edit localStorage and render the admin page, but every request it makes comes back 403.

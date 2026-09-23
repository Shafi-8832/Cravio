# 04 — Cart & place order

## Files involved

**Frontend**
- `frontend/src/context/CartContext.jsx` — holds the active cart in React state.
- `frontend/src/components/CartDrawer.jsx` — the slide-out cart; quantity steppers and remove.
- `frontend/src/components/ModifierPicker.jsx` — choosing modifier options before adding a line.
- `frontend/src/pages/CheckoutPage.jsx` — address, payment method, promo code, and the Place Order button.
- `frontend/src/services/cartApi.js`, `frontend/src/services/orderApi.js` — the axios wrappers.

**Route**
- `backend/routes/cart.js` — `GET /api/cart/:restaurantId` (`:17`), `POST /api/cart/:restaurantId/items` (`:204`), and three line mutations sharing one handler (`:654`, `:655`, `:656` → `changeLine` at `:612`).
- `backend/routes/orders.js:35` — `POST /api/orders`, twelve lines that delegate everything.

**Controller**
- `backend/services/orderService.js` — the project's only service layer. `placeOrder` at `:397`, `CHECKOUT_ERROR_MAP` at `:43`, `mapCheckoutError` at `:184`.

**Middleware**
- `authenticateToken` + `requireRole('customer')` on every route in this slice (`cart.js:19-20`, `:206-207`, `:654-656`; `orders.js:37-38`).

**SQL**
- `backend/db/functions/place_order.sql` — the checkout FUNCTION, `CREATE` at `:20`.
- `backend/db/schema.sql:665-772` — `carts`, `cart_items`, `cart_item_modifiers`.
- `backend/db/schema.sql:411-508` — `orders`, `order_items`; `:773-804` — `order_item_modifiers`.

---

## Flow

### Adding a line to the cart

1. Customer picks modifiers and taps Add. `POST /api/cart/:restaurantId/items` with `{ menu_item_id, quantity, modifier_option_ids }`.
2. `cart.js:206-207` — logged in, and a customer.
3. `cart.js:210-275` validates ids, quantity 1-99, and the modifier array shape → **400**.
4. `cart.js:278` connect, `:284` `BEGIN`.
5. `:294-300` loads the menu item **joined to its restaurant** to check three things at once: the item exists, belongs to the restaurant in the URL, and that restaurant is accepting orders. Missing → **404** (`:306`); wrong restaurant → **400** (`:318`); ordering disabled → **409** (`:327`); item unavailable → **409** (`:333`).
6. `:374-380` loads the item's modifier groups and options, then `:399-440` enforces each group's min/max selection rules → **400/409**.
7. `:455-459` gets or creates the cart with `INSERT … ON CONFLICT DO UPDATE`.
8. `:484-500` looks for an existing line **with exactly this set of modifier options**, `FOR UPDATE`.
9. Found → `:516` bumps the quantity (capped at 99, else **400** at `:512`). Not found → `:528` inserts the line, and `:551` inserts its modifier rows in one `UNNEST` statement.
10. `:564` COMMIT → **201**.

### Changing or removing a line

1. `PATCH /api/cart/items/:itemId`, `…/adjust`, or `DELETE` — all three land in `changeLine` (`cart.js:612`).
2. `:621` connect, `:623` `BEGIN`.
3. **Ownership and locking in one step:** `:624-625` locks the parent cart *through* the line, `WHERE ci.id=$1 AND c.user_id=$2 FOR UPDATE OF c`. A line belonging to someone else matches nothing.
4. `:626-627` re-reads the line **after** the lock — this is how it notices that checkout deleted the line while we waited. Gone → **404**.
5. Quantity reaching 0 → **409** with `REMOVE_CONFIRMATION_REQUIRED` (`:635`) rather than silently deleting.
6. `:642-644` deletes or updates the line and touches the cart's `updated_at`; `:645` COMMIT → **200**.

### Placing the order

1. `POST /api/orders` with `{ branch_id, delivery_address, payment_method, promo_code? }`.
2. `orders.js:41` calls `placeOrder(req.user.id, req.body)` — **the customer id comes from the token, never the body.**
3. `orderService.js:433` refuses mobile payment methods when `ALLOW_MANUAL_PAYMENTS` is off → **409**.
4. `:437` connect, `:440` `BEGIN`.
5. `:442-454` calls the database function: `SELECT * FROM place_order($1, $2, $3, $4, $5)`.
6. Inside the function, in order: validate the customer and address (`:64-72`), lock and validate the branch (`:78-106`), **lock the cart `FOR UPDATE`** (`:115`), verify every line's item and modifiers still exist and are available (`:128-194`), **recompute the subtotal from current menu prices** (`:204-214`), check the branch minimum (`:221`), lock and apply the promo (`:231-273`), insert the order (`:284-306`), insert each `order_items` row with a price snapshot (`:334`), insert `order_item_modifiers` (`:354`), insert the `payments` row as `unpaid` (`:373`), and clear the cart (`:389`).
7. Any failure raises a named exception; nothing is written.
8. Back in Node, `:456-463` re-reads the full order **on the same client, inside the same transaction**; `:465` COMMIT.
9. `orders.js:43` → **201**. On error, `mapCheckoutError` (`:184`) turns the exception name into a status and a client-facing `code`.

---

## The SQL

**1. Find the cart** — `cart.js:50-58`
```sql
SELECT id
FROM carts
WHERE user_id = $1
  AND restaurant_id = $2
```
One cart per (customer, restaurant) — a customer can hold several at once. `$1` = `req.user.id` from the token, `$2` = the restaurant in the URL. **Ownership is the `user_id = $1` clause**; there is no cart id in the request to tamper with.

**2. Validate the item and its restaurant in one hop** — `cart.js:294-300`
```sql
SELECT
  mi.id,
  mi.restaurant_id,
  mi.is_available,
  r.ordering_enabled
FROM menu_items mi JOIN restaurants r ON r.id = mi.restaurant_id
WHERE mi.id = $1
```
The join is there so one query answers "does this item exist", "whose restaurant is it" and "is that restaurant taking orders". `$1` = menu item id.

**3. Get-or-create the cart** — `cart.js:456-459`
```sql
INSERT INTO carts (user_id, restaurant_id) VALUES ($1, $2)
ON CONFLICT (user_id, restaurant_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
RETURNING id
```
Upsert. The comment above it explains why: *"A lock on a missing cart_items row cannot prevent duplicate inserts"* — the cart must exist before anything can be locked against it. `$1` user id, `$2` restaurant id.

**4. Find an identical line, by modifier set** — `cart.js:484-500`
```sql
FROM cart_items ci

WHERE ci.cart_id = $1
  AND ci.menu_item_id = $2
  AND COALESCE(
        (
          SELECT ARRAY_AGG(cim.modifier_option_id ORDER BY cim.modifier_option_id)
          FROM cart_item_modifiers cim
          WHERE cim.cart_item_id = ci.id
        ),
        ARRAY[]::int[]
      ) = $3::int[]

FOR UPDATE
```
**The cleverest query in the cart.** Two burgers are the same line only if their *chosen options* match, so the sub-select gathers each line's option ids into a sorted array and compares it to the incoming array. `ORDER BY` inside `ARRAY_AGG` makes the comparison order-independent; `COALESCE(..., ARRAY[]::int[])` makes a line with no modifiers comparable to an empty request. `FOR UPDATE` stops two concurrent identical adds from both missing this lookup and inserting duplicates. `$1` cart id, `$2` item id, `$3` the sorted option-id array.

**5. Merge into the existing line** — `cart.js:515-518`
```sql
UPDATE cart_items
SET quantity = quantity + $1
WHERE id = $2
```
`$1` the added quantity, `$2` the line id found above.

**6. Or insert a new line** — `cart.js:528-540`
```sql
INSERT INTO cart_items
(
  cart_id,
  menu_item_id,
  quantity
)

VALUES
($1,$2,$3)

RETURNING id
```

**7. Its modifiers, in one statement** — `cart.js:550-556`
```sql
INSERT INTO cart_item_modifiers
  (cart_item_id, modifier_option_id)
SELECT $1, option_id
FROM UNNEST($2::int[]) AS option_id
```
`UNNEST` turns the array into rows so the whole selection goes in as one INSERT instead of a loop of round trips. `$1` the new line id, `$2` the option-id array.

**8. Ownership + lock for line mutations** — `cart.js:624-625`
```sql
SELECT c.id FROM carts c JOIN cart_items ci ON ci.cart_id=c.id
      WHERE ci.id=$1 AND c.user_id=$2 FOR UPDATE OF c
```
`$1` line id from the URL, `$2` user id from the token. The join climbs line → cart so the *cart* can be locked (`FOR UPDATE OF c`) while the *line* is what was named — matching the lock `place_order` takes, so checkout and a quantity change queue rather than collide.

**9. Checkout — the call** — `orderService.js:443-446`
```sql
SELECT *
FROM place_order($1, $2, $3, $4, $5)
```
`$1` customer id **from the token**, `$2` branch id, `$3` delivery address, `$4` payment method, `$5` promo code or NULL. Everything below happens inside this one call.

**10. The server-side price recomputation** — `place_order.sql:204-214`
```sql
SELECT ROUND(SUM((mi.price + line.modifier_total) * ci.quantity), 2)
INTO v_subtotal
FROM cart_items ci
JOIN menu_items mi ON mi.id = ci.menu_item_id
CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(mo.price_modifier), 0.00) AS modifier_total
    FROM cart_item_modifiers cim
    JOIN modifier_options mo ON mo.id = cim.modifier_option_id
    WHERE cim.cart_item_id = ci.id
) AS line
WHERE ci.cart_id = v_cart_id;
```
**The single most important query in the project.** The client never sends a price. The `LATERAL` sub-select sums one line's modifiers *first*, so the unit price is base + modifiers and only then multiplied by quantity. The comment at `:199-203` says why it is written this way: summing modifiers in the outer query would multiply the base price once per modifier row and silently overcharge every item with more than one option.

**11. Create the order** — `place_order.sql:284-306`
```sql
INSERT INTO orders (
    customer_id,
    branch_id,
    promo_code_id,
    delivery_address,
    subtotal,
    discount_amount,
    total_amount,
    delivery_fee,
    status
)
VALUES (
    p_customer_id,
    p_branch_id,
    v_promo.id,
    btrim(p_delivery_address),
    v_subtotal,
    v_discount,
    v_total,
    v_delivery_fee,
    'pending'
)
RETURNING id INTO v_order_id;
```
Every money column is a server-computed variable. **This INSERT fires `trg_record_order_event`**, which writes the first `order_events` row.

**12. The payment row** — `place_order.sql:373-385`
```sql
INSERT INTO payments (
    order_id,
    method,
    amount,
    status
)
VALUES (
    v_order_id,
    p_payment_method,
    v_total,
    'unpaid'
);
```
Always `'unpaid'`. The client can never declare its own payment settled.

**13. Clear the cart** — `place_order.sql:389-394`
```sql
DELETE FROM cart_items
WHERE cart_id = v_cart_id;

UPDATE carts
SET updated_at = CURRENT_TIMESTAMP
WHERE id = v_cart_id;
```
Deleting the lines (not the cart row) keeps the cart reusable for that restaurant, and — combined with the `FOR UPDATE` at `:115` — is what makes a double-clicked Place Order button produce one order: the second click waits, then finds an empty cart and raises `CART_EMPTY`.

---

## Transactions

**Cart add — YES.** `cart.js:278/284/564`, ROLLBACK on every early return and in the catch, `client.release()` at `:598`. Inside: the item/restaurant check, modifier-rule checks, the cart upsert, the `FOR UPDATE` line lookup, and the line + modifier writes.

**Line change/remove — YES.** `cart.js:621/623/645`, release at `:651`.

**Checkout — YES, and it is the deepest one.** `orderService.js:437/440/465`, ROLLBACK at `:468`, release at `:471`. Inside that single transaction: the whole of `place_order` (writes to `orders`, `order_items`, `order_item_modifiers`, `payments`, `promo_codes`, `cart_items`, `carts`), **both triggers it fires**, and the read-back of the finished order at `:456`. Eight tables, one atomic unit.

Note the layering: `place_order` does **not** contain its own `BEGIN`. It is a function, so it runs inside whatever transaction the caller opened — which is why the Node side must open one, and why a failure anywhere inside it unwinds every table.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Cart read (`cart.js:173`); line updated or removed (`:646`). |
| **201** | Line added (`cart.js:568`); order placed (`orders.js:43`). |
| **400** | Bad ids, quantity outside 1-99, malformed modifier array (`cart.js:222-272`), item not from this restaurant (`:318`), line cap exceeded (`:512`, `:639`), modifier group rules broken (`:427`, `:437`); checkout validation failures mapped from `INVALID_DELIVERY_ADDRESS`, `INVALID_PAYMENT_METHOD` (`orderService.js:43`). |
| **401 / 403** | Not logged in / not a customer. |
| **404** | Menu item not found (`cart.js:306`); cart line not found **or not yours** (`:630`); `BRANCH_NOT_FOUND`, `CART_NOT_FOUND` from checkout. |
| **409** | Restaurant not accepting orders (`cart.js:327`); item unavailable (`:333`); removal needs confirmation (`:635`); and the whole family of checkout conflicts — `CART_EMPTY`, `BRANCH_CLOSED`, `RESTAURANT_NOT_ORDERABLE`, `BRANCH_MINIMUM_NOT_MET`, `CART_MODIFIERS_CHANGED`, `CART_CONTAINS_UNAVAILABLE_ITEM`, `PROMO_CODE_EXPIRED`, `PROMO_CODE_EXHAUSTED`, `PAYMENT_METHOD_DISABLED`. |
| **500** | Unexpected failure (`cart.js:588`; `orders.js` via `sendError`). |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **FUNCTION** | `place_order(...)` (`place_order.sql:20-32`). Not a toy — it is the entire checkout: validate, price, discount, insert four tables, clear the cart. |
| **TRIGGER** | `trg_record_order_event` fires on the `orders` INSERT at `place_order.sql:284`, writing the first timeline row. |
| **Explicit transaction** | Three of them: `cart.js:284`, `cart.js:623`, `orderService.js:440`. The last wraps a multi-table workflow across eight tables. |
| **Object-level ownership** | Cart reads/writes filter on `user_id = req.user.id` (`cart.js:53`, `:625`); checkout takes the customer id from the token (`orders.js:41`) and `place_order` validates it at `:64`. |
| **Complex query** | The modifier-set array comparison (`cart.js:484-500`) and the `CROSS JOIN LATERAL` pricing query (`place_order.sql:204-214`). |
| **Role authorization** | `requireRole('customer')` on all five routes. |
| **Input validation** | Every field is checked server-side before any query runs. |
| PROCEDURE | Not here — see unit 05. |

---

## Likely viva questions

**1. Why is the price calculated in the database and not in the browser?**
Because a price sent by a client is a price a client can change. `place_order.sql:204-214` recomputes the subtotal from current `menu_items.price` plus current `modifier_options.price_modifier`, while the transaction holds the cart lock. The frontend does compute a total for display (`cart.js:143` notes this), but it is never sent, and nothing in the request body influences money.

**2. Why is checkout a plpgsql function instead of a sequence of queries in Node? (design justification)**
Three reasons. **Atomicity of decision and action** — the validity checks and the writes must see the same snapshot; doing it in Node means the cart could change between the check and the insert. **Lock scope** — the function takes `FOR UPDATE` on the branch, cart and promo rows and holds them for the whole workflow; that is far harder to get right across a dozen round trips. **Round trips** — one call instead of fifteen. The cost is that errors have to be signalled by name: the function raises `CART_EMPTY`, `PROMO_CODE_EXPIRED` and so on, and `CHECKOUT_ERROR_MAP` (`orderService.js:43`) turns each into an HTTP status and a client `code`. Adding a checkout rule therefore means adding a `RAISE` plus a map entry — two places, deliberately.

**3. A customer double-clicks Place Order. What stops two orders?**
`place_order.sql:115` locks the cart row `FOR UPDATE`. The first click takes the lock, runs to the end, and deletes the cart's items (`:389`). The second click blocks on that lock; when it is released it re-reads an empty cart and raises `CART_EMPTY`, which maps to a 409. The comment on `:115` describes exactly this sequence.

**4. Two identical items with different modifiers — how does the cart decide whether to merge them?**
`cart.js:484-500`. It gathers each existing line's modifier option ids with `ARRAY_AGG(... ORDER BY ...)` and compares that array to the incoming one. Same item **and** identical option set → merge by bumping quantity; anything else → a new line. The `ORDER BY` inside the aggregate is what makes the comparison independent of the order the user ticked the boxes in.

**5. `order_items` stores `unit_price`. Why not just join to `menu_items` when showing an old order?**
Because a menu price is today's price and an order is a historical fact. The comment at `place_order.sql:308` calls `unit_price` a price snapshot: if the restaurant raises the price of a burger tomorrow, last week's receipt must still show what was actually charged. The same reasoning is why migration 003 added `order_items.item_name` — so a receipt survives the item being renamed or deleted.

---

## Gaps and defects

**DML with no transaction**
- None. All three writing routes in this slice open one explicitly.

**Ownership bypassable via an id in the URL or body**
- None found. `GET /api/cart/:restaurantId` and the add route key on `user_id = req.user.id`; `changeLine` proves ownership inside the locking SELECT (`cart.js:625`) and returns **404**, not 403, so cart-line ids cannot be probed. `POST /api/orders` ignores any customer id in the body entirely — `orders.js:41` passes `req.user.id`.

**SQL built by string concatenation**
- None. The only `${...}` in `cart.js` are the two modifier-rule error messages (`:428`, `:438`).

**Other defects**

1. **`cart.js` is 658 lines for three endpoints, and the add handler alone is ~390 of them** (`:204-603`). Validation, modifier-rule enforcement, upsert and merge logic are all inline in one function. It works and it is correct, but it is the hardest file in the project to read aloud under questioning — the opposite of the `orders.js` route, which is twelve lines because the logic lives in a service.
2. **Checkout is the only domain with a service layer.** `CLAUDE.md` acknowledges this. The inconsistency means "where does the logic live?" has two different answers depending on the feature.
3. **No cart expiry or cleanup.** `carts.updated_at` is maintained (`cart.js:644`, `place_order.sql:392`) but nothing ever reads it. Abandoned carts accumulate forever.
4. **The 99-per-line cap is enforced in two places with different messages** (`cart.js:512` on add, `:639` on adjust) and nowhere in the schema — `cart_items.quantity` only has `CHECK(quantity > 0)` (`schema.sql:698-739`). A direct `UPDATE` could exceed it.
5. **`REMOVE_CONFIRMATION_REQUIRED` (409) is an unusual use of a conflict status** — nothing is actually in conflict; it is a UI prompt expressed as an error. Defensible, but expect to be asked why it is not a 200 with a flag.
6. **Modifier availability is checked at add time and again at checkout, in two separate implementations** — `cart.js:374-440` in JavaScript and `place_order.sql:157-194` in plpgsql. Two copies of one rule set; if the rules change, both must change.

---

## Explain-it-in-60-seconds

The cart is per restaurant — one cart row per customer per restaurant, so you can have several going at once, and checkout refuses a cart that mixes restaurants. When you add an item we open a transaction, check in one joined query that the item exists, belongs to that restaurant, and that the restaurant is taking orders, then enforce the modifier group rules. The interesting part is deciding whether to merge with an existing line: two of the same burger are only the same line if the chosen options match, so we aggregate each line's option ids into a sorted array and compare arrays. We take FOR UPDATE on that lookup, otherwise two concurrent adds of the same thing would both miss it and create duplicate lines.

Checkout is where it gets serious. The route itself is twelve lines — it calls `placeOrder` in the service, which opens a transaction and calls one plpgsql function, `place_order`. That function does everything: locks the branch, locks the cart, re-validates every line, and recomputes the subtotal from current menu prices. The client never sends a price. The pricing query uses a LATERAL join to sum each line's modifiers first and only then multiply by quantity — doing it the other way round would multiply the base price once per modifier and overcharge anything with two options. Then it inserts the order, the items with a price snapshot, the modifiers, and a payment row marked unpaid, and clears the cart.

Because the function doesn't open its own transaction, it runs inside the caller's — so if anything raises, all eight tables unwind together. And errors come back as named exceptions like CART_EMPTY or PROMO_CODE_EXPIRED, which a map in the service turns into the right HTTP status. That's also what stops a double-click creating two orders: the first click deletes the cart items, the second waits on the lock, finds an empty cart, and gets a 409.

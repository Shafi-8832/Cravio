# Dynamic customer home page (offers, deals, rails)

Everything on the logged-in customer's home page comes from PostgreSQL through
`/api/home/*`. React holds no banner, deal or food list of its own. The
database does the filtering (which offers are running now), the ranking
(popular, top rated, most recent) and the discount maths.

Words used below:

- **View** — a saved SELECT that other queries can use like a table.
- **Trigger** — SQL the database runs by itself before/after a row is written.
- **JOIN / LEFT JOIN** — combine rows of two tables that match on a column. A
  LEFT JOIN keeps the left row even when nothing matches (the right side is NULL).
- **GROUP BY** — fold many rows into one per group so COUNT / SUM / MAX can be used.
- **CTE (`WITH ... AS`)** — a named sub-query used by the query after it.
- **Transaction** — statements that all succeed (COMMIT) or are all undone (ROLLBACK).

---

## 1. Database objects

| Object | File | Purpose |
|---|---|---|
| table `item_offers` | `backend/db/migrations/011_item_offers.sql` | one row = "dish X is Y% off from A to B" |
| trigger `trg_prevent_overlapping_item_offers` | `backend/db/functions/item_offers.sql` | one dish may not have two offers at the same time |
| view `active_item_offers` | `backend/db/functions/item_offers.sql` | offers running right now + discounted price |
| demo data | `backend/db/seeds/demo_item_offers.sql` (`npm run seed:offers`) | 30 offers: 28 running (4 end within hours, 24 last one to two weeks), 1 expired, 1 in the future |

### 1.1 The table

```sql
CREATE TABLE IF NOT EXISTS item_offers (
  offer_id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  discount_percent INTEGER NOT NULL
    CONSTRAINT chk_item_offer_discount CHECK (discount_percent BETWEEN 5 AND 80),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_item_offer_period CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_item_offers_item_ends ON item_offers(item_id, ends_at);
```

- `ON DELETE CASCADE`: deleting a dish deletes its offers.
- `TIMESTAMPTZ`: an exact moment, the same for the GMT server and a Dhaka customer.
- Index `(item_id, ends_at)`: every lookup is "offers of THIS dish that have not
  ended" (checkout, cart, menu, the trigger).

### 1.2 The overlap trigger (graded: trigger)

```sql
CREATE OR REPLACE FUNCTION prevent_overlapping_item_offers()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_clash item_offers%ROWTYPE;
BEGIN
    PERFORM 1 FROM menu_items WHERE id = NEW.item_id FOR UPDATE;

    SELECT * INTO v_clash
    FROM item_offers io
    WHERE io.item_id = NEW.item_id
      AND io.offer_id <> NEW.offer_id
      AND io.starts_at < NEW.ends_at
      AND NEW.starts_at < io.ends_at
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'Menu item % already has offer % running % to %, which overlaps the new period % to % (Dhaka time).',
            NEW.item_id, v_clash.offer_id,
            to_char(v_clash.starts_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI'),
            to_char(v_clash.ends_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI'),
            to_char(NEW.starts_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI'),
            to_char(NEW.ends_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI')
            USING ERRCODE = 'CRV02';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_overlapping_item_offers
BEFORE INSERT OR UPDATE OF item_id, starts_at, ends_at
ON item_offers FOR EACH ROW
EXECUTE FUNCTION prevent_overlapping_item_offers();
```

Line by line:

1. `PERFORM 1 ... FOR UPDATE` locks the dish's row. Two sessions adding offers
   to the same dish now take turns, so they cannot both see "no overlap" and
   both insert.
2. The SELECT looks for another offer of the same dish whose time range
   overlaps. Two ranges overlap when **each starts before the other ends**:
   `existing.starts_at < NEW.ends_at AND NEW.starts_at < existing.ends_at`.
   Back-to-back offers (one ends 14:00, the next starts 14:00) are allowed.
3. `io.offer_id <> NEW.offer_id` skips the row itself on UPDATE (otherwise
   editing an offer would "overlap" its own old version). On INSERT, the SERIAL
   default has already filled `NEW.offer_id` before a BEFORE trigger runs, so
   the same line is harmless there.
4. `RAISE EXCEPTION` aborts the INSERT/UPDATE (and its transaction) with a clear
   message in Dhaka time and our own error code `CRV02`.
5. `BEFORE ... UPDATE OF item_id, starts_at, ends_at`: only changes that can
   create an overlap are checked; changing just the percentage is not.

Why a trigger and not a CHECK: a CHECK can only see the row being written;
"overlaps another row" needs a query over the other rows. (PostgreSQL's
`EXCLUDE USING gist` constraint could also do this, but the course asks for a
trigger and the trigger's message is clearer.)

Note: BEFORE triggers run **before** CHECK constraints, so an insert that both
overlaps and has `discount_percent = 90` reports the overlap first.

### 1.3 The view

```sql
CREATE OR REPLACE VIEW active_item_offers AS
SELECT
    io.offer_id, io.item_id,
    mi.name AS item_name, mi.image_url,
    r.id AS restaurant_id, r.name AS restaurant_name,
    mi.price AS original_price,
    io.discount_percent,
    ROUND(mi.price * (100 - io.discount_percent) / 100.0, 0)::NUMERIC(10,2) AS discounted_price,
    io.starts_at, io.ends_at,
    mi.is_available, r.ordering_enabled
FROM item_offers io
JOIN menu_items mi ON mi.id = io.item_id
JOIN restaurants r ON r.id = mi.restaurant_id
WHERE io.starts_at <= now()
  AND io.ends_at > now();
```

- `WHERE starts_at <= now() AND ends_at > now()`: started and not yet ended. The
  expired and the future demo offers are invisible here.
- `discounted_price`: price × (100 − percent) / 100, rounded to whole taka.
  `100.0` keeps the division exact. Example: 450 at 40% → 270.
- One definition used by the home rails, the menu, the cart and checkout, so the
  price shown everywhere is the price charged.

---

## 2. Each section: load → endpoint → SQL → render

All `/api/home/*` routes sit behind `authenticateToken` (no token → 401).
`frontend/src/components/home/useCustomerHome.js` fires the five requests in
parallel with `Promise.allSettled`, so one failing section shows its own error
and the others still render.

### 2.1 Hero carousel — `GET /api/home/banners`

1. The customer opens `/`. `HomePage` sees role `customer` and renders
   `HeroCarousel` instead of the static welcome hero (guests keep that one:
   the API needs a login).
2. The server runs two queries:

```sql
-- usable promo codes: the same three rules place_order() enforces
SELECT id, code, discount_percent, min_order_amount::float8 AS min_order_amount,
       to_char(expiry_date, 'FMDD Mon YYYY') AS valid_until
FROM promo_codes
WHERE is_active = true AND expiry_date >= CURRENT_DATE AND used_count < usage_limit
ORDER BY discount_percent DESC, code;

-- top 12 photographed deals: biggest discount first, then the one ending sooner
SELECT offer_id, item_id, item_name, image_url, restaurant_id, restaurant_name,
       original_price::float8, discount_percent, discounted_price::float8, ends_at
FROM active_item_offers
WHERE is_available = true AND ordering_enabled = true
  AND image_url IS NOT NULL AND btrim(image_url) <> ''
ORDER BY discount_percent DESC, ends_at ASC, offer_id
LIMIT 12;
```

   A deal slide is built around the dish photo, so dishes without a photo
   are skipped here (they still show in the "Today's deals" rail).
3. React alternates deal and promo slides; once the promo codes run out, the
   remaining deal slides follow one after another. A deal slide shows the dish, the
   restaurant, the new and struck-through old price, a "50% OFF" sticker, a
   countdown and "Order now" (→ that restaurant's menu). A promo slide shows
   the code as a ticket with a "Copy code" button.
4. Behaviour: auto-advances every 3 s; pauses on hover, keyboard focus or touch;
   dot indicators and prev/next buttons; swipe works because the track is a
   CSS scroll-snap row. No auto-advance for users who asked their system for
   reduced motion. No npm package was added.

### 2.2 Today's deals — `GET /api/home/deals?limit=12`

`limit` must be a whole number 1–50, otherwise 400.

```sql
SELECT offer_id, item_id, item_name, image_url, restaurant_id, restaurant_name,
       original_price::float8, discount_percent, discounted_price::float8, ends_at
FROM active_item_offers
WHERE is_available = true AND ordering_enabled = true
ORDER BY ends_at ASC, offer_id
LIMIT $1;
```

Cards: photo, "-25%" badge, "ends in 2h 14m" countdown (red when under 3
hours), sale price and struck-through old price. `useNow()` ticks every minute
and also exactly when the next deal ends, so an expired card disappears on time.

### 2.3 Popular right now — `GET /api/home/popular` (graded: complex query)

```sql
WITH recent_sales AS (
  SELECT oi.menu_item_id, SUM(oi.quantity)::int AS ordered_qty
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.created_at >= now() - INTERVAL '7 days'
    AND o.status <> 'cancelled'
  GROUP BY oi.menu_item_id
),
candidates AS (
  SELECT mi.id AS item_id, mi.name AS item_name, mi.image_url, mi.price,
         r.id AS restaurant_id, r.name AS restaurant_name, r.avg_rating, r.review_count,
         COALESCE(rs.ordered_qty, 0) AS ordered_qty,
         ROW_NUMBER() OVER (PARTITION BY r.id
                            ORDER BY COALESCE(rs.ordered_qty, 0) DESC, mi.price DESC, mi.id) AS rank_in_restaurant
  FROM menu_items mi
  JOIN restaurants r ON r.id = mi.restaurant_id
  LEFT JOIN recent_sales rs ON rs.menu_item_id = mi.id
  WHERE mi.is_available = true AND r.ordering_enabled = true
)
SELECT c.item_id, c.item_name, c.image_url, c.restaurant_id, c.restaurant_name,
       c.price::float8 AS original_price,
       aio.discount_percent, aio.discounted_price::float8 AS discounted_price, aio.ends_at,
       c.ordered_qty, c.avg_rating::float8 AS avg_rating,
       CASE WHEN c.ordered_qty > 0 THEN 'popular' ELSE 'top_rated' END AS reason
FROM candidates c
LEFT JOIN active_item_offers aio ON aio.item_id = c.item_id
WHERE c.ordered_qty > 0 OR c.rank_in_restaurant <= 2
ORDER BY c.ordered_qty DESC, c.avg_rating DESC NULLS LAST, c.review_count DESC,
         c.rank_in_restaurant, c.item_id
LIMIT 10;
```

- **recent_sales** (orders JOIN order_items, GROUP BY): units of each dish sold
  in the last 7 days, cancelled orders excluded.
- **candidates** (menu_items JOIN restaurants, LEFT JOIN recent_sales): every
  available dish, with its 7-day quantity (0 if unsold). `ROW_NUMBER()` numbers
  each restaurant's dishes, best-selling then most expensive first.
- **Top-up approach (in SQL):** the final WHERE keeps every dish that sold,
  **plus** each restaurant's first two dishes. The ORDER BY puts sold dishes
  first (by quantity) and the top-up dishes after them by their restaurant's
  stored `avg_rating`. `LIMIT 10` cuts the list. So when only 5 dishes sold this
  week, those 5 come first and the other 5 slots are filled from the best-rated
  kitchens — one query, no second round trip, and the rail is never empty
  while any dish is available. "At most 2 per restaurant" stops one restaurant
  filling the rail.
- **LEFT JOIN active_item_offers** adds the sale price when the dish is on offer.

Cards show "🔥 1 ordered this week" or "★ 5.0 top-rated kitchen".

### 2.4 Order again — `GET /api/home/order-again` (graded: complex query + authorization)

`requireRole('customer')` → 403 for owners, riders and admins.

```sql
SELECT r.id AS restaurant_id, r.name, r.cuisine, r.image_url, r.logo_url,
       r.avg_rating::float8 AS avg_rating, r.review_count,
       COUNT(o.id)::int AS order_count,
       MAX(o.created_at) AT TIME ZONE 'UTC' AS last_order_at
FROM orders o
JOIN restaurant_branches rb ON rb.id = o.branch_id
JOIN restaurants r ON r.id = rb.restaurant_id
WHERE o.customer_id = $1
  AND o.status <> 'cancelled'
GROUP BY r.id
ORDER BY last_order_at DESC
LIMIT 10;
```

- `$1` is `req.user.id`, set by `authenticateToken` from the verified token. The
  route reads nothing from the URL or body, so `?customer_id=10` is ignored
  (tested: customer 1 still gets only their own, empty, list).
- orders → branches → restaurants because an order points at a branch.
  `GROUP BY r.id` folds orders from any branch of the same restaurant into one
  row (grouping by the primary key allows selecting the other `r` columns).
- `orders.created_at` is a TIMESTAMP without time zone written in GMT;
  `AT TIME ZONE 'UTC'` turns it into an exact moment so the browser shows the
  right "last yesterday".
- The section is hidden for a customer with no orders.

### 2.5 Top rated — `GET /api/home/top-restaurants`

```sql
SELECT id AS restaurant_id, name, cuisine, image_url, logo_url,
       avg_rating::float8 AS avg_rating, review_count
FROM restaurants
WHERE review_count >= 1
ORDER BY avg_rating DESC, review_count DESC, name
LIMIT 10;
```

`avg_rating` / `review_count` are stored columns kept correct by
`trg_sync_restaurant_rating`, so no reviews are re-counted here.

### 2.6 States on every section

- **Loading:** grey shimmering placeholder cards (`.skeleton`); a panel-shaped
  placeholder for the carousel.
- **Images:** `FoodImage` lazy-loads (`loading="lazy"`) and swaps in a 🍽️
  placeholder if a photo fails to load.
- **Empty:** the section is not rendered at all.
- **Error:** the server's message is shown in the section (`role="alert"`).
- **Click:** every card and "Order now" links to `/restaurants/:id`, whose
  menu now shows the sale price, the old price struck through and a "-50%" pill.

---

## 3. Checkout prices (graded: transaction)

`POST /api/orders` → `orderService.placeOrder` → `BEGIN` → `place_order(...)` →
`COMMIT` (or `ROLLBACK`). Inside `place_order()`:

```sql
-- lock the offers that price this cart, like the menu items and modifiers
PERFORM io.offer_id FROM item_offers io JOIN cart_items ci ON ci.menu_item_id = io.item_id
  WHERE ci.cart_id = v_cart_id ORDER BY io.offer_id FOR SHARE OF io;

-- subtotal: offer price if one is running, else the menu price, plus modifiers
SELECT ROUND(SUM((COALESCE(aio.discounted_price, mi.price) + line.modifier_total) * ci.quantity), 2)
INTO v_subtotal
FROM cart_items ci
JOIN menu_items mi ON mi.id = ci.menu_item_id
LEFT JOIN active_item_offers aio ON aio.item_id = mi.id
CROSS JOIN LATERAL (...modifier total per line...) AS line
WHERE ci.cart_id = v_cart_id;

-- each order line stores the unit price ACTUALLY charged
SELECT ..., COALESCE(aio.discounted_price, mi.price) AS price, ...
FROM cart_items ci
JOIN menu_items mi ON mi.id = ci.menu_item_id
LEFT JOIN active_item_offers aio ON aio.item_id = mi.id
```

- `LEFT JOIN` + `COALESCE`: no running offer → NULL → normal price.
- The promo code is applied later to `v_subtotal`, i.e. **after** item discounts.
- The item discount applies to the dish's base price; modifiers keep their price.
- The client's numbers are never read. Verified: sending `"subtotal": 1,
  "unit_price": 1` changed nothing; 2 × Kacchi Biryani (৳450, 40% off) →
  subtotal ৳540, FLAT10 −৳54, fee ৳70, total ৳556, `order_items.unit_price` = 270.
- The cart (`GET /api/cart/:id`) and menu (`GET /api/menu/restaurants/:id`)
  use the same `LEFT JOIN active_item_offers`, so the bag shows the price
  checkout will charge.

---

## 4. Testing the overlap trigger in psql

Save as `offer_trigger_demo.sql` and run `psql "$DATABASE_URL" -f offer_trigger_demo.sql`
(or paste it into psql). `\gset` stores a query result in a psql variable, so the
script picks a dish that has a running offer and one that has no offer at all.

```sql
\set ON_ERROR_STOP off
SELECT item_id AS offer_item FROM active_item_offers ORDER BY offer_id LIMIT 1 \gset
SELECT id AS free_item FROM menu_items
WHERE id NOT IN (SELECT item_id FROM item_offers) ORDER BY id LIMIT 1 \gset

BEGIN;
-- 1. Overlapping insert -> ERROR: Menu item … already has offer … which overlaps …
INSERT INTO item_offers (item_id, discount_percent, starts_at, ends_at)
VALUES (:offer_item, 10, now() + interval '30 minutes', now() + interval '2 days');
ROLLBACK;

BEGIN;
-- 2. Extend the running offer by an hour -> allowed (the row is not compared with itself)
UPDATE item_offers SET ends_at = ends_at + interval '1 hour'
WHERE item_id = :offer_item AND starts_at <= now() AND ends_at > now()
RETURNING offer_id, ends_at;
-- 3. Back-to-back offer starting exactly when it ends -> allowed
INSERT INTO item_offers (item_id, discount_percent, starts_at, ends_at)
SELECT item_id, 10, ends_at, ends_at + interval '1 day'
FROM item_offers WHERE item_id = :offer_item AND starts_at <= now() AND ends_at > now()
RETURNING offer_id, starts_at, ends_at;
-- 4. Move that new offer earlier so it overlaps -> ERROR (UPDATE is checked too)
UPDATE item_offers SET starts_at = now() WHERE item_id = :offer_item AND starts_at > now();
ROLLBACK;

-- 5. CHECK constraints, on a dish with NO offer (on a dish with an offer the
--    BEFORE trigger would answer first, because triggers run before CHECKs)
INSERT INTO item_offers (item_id, discount_percent, starts_at, ends_at)
VALUES (:free_item, 90, now(), now() + interval '1 day');   -- violates chk_item_offer_discount
INSERT INTO item_offers (item_id, discount_percent, starts_at, ends_at)
VALUES (:free_item, 20, now(), now() - interval '1 day');   -- violates chk_item_offer_period

-- 6. The view hides expired and future offers
SELECT count(*) AS all_offers,
       count(*) FILTER (WHERE starts_at > now()) AS future,
       count(*) FILTER (WHERE ends_at <= now()) AS expired
FROM item_offers;
SELECT count(*) AS running_now FROM active_item_offers;
```

Steps 1–4 run inside transactions that end in ROLLBACK, and step 5 fails, so
the script changes nothing.

## 5. Demo data

`npm run seed:offers` (re-runnable, one transaction) replaces the offers of 30
chosen dishes: each named restaurant's Nth most expensive photographed dish,
two or three per restaurant across all 14 restaurants. 4 end within hours, 24
last one to two weeks (so the carousel stays full between demos), 1 is already
expired and 1 starts tomorrow.
Run it again before a demo to refresh the countdowns. It is a script rather than
part of the migration because the times are relative to "now" and a migration
runs only once.

# 03 — Browse & search restaurants / menus

## Files involved

**Frontend**
- `frontend/src/pages/HomePage.jsx` — hero, slideshow, featured restaurants.
- `frontend/src/pages/RestaurantPage.jsx` — one restaurant: header, branches, menu, reviews.
- `frontend/src/components/RestaurantCard.jsx` — a card in the grid, with the favourite heart.
- `frontend/src/components/FoodImage.jsx`, `FoodSlideshow.jsx` — image handling and the rotating hero.
- `frontend/src/pages/DirectoryPage.jsx` — the optional Google Places city directory.
- `frontend/src/services/restaurantApi.js`, `frontend/src/services/menuApi.js` (via `ownerApi.getMenu`), `frontend/src/services/directoryApi.js`.

**Route**
- `backend/routes/restaurants.js` — `GET /` (`:15`) the searchable list, `GET /:id` (`:128`) the detail.
- `backend/routes/menu.js:15` — `GET /restaurants/:restaurantId`, the whole menu tree.
- `backend/routes/reviews.js:222` — the public review list (detailed in unit 06).
- `backend/routes/directory.js` — three routes, no database at all.

**Controller**
- `backend/services/placesService.js` — the Google Places adapter; holds the API key server-side.

**Middleware**
- **None on the four browse routes.** They are deliberately public. `directory.js:4` sets `Cache-Control: no-store`; `:6` and `:9` apply `rateLimit`.

**SQL**
- `backend/db/schema.sql:165-232` — `restaurants` and `restaurant_branches`; `003_marketplace.sql:3-22` adds cuisine, images, division, fees and ETAs.
- `backend/db/schema.sql:233-301` — `menu_categories`, `menu_items`; `:302-369` — `modifier_groups`, `modifier_options`.

---

## Flow

### The searchable list

1. `GET /api/restaurants?area=&city=&division=&search=&cuisine=&sort=&open_only=&page=&limit=`.
2. **No authentication.** Anyone can browse.
3. `restaurants.js:17-20` rejects any filter that is not a string or is over 100 characters → **400**.
4. `:21-24` validates `page` and `limit` as integers with `limit` capped at 100 → **400**.
5. `:26-27` validates `sort` against a **three-value allowlist** and `open_only` against `'true'/'false'` → **400**.
6. `:28` maps the validated `sort` to one of three fixed `ORDER BY` fragments. This is the only place user input reaches SQL text, and it does so by *selecting between strings written in the file*.
7. `:29-51` runs one query: filters, branch aggregation, and the total row count, all together → **200**.

### One restaurant

1. `GET /api/restaurants/:id` — `restaurants.js:129` parses the id → **400** if not a positive integer.
2. `:138-151` loads the restaurant with its owner's name. Missing → **404** (`:154`).
3. `:161-174` loads its branches, `:181` its categories → **200**.

### Its menu

1. `GET /api/menu/restaurants/:restaurantId` — `menu.js:26-32` confirms the restaurant exists → **404**.
2. `:41-48` categories, `:51-66` items, `:71-95` **every modifier group and option for the whole restaurant in one query**.
3. The loop at `:100-180` slices that flat result into a nested tree in memory. The comment at `:68-70` gives the reason: fetching modifiers per dish would mean one round trip per item.

### The Google Places directory

1. `GET /api/directory/config` (`:5`) reports whether the feature is switched on at all — it needs both `ENABLE_GOOGLE_PLACES` and an API key.
2. `GET /api/directory/search` (`:6`) — rate-limited to 20, proxies to `placesService.search`.
3. `GET /api/directory/photo` (`:9`) — rate-limited to 400, resolves a signed token and **302-redirects** to an approved Google image host.
4. Nothing here touches the database: directory results are never turned into orderable restaurants.

---

## The SQL

**1. The list, filters, aggregation and count in one statement** — `restaurants.js:29-51`
```sql
SELECT r.*, r.avg_rating AS average_rating, u.name AS owner_name,
  COUNT(rb.id)::int AS branch_count,
  COALESCE(json_agg(json_build_object(
    'id',rb.id,'area',rb.area,'city',rb.city,'division',rb.division,
    'is_open',rb.is_open,'delivery_fee',rb.delivery_fee,'min_order_amount',rb.min_order_amount,
    'eta_min',rb.eta_min,'eta_max',rb.eta_max
  ) ORDER BY rb.id) FILTER (WHERE rb.id IS NOT NULL), '[]') AS branches,
  MIN(rb.delivery_fee) AS delivery_fee, MIN(rb.eta_min) AS eta_min, MAX(rb.eta_max) AS eta_max,
  COUNT(*) OVER()::int AS total_count
FROM restaurants r LEFT JOIN users u ON u.id=r.owner_id
LEFT JOIN restaurant_branches rb ON rb.restaurant_id=r.id
WHERE ($1::text='' OR rb.area ILIKE '%' || $1 || '%')
  AND ($2::text='' OR rb.city ILIKE '%' || $2 || '%')
  AND ($3::text='' OR rb.division=$3)
  AND ($4::text='' OR r.name ILIKE '%' || $4 || '%' OR r.cuisine ILIKE '%' || $4 || '%'
    OR rb.area ILIKE '%' || $4 || '%' OR rb.city ILIKE '%' || $4 || '%'
    OR EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id=r.id AND mi.name ILIKE '%' || $4 || '%'))
  AND ($5::text='' OR r.cuisine ILIKE '%' || $5 || '%')
AND ($8::boolean=false OR (r.ordering_enabled=true AND rb.is_open=true))
GROUP BY r.id,u.name ORDER BY ${orderBy} LIMIT $6 OFFSET $7
```
Bound as `[area, city, division, search, cuisine, limit, (page-1)*limit, open_only === 'true']` (`:52`).

Four things worth naming:
- **Optional filters that switch themselves off.** Each condition is `($n::text='' OR …)`, so an empty parameter disables that clause. One fixed SQL string handles every combination of filters — no clauses glued on at runtime.
- **`json_agg(json_build_object(...))`** builds each restaurant's branch list as JSON inside the query, so one row per restaurant comes back already carrying its branches. The `FILTER (WHERE rb.id IS NOT NULL)` paired with `COALESCE(..., '[]')` is what stops a restaurant with no branches producing `[null]`.
- **`COUNT(*) OVER()`** is a window function returning the total number of matching rows *alongside* the page — pagination metadata without a second query.
- **`ORDER BY ${orderBy}`** is interpolated, but `orderBy` was chosen at `:28` from three literals after `:27` validated `sort` against an allowlist. `ORDER BY` cannot take a parameter, so selecting between fixed strings is the correct technique.

**2. Restaurant detail** — `restaurants.js:138-151`
```sql
SELECT
  r.*,
  u.name AS owner_name,

  -- Same stored columns as the list endpoint above, maintained by
  -- trg_sync_restaurant_rating rather than recomputed here.
  r.avg_rating AS average_rating,
  r.review_count
FROM restaurants r
LEFT JOIN users u
  ON r.owner_id = u.id
WHERE r.id = $1
```
`$1` = restaurant id. `LEFT JOIN` so a restaurant whose owner row was removed still renders. **The rating is read, not computed** — the comment says so explicitly, and that is the payoff for unit 06's trigger.

**3. Its branches** — `restaurants.js:161-174`
```sql
SELECT
  id,
  address,
  area,
  city,
  phone,
  latitude,
  longitude,
  division, delivery_fee, min_order_amount, eta_min, eta_max,
  is_open
FROM restaurant_branches
WHERE restaurant_id = $1
```

**4. Menu items** — `menu.js:51-66`
```sql
SELECT
  id,
  category_id,
  name,
  description,
  price,
  image_url, image_credit, image_source_url, image_is_illustrative,
  is_available,
  is_veg,
  quality_flag,
  created_at
FROM menu_items
WHERE restaurant_id = $1
ORDER BY name
```
`$1` = restaurant id. Note `quality_flag` — the column unit 06's complaint pipeline sets — travels to the public menu, and `image_is_illustrative` drives the "Illustrative photo" caption.

**5. Every modifier in one pass** — `menu.js:71-95`
```sql
SELECT
  mg.id AS group_id,
  mg.menu_item_id,
  mg.name AS group_name,
  mg.is_required,
  mg.min_selection,
  mg.max_selection,
  mo.id AS option_id,
  …
FROM modifier_groups mg
JOIN menu_items mi ON …
JOIN modifier_options mo ON …
```
One query for the whole restaurant rather than one per dish. The join to `menu_items` is what scopes it to this restaurant, since `modifier_groups` hangs off an item, not a restaurant. The JavaScript loop below only reshapes rows — **it computes nothing**.

**6. Categories** — `menu.js:41-48` and `restaurants.js:181`
```sql
SELECT
  id,
  name
FROM menu_categories
WHERE restaurant_id = $1
ORDER BY name
```

---

## Transactions

**None, and correctly so.** Every route in this slice is read-only. There is not a single `INSERT`, `UPDATE` or `DELETE` in the browse path, so there is nothing to make atomic.

The one thing worth noting: the detail page issues **three separate queries** (`restaurants.js:138`, `:161`, `:181`) outside any transaction, so in principle a branch could be added between the first and the second. For a public read of a display page that is harmless — nobody is making a decision on the consistency of that snapshot — and wrapping it would cost a connection for no benefit.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Any successful read. |
| **400** | A filter that is not a string or is over 100 characters (`restaurants.js:19`); `page`/`limit` out of range (`:23`); `sort` or `open_only` not in their allowlists (`:27`); an id that is not a positive integer (`:132`, `menu.js:19`). |
| **404** | Restaurant not found (`restaurants.js:154`, `menu.js:35`). |
| **429** | Directory search or photo over its rate limit (`rateLimit.js:21`). |
| **500** | Unexpected failure (`restaurants.js:58`, `menu.js:175`). |
| **502** | Google Places upstream failure or timeout (`directory.js:7`, `:10`). |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **Complex query** | The list query (`restaurants.js:29-51`) is the most complex read in the project: two LEFT JOINs, a correlated `EXISTS`, `json_agg`, three `MIN`/`MAX` aggregates, a window function for the count, `GROUP BY`, and eight bound parameters. |
| **Parameterised SQL** | Every value is bound. The `ILIKE '%' || $n || '%'` form is important — the wildcards are **concatenated in SQL around the parameter**, so the user's text never becomes part of the statement. |
| **Input validation** | Type, length, range and allowlist checks before any query runs. |
| **REST + status codes** | Correct 200/400/404/429/502 across the slice. |
| **TRIGGER (consumed here)** | This slice is the *reader* of `trg_sync_restaurant_rating` — it selects `avg_rating`/`review_count` instead of recomputing them, which is the whole justification for storing them. |
| Role authorization | Deliberately absent — these are the public routes. |

---

## Likely viva questions

**1. `ORDER BY ${orderBy}` is string interpolation. Isn't that an injection hole?**
No, and it is the one case where interpolation is the correct answer. `ORDER BY` takes a column name, not a value, so it cannot be a bound parameter. What we do instead is validate `sort` against a three-value allowlist at `:27` — anything else is a 400 — and then use that value as a *key* to select one of three `ORDER BY` fragments written literally in the file at `:28`. The user's text never reaches the query; it only chooses between strings we wrote.

**2. How does one query handle five optional filters without building the SQL dynamically?**
Each condition is written as `($n::text = '' OR <the real test>)`. An empty parameter makes the left side true and short-circuits the whole clause, so the filter is off. That keeps one fixed statement for every combination — easier to read, and it means the query plan can be cached. The cast `::text` is needed so Postgres knows the parameter's type when comparing it to an empty string.

**3. Why build the branch list with `json_agg` instead of a second query?**
Because a restaurant card needs its branches to show a delivery fee and an ETA, and doing it separately would be one extra round trip per restaurant — sixty on a full page. `json_agg(json_build_object(...))` assembles them inside the same scan. The `FILTER (WHERE rb.id IS NOT NULL)` matters: with a `LEFT JOIN`, a restaurant with no branches produces one row of NULLs, and without the filter that aggregates to `[null]` instead of `[]`.

**4. The restaurant page reads `avg_rating` instead of averaging the reviews. Why trust it? (design justification)**
Because nothing but the database maintains it. `trg_sync_restaurant_rating` recomputes it in the same transaction as any review change, and no application code writes those columns. The alternative — recomputing on read — would mean a three-table join with an aggregate on every card of every listing page, which is the most-run query in the app. We pay a tiny cost on the rare write to make the common read a column lookup. The comment at `restaurants.js:143-144` points at the trigger so a reader knows where the value comes from.

**5. The directory routes are public and hit a paid Google API. What stops abuse?**
Three things. `directory.js:5` reports the feature as disabled unless both the env flag and an API key are present. `:6` and `:9` apply per-IP rate limits — 20 for search, 400 for photos. And the key never leaves the server: `placesService` makes the call, and the photo route 302-redirects to an approved Google host using a signed, expiring token rather than handing the client anything reusable. The honest weakness is that the limiter is in-memory and per-process (`rateLimit.js:1-2`).

---

## Gaps and defects

**DML with no transaction**
- No DML at all in this slice. Nothing to report.

**Ownership bypassable via an id in the URL or body**
- Not applicable — these routes are intentionally public and expose no per-user data. The one thing they *do* expose is `u.name AS owner_name` (`restaurants.js:141`, and in the list at `:38`), so **every restaurant owner's name is public to unauthenticated callers**. That is probably intended for a marketplace, but it is worth being able to say deliberately.

**SQL built by string concatenation**
- One occurrence, and it is safe: `ORDER BY ${orderBy}` at `restaurants.js:50`, where `orderBy` is chosen at `:28` from three literals after `:27` validated the input. No user text is ever concatenated.

**Other defects**

1. **The public browse routes are not rate-limited.** Only `/api/auth/login`, `/api/auth/signup` (`server.js:52-53`) and the two directory routes have limiters. `GET /api/restaurants` runs an eight-parameter query with a correlated `EXISTS` over `menu_items` and is reachable by anyone, unlimited.
2. **`search` uses `ILIKE '%term%'` on five columns plus a subquery.** A leading wildcard cannot use a normal B-tree index, so every search is a sequential scan of `restaurants`, `restaurant_branches` *and* `menu_items`. Correct, but it will not scale, and there is no full-text index.
3. **`GET /api/restaurants/:id` selects `r.*`** (`:140`), which includes internal columns — `is_demo`, `catalog_slug`, `source_url`, `verified_at`, `menu_scope` — that the page never uses. The list endpoint does the same at `:30`. Selecting explicit columns would be tighter, and it would stop a future private column leaking by default.
4. **The detail page costs three round trips** (`:138`, `:161`, `:181`) where the list endpoint manages one. The two endpoints solve the same shape of problem in two different ways.
5. **No caching headers on the browse routes.** Menus and restaurant details change rarely and are read constantly; only the directory sets a cache header, and that one sets `no-store`.
6. **`GET /api/menu/restaurants/:restaurantId` returns unavailable items.** `is_available` is selected (`menu.js:59`) and left to the frontend to honour — consistent with how the cart re-checks at add time, but it means the public payload lists food that cannot be bought.

---

## Explain-it-in-60-seconds

Browsing is the only fully public part of the API — no token, no role, and no writes anywhere in it. The centrepiece is the restaurant list, which does everything in one statement. Five filters are optional, and instead of building SQL dynamically we write each condition as "parameter is empty OR the real test", so an empty parameter switches its own clause off and one fixed query handles every combination. The branch list for each restaurant is assembled inside the query with json_agg, so one row comes back already carrying its branches instead of costing a round trip each. And the total row count for pagination comes from `COUNT(*) OVER()`, a window function, so we don't run a second counting query.

Sorting is the one place user input touches SQL text, because ORDER BY takes a column name and can't be a bound parameter. We handle that by validating `sort` against a three-value allowlist and then using it as a key to pick one of three ORDER BY fragments written literally in the file — the user's text never reaches the query.

The restaurant page reads `avg_rating` straight off the restaurant row rather than averaging the reviews, because a trigger keeps that column correct inside the same transaction as any review change. That's the payoff for storing a derived value: the most-run read in the app becomes a column lookup.

Two things I'd flag honestly: the search uses leading-wildcard ILIKE across three tables, so it's a sequential scan and won't scale without a full-text index; and these public routes have no rate limit at all, unlike login and the Google Places proxy.

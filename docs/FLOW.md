# FLOW.md

Feature-by-feature walkthroughs of Cravio, written to be read out loud in
an evaluation without needing anything looked up afterwards. Every feature
added or changed gets an entry here in the format below.

---

### Restaurant rating (stored average + review count, kept correct by a trigger)

**Files involved:**

- `backend/db/functions/restaurant_rating.sql` — the function, the trigger function, the trigger, and the one-time backfill
- `backend/db/migrations/002_restaurant_ratings.sql` — adds the two columns to an existing database
- `backend/db/schema.sql` — the same two columns, for a database created from scratch (`restaurants` table)
- `backend/routes/reviews.js` — writes reviews (`POST /api/reviews/orders/:orderId`), reads the summary (`GET /api/reviews/restaurants/:restaurantId`)
- `backend/routes/restaurants.js` — reads the rating in the list (`GET /api/restaurants`) and detail (`GET /api/restaurants/:id`) endpoints
- `backend/tests/e2e.js` — asserts the rating is populated after a review is posted

---

**Flow (exam-level explanation):**

**What this feature is.** Every restaurant shows a star rating and a number
of reviews. Those two values are stored on the restaurant's own row in the
database, in the columns `avg_rating` and `review_count`. Nothing in our
JavaScript code ever writes them. The database keeps them correct by
itself.

**First, the problem this solves.**

1. A review is not attached to a restaurant in our database. A review is
   attached to an *order*.
2. An order was placed at a *branch* — one physical outlet, for example
   "Pizza Republic, Dhanmondi".
3. A branch belongs to a *restaurant*.
4. So to answer "what is Pizza Republic's average rating?", the database
   has to connect three tables: reviews → orders → branches. Connecting
   tables like this is called a **join** — it means matching rows in one
   table to rows in another using a shared value, here the order's id and
   the branch's id.
5. Before this feature, that three-table join ran *every single time*
   anyone looked at a restaurant. On the restaurant list page it ran twice
   for every restaurant in the list — once for the average, once for the
   count.

**Second, the decision — and this is the part to defend.**

The rating is a **derived value**. That means it is not a new fact; it can
always be worked out from facts we already store, namely the review rows.
There are exactly two ways to handle a derived value.

- **Compute it live.** Work it out from the reviews each time somebody
  asks. This is always correct, because there is only one copy of the
  truth. But you pay for that three-table join on every read.
- **Store it.** Keep a copy of the answer on the restaurant row and read
  that copy. This is fast — reading one number from a row you already
  fetched costs nothing extra. Storing a derived value like this is called
  **denormalization**: deliberately keeping a second, redundant copy of
  something you could have recalculated, in exchange for speed.

We chose to store it. The reason is the **read/write ratio**. A rating is
read on almost every page in the app — every restaurant list, every
restaurant page. A rating *changes* only when a customer finishes a
delivered order and writes a review, which is rare by comparison. It is a
bad trade to pay a three-table join on thousands of reads to stay correct
for a handful of writes.

**Third, the cost of that decision, and how we remove it.**

Denormalization has one real danger, and an examiner will ask about it:
the stored copy can **drift**. Drift means the stored number stops
matching the rows it was supposed to summarise — a review gets deleted,
nobody updates the copy, and the restaurant keeps showing a rating it no
longer earns. A wrong number that looks confident is worse than a slow one.

The usual way to prevent drift is to make the application update the copy
every time it changes a review. That is fragile, because it only works as
long as every present and future code path remembers to do it. One
forgotten `UPDATE`, one fix applied by hand in the database console, and
the number is silently wrong forever.

So we do not rely on the application at all. We use a **trigger**. A
trigger is a piece of code stored inside the database itself that the
database runs automatically whenever a particular table changes — nobody
has to call it, and there is no way to change the table without it running.

That is the whole argument: **the trigger is what makes the
denormalization safe.** The stored rating cannot drift, because the only
way to alter a review is to alter the `restaurant_reviews` table, and any
alteration to that table fires the recompute. The copy is updated inside
the same **transaction** as the review change — a transaction is a group
of database operations that either all take effect or none do — so there
is no moment at which someone could read a review that exists while the
rating still says it does not.

**Fourth, what actually happens when a customer reviews their meal.**

1. The customer sends `POST /api/reviews/orders/:orderId` with a rating
   from 1 to 5.
2. `backend/routes/reviews.js` checks they are logged in, that they are a
   customer, that the order is theirs, and that it was actually delivered.
3. It runs `BEGIN`, which opens a transaction.
4. It inserts one row into `restaurant_reviews`.
5. **The database now takes over.** The insert fires the trigger
   `trg_sync_restaurant_rating`. Our code did not ask for this and cannot
   skip it.
6. The trigger's code looks at the review it was handed, follows
   order → branch → restaurant to work out which restaurant was affected,
   and rewrites that restaurant's `avg_rating` and `review_count` from the
   review rows as they now stand.
7. Control returns to `routes/reviews.js`, which runs `COMMIT` — making
   the new review *and* the updated rating permanent together. If anything
   had failed, `ROLLBACK` would have discarded both.
8. The next person to load the restaurant list reads the new rating
   directly off the restaurant row. No join.

**Fifth, the three situations the trigger has to handle.**

The trigger is declared `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW`.
Taking that apart:

- **`AFTER`** — it runs once the change has actually succeeded, not while
  it is still being attempted. This matters: a review with an invalid
  rating of 9 is rejected by the table's rules, and because we chose
  `AFTER`, it never moves the restaurant's average.
- **`FOR EACH ROW`** — it runs once per review row changed. It needs this,
  because it needs to see *which* review changed in order to find its
  restaurant.
- **`INSERT OR UPDATE OR DELETE`** — all three, described below.

1. **A review is inserted.** Recompute the restaurant that review belongs
   to. This is the everyday case.
2. **A review is updated.** Recompute the restaurant it belongs to now. If
   the review was moved to an order at a *different* restaurant, recompute
   the restaurant it left as well — otherwise that one keeps counting a
   review it no longer has. This is why the trigger collects a *list* of
   affected restaurants rather than a single one.
3. **A review is deleted.** Recompute the restaurant it used to belong to.
   The important case here is deleting the *last* review: the restaurant
   must go back to "unrated", not keep the rating it had. We do not
   special-case this. Because the trigger recomputes from scratch, a
   restaurant with no review rows left simply gets `NULL` for the average
   and `0` for the count, which is exactly right.

Note on `NULL`: an unrated restaurant stores `NULL`, not `0.00`. `NULL`
means "we have no information". `0.00` would be a claim — that the
restaurant was rated, and rated as badly as possible. A brand-new
restaurant must not be displayed as the worst in the city.

**Sixth, why the trigger recomputes instead of adjusting.**

There is a cheaper way to maintain an average: keep the running total and,
when a 4-star review arrives, nudge the stored average by the right amount
without looking at the other reviews. We deliberately do not do this. That
approach is unforgiving — if the stored number is ever wrong by even a
little, every future adjustment builds on the wrong number and it never
recovers. Recomputing from the review rows every time is slightly more
work, but it is **self-healing**: however the number got wrong, the next
review on that restaurant re-derives it from the truth and fixes it. Since
reviews are rare, we are buying a lot of safety for very little cost.

**Seventh, where the FUNCTION fits.**

A **function** in a database is a named, stored calculation you can call by
name, exactly like a function in JavaScript. Ours is
`restaurant_avg_rating(restaurant_id)`. You give it a restaurant's id and
it returns that restaurant's average rating as a number.

It exists because the same average is needed in two separate places that
must never disagree: inside the trigger, and in the one-time backfill
described next. Writing the calculation out twice by hand would be two
chances to write it differently. It is marked `STABLE`, which is a promise
to the database that the function only reads data and never changes it —
that promise lets the database call it once instead of repeatedly.

**Eighth, the backfill.**

A trigger only fires on changes made *from now on*. The 32 reviews already
sitting in our database when we added this feature never fired anything, so
the new columns started out empty and wrong. The last statement in
`restaurant_rating.sql` fixes this once: it walks every restaurant and sets
both columns from the reviews that already exist. It covers *every*
restaurant, not only the ones with reviews, so that unrated restaurants are
explicitly set to `NULL` and `0` rather than left at whatever the column
happened to contain.

**Ninth, where these files go in the setup order.**

```bash
psql "$DATABASE_URL" -f backend/db/schema.sql
psql "$DATABASE_URL" -f backend/db/functions/place_order.sql
psql "$DATABASE_URL" -f backend/db/functions/restaurant_rating.sql   # last
```

`restaurant_rating.sql` runs last because its backfill reads four tables
that `schema.sql` has to have created first. It is independent of
`place_order.sql`. For a database that already existed before this feature,
run `backend/db/migrations/002_restaurant_ratings.sql` first — it only adds
the two columns — and then the same `restaurant_rating.sql`.

---

**Key SQL queries:**

```sql
CREATE OR REPLACE FUNCTION restaurant_avg_rating(p_restaurant_id INTEGER)
RETURNS NUMERIC
AS $$
    SELECT ROUND(AVG(rev.rating), 2)
    FROM restaurant_reviews rev
    JOIN orders o              ON o.id = rev.order_id
    JOIN restaurant_branches b ON b.id = o.branch_id
    WHERE b.restaurant_id = p_restaurant_id;
$$ LANGUAGE sql STABLE;
```

Averages the ratings of every review belonging to one restaurant; it is
written as a three-table join because a review records only its order, so
the restaurant can be reached only by going review → order → branch, and it
returns `NULL` rather than `0` when there are no reviews because "unrated"
and "rated zero" are different claims.

```sql
UPDATE restaurants
SET avg_rating   = restaurant_avg_rating(v_restaurant_id),
    review_count = (
        SELECT COUNT(*)
        FROM restaurant_reviews rev
        JOIN orders o              ON o.id = rev.order_id
        JOIN restaurant_branches b ON b.id = o.branch_id
        WHERE b.restaurant_id = v_restaurant_id
    )
WHERE id = v_restaurant_id;
```

The recompute at the heart of the trigger; it rebuilds both stored values
from the review rows rather than adjusting them by a difference, which is
what makes the numbers self-correcting, and it needs no special case for
"last review deleted" because with no rows left `AVG` naturally yields
`NULL` and `COUNT` yields `0`.

```sql
CREATE TRIGGER trg_sync_restaurant_rating
    AFTER INSERT OR UPDATE OR DELETE
    ON restaurant_reviews
    FOR EACH ROW
    EXECUTE FUNCTION sync_restaurant_rating();
```

Attaches the recompute to the reviews table so the database performs it
automatically; `AFTER` so a rejected review cannot move a rating, and
`FOR EACH ROW` so the code can see which review changed and therefore which
restaurant to recompute.

```sql
SELECT r.id, r.name, r.avg_rating AS average_rating, r.review_count
FROM restaurants r
JOIN users u ON r.owner_id = u.id;
```

The read side, from `routes/restaurants.js`: the entire point of the
feature is that this is now a plain column read instead of two correlated
subqueries per restaurant, and it is safe to trust precisely because the
trigger above guarantees the column agrees with the reviews.

---

### Safe installation and repeatable migrations

**Files involved:** `backend/scripts/migrate.js`, `backend/scripts/doctor.js`, `backend/db/migrations/003_marketplace.sql`, `004_operations.sql`, `005_catalog_sources.sql`, `scripts/setup.js`.

**Flow:** Setup creates only missing environment files. The migration runner connects to PostgreSQL, obtains a transaction-level advisory lock, and inspects the schema. Only an empty schema is bootstrapped from the original schema file. Existing installations receive numbered additive migrations, with a checksum ledger preventing accidental rewrites of applied migrations. SQL functions/procedures are refreshed after migrations. Any failure rolls back the transaction; the doctor checks connectivity and installation without printing credentials.

### Public discovery, honest catalogs and photography

**Files involved:** `backend/routes/restaurants.js`, `backend/scripts/importCatalog.js`, `backend/scripts/seedBangladesh.js`, `backend/scripts/seedRealBangladesh.js`, `backend/data/official-*.json`, `frontend/src/pages/HomePage.jsx`, `RestaurantPage.jsx`, `components/RestaurantCard.jsx`, `FoodImage.jsx`.

**Flow:** Public search applies division/city/area/cuisine/query filters in parameterized SQL and returns paginated results. Sort order is selected from a fixed whitelist. The frontend searches asynchronously and shows genuine loading/error/empty states. Menu items, logos and gallery photos resolve local `/media` URLs against the configured API host. Credits and source links remain visible. Fictional demos are marked `is_demo=true`. Import validates the entire catalog, serializes concurrent imports and inserts only missing records inside a transaction.

The four sourced brands are imported with `ordering_enabled=true` so the checkout, delivery and review lifecycle can be demonstrated end to end against a real menu — see "Opening a restaurant shows the right restaurant" above for how that catalogue is built and what it does and does not claim. Enabling ordering is a coursework decision, not a merchant relationship: no order reaches a real restaurant and no money moves. Onboarding an actual merchant would still need the verification work listed in `docs/REVIEW.md`.

### Opening a restaurant shows the right restaurant (brand catalogue)

**Files involved:**

- `frontend/src/pages/HomePage.jsx` — the restaurant list; this is where the bug was
- `frontend/src/pages/RestaurantPage.jsx` — the restaurant detail page and its menu
- `frontend/src/data/demoMode.js`, `frontend/src/data/realBangladeshRestaurants.js` — **deleted**; these held the substitute list
- `backend/scripts/buildBrandCatalog.js` — folds the per-outlet source snapshots into one restaurant per brand
- `backend/scripts/seedRealBangladesh.js` — creates the brand owner accounts and imports the merged catalogue
- `backend/scripts/illustrativePhotos.js` — picks a stand-in photo for a dish whose source published none
- `backend/scripts/backfillPhotos.js` — attaches those stand-ins to rows that have no photo
- `backend/scripts/importCatalog.js` — the validating importer both seeds go through (unchanged)
- `backend/data/official-{kacchi-bhai,kfc,bfc,chillox}.json` — the source snapshots (unchanged)
- `backend/db/migrations/005_catalog_sources.sql` — adds `logo_url` and `gallery` to `restaurants`

---

**Flow (exam-level explanation):**

**The symptom.** You clicked "Kacchi Bhai" on the home page and landed on a
completely different restaurant, whose dishes had no photographs.

**First, why it happened.**

1. The home page asked the server for the restaurant list, over the
   **API** — the set of web addresses our own server answers, here
   `GET /api/restaurants`.
2. It then **threw that answer away**. A flag in the frontend,
   `demoMode.useLocalRestaurantFallback`, was set to `true`, and the code
   replaced the server's list with a list written by hand inside the
   frontend file `realBangladeshRestaurants.js`.
3. That hand-written list numbered its restaurants 1, 2, 3, 4 — Chillox,
   KFC, Kacchi Bhai, BFC. Those numbers were invented by whoever typed
   the file.
4. Each card linked to `/restaurants/<number>`. Clicking Kacchi Bhai went
   to `/restaurants/3`.
5. The detail page did **not** use the hand-written list. It asked the
   server: `GET /api/restaurants/3`. The server looked up restaurant
   number 3 in PostgreSQL, and in the real database number 3 was
   "Wok & Roll".
6. The database answered successfully, so nothing looked broken. You got
   Wok & Roll's page. Its dishes had no `image_url` stored, so every
   photo slot fell back to the empty-plate placeholder.

The root cause in one sentence: **two different lists of restaurants were
in use, and only one of them had real id numbers.** An id number is only
meaningful inside the database that issued it.

**Second, the fix on the frontend.**

The substitute list is gone — both files deleted — and both pages now
read only what the server sends. A card's id is therefore the same id the
detail page looks up, because both came from the same `SELECT`. If the
server cannot be reached, the pages now show an error instead of quietly
showing different restaurants.

**Third, the fix in the database — why the catalogue had to be reshaped.**

The real data was already in the project, in four files of published
brand information. But those files store **one restaurant record per
outlet**: "Kacchi Bhai — Badda", "Kacchi Bhai — Board Bazar", and 45
more. Imported as-is that is 139 separate restaurants, and the home page
becomes 139 near-identical cards.

That shape also contradicts our own tables. Our schema already says a
restaurant *has many* branches: `restaurants` holds the brand, and
`restaurant_branches` holds each physical outlet, joined by
`restaurant_branches.restaurant_id`. A **join** here means matching rows
in one table to rows in another through a shared value — the brand's id.
The per-outlet shape throws that relationship away and copies the whole
menu 47 times.

So `buildBrandCatalog.js` folds each brand back into one restaurant:

1. Read all 47 Kacchi Bhai records.
2. Take every record's outlet and collect them into one list of branches,
   dropping repeats by street address.
3. Take every record's menu and merge it into one menu, dropping repeats
   by dish name. Kacchi Bhai and KFC publish one brand-wide menu that
   every outlet repeats, so this collapses to a single copy. BFC and
   Chillox publish a slightly different menu per outlet, so this unions
   them into one full brand menu.
4. Keep the first record's hero photo, logo, source link and credits.
5. Pool the outlets' photographs into a gallery, capped at twelve.

The result is 4 restaurants and 195 dishes, instead of 139 restaurants
and 5,363 duplicated dishes.

Each brand then keeps three Dhaka branches — Khilgaon first, then
Dhanmondi and Lalbagh where the brand actually has one, topped up from
its other Dhaka outlets otherwise. Forty-seven buttons is not a choice.
The full published outlet lists stay in the source files, untouched.

**Fourth, why ordering had to be switched on deliberately.**

The source snapshots were built as a read-only directory, so every outlet
is marked closed and every dish unavailable. Imported unchanged, the
brands would appear and then refuse every order. The builder sets
`is_open` and `is_available` to true, and sets `ordering_enabled` on the
restaurant.

`importCatalog.js` will not enable ordering on a restaurant that nobody
owns, so `seedRealBangladesh.js` first creates one `restaurant_owner`
account per brand. Both steps run inside a single **transaction** — a
group of database operations that either all take effect or none do — so
a brand can never end up with an owner login but no menu.

These are coursework demonstration accounts. The published source link and
the photo credits stay visible on every restaurant page, and no order
placed here reaches a real restaurant or moves any money.

**Fifth, the photographs.**

Photos are files on disk under `backend/data/images`, served by the API at
`/media/<filename>`. The database stores only the path.

Most dishes carry their brand's own published photograph. Three groups did not:

1. The five original sample restaurants (Chuli Kitchen, Pizza Republic,
   Wok & Roll, The Burger Yard, Green Bowl) were seeded before menu photos
   existed.
2. BFC publishes no photo for 47 of its dishes.
3. Chillox misses one.

`backfillPhotos.js` fills these from the eight generic food photographs
already in the project, choosing one by matching keywords in the dish
name — "Kacchi Biryani" gets the biryani photo, "Yard Classic" gets the
burger photo. If the dish name says nothing useful, its category name is
tried instead, which is how "Margherita" gets a photo from sitting under
"Pizzas".

Two rules keep this honest:

- Everything it writes is flagged `image_is_illustrative`, and the menu
  prints "Illustrative photo" beneath any image carrying that flag. A
  stock burger is never presented as BFC's own photograph.
- A dish matching nothing is left with no photo at all. "Extra Bun",
  "BBQ DIP" and "Delivery charge" show the honest empty-plate placeholder
  rather than a stock picture of something they are not.

One subtlety worth knowing, because it was a real bug: the keyword match
requires each keyword to **start** a word. Without that, "Yard Classic"
matched `lassi` — the letters l-a-s-s-i sit inside "C**lassi**c" — and a
burger was served with a photograph of a drink.

**Sixth, why a new order does not reach a rider straight away.**

This is not a fault, and it is worth being able to explain. A rider's
"available jobs" query asks for orders whose status is `preparing`:

1. The customer checks out. The order is `pending`.
2. The **restaurant owner** logs in, accepts it (`confirmed`), then starts
   cooking (`preparing`).
3. Only now does the order appear to every online rider.
4. One rider claims it. The claim takes a row lock so two riders cannot
   win the same order, and the customer's address is disclosed only after
   a successful claim.

So an order sitting at `pending` is invisible to riders by design — the
food is not cooking yet. Because each of the four brands is owned by its
own account, the owner step must be done from that brand's login
(`owner.kacchibhai@cravio.test` and so on, listed in `docs/SETUP.md`), not
from a different owner's account. The rider dashboard's empty state now
spells this sequence out rather than showing a bare "no deliveries".

**Seventh, what you now see.**

Nine restaurants, all with photographs. Clicking Kacchi Bhai opens Kacchi
Bhai: its logo, its 12-photo gallery, its 47 branches to choose between,
and its menu — four published dishes with the brand's own photographs,
plus ten kitchen favourites added for the demonstration and labelled as
such — which you can add to a cart and order. Its logo now appears on the
restaurant page too; the page was reading `image_url` but never
`logo_url`.

---

**Key SQL queries:**

```sql
SELECT r.*, COUNT(rb.id)::int AS branch_count,
  COALESCE(json_agg(json_build_object(
    'id', rb.id, 'area', rb.area, 'division', rb.division,
    'is_open', rb.is_open, 'delivery_fee', rb.delivery_fee
  ) ORDER BY rb.id) FILTER (WHERE rb.id IS NOT NULL), '[]') AS branches
FROM restaurants r
LEFT JOIN restaurant_branches rb ON rb.restaurant_id = r.id
GROUP BY r.id;
```

The home page list, from `routes/restaurants.js`. It is a `LEFT JOIN` so a
brand with no branches still appears rather than vanishing, and the
branches are folded into one JSON array per restaurant by `json_agg` with
`GROUP BY r.id`, so 47 Kacchi Bhai outlets arrive as one card carrying 47
branches instead of 47 cards. The `id` it returns is the same `id` the
detail page is about to look up — which is the whole point of the fix.

```sql
SELECT id, owner_id, is_demo FROM restaurants WHERE catalog_slug = $1;
```

The importer's guard, run once per brand before inserting anything.
`catalog_slug` is a stable text name we choose (`brand-kacchi-bhai`), not
a number, so re-running the import finds the brand it created last time
and inserts nothing — that is what makes the seed safe to run twice.

```sql
INSERT INTO restaurant_branches
  (restaurant_id, address, area, city, division, is_open, delivery_fee, eta_min, eta_max)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
```

One row per outlet, all pointing at the single brand row through
`restaurant_id`. This is the relationship the per-outlet import was
throwing away, and it is what lets the restaurant page offer a branch
picker and lets `place_order()` charge that branch's delivery fee.

```sql
UPDATE menu_items
SET image_url = $2, image_credit = $3, image_source_url = $4, image_is_illustrative = true
WHERE id = $1 AND image_url IS NULL;
```

The photo backfill. The `image_url IS NULL` in the `WHERE` clause is the
safety catch: it repeats the condition the row was selected on, so even if
the row gained a real photograph between the `SELECT` and this `UPDATE`,
a stock photo can never overwrite a brand's own photograph.

```sql
SELECT mi.id, mi.name, COALESCE(mc.name, '') AS category_name
FROM menu_items mi
LEFT JOIN menu_categories mc ON mc.id = mi.category_id
WHERE mi.image_url IS NULL;
```

Finds the dishes still lacking a photo, and brings each one's category
name along so "Margherita" can be recognised from sitting under "Pizzas".
The join is a `LEFT JOIN` because `menu_items.category_id` is
`ON DELETE SET NULL`, so a dish is allowed to have no category, and an
inner join would silently skip exactly those dishes.

---

### Role-specific sign-in, the food slideshow and the wider catalogue

**Files involved:**

- `frontend/src/utils/roles.js` — the three account types and their copy, photo and accent colour
- `frontend/src/components/RoleChooser.jsx` — the "who are you here as?" fork
- `frontend/src/components/AuthForm.jsx` — one themed form, role fixed by the URL
- `frontend/src/pages/LoginPage.jsx`, `SignupPage.jsx`, `frontend/src/App.jsx` — the `/login/:role` and `/signup/:role` routes
- `frontend/src/components/FoodSlideshow.jsx`, `frontend/src/utils/format.js` — the rotating hero photographs
- `backend/scripts/fetchCommonsPhotos.js` — downloads freely-licensed dish photography
- `backend/scripts/makeWordmarks.js` — draws placeholder logos for brands whose real logo is not licensed to us
- `backend/scripts/buildAddedRestaurants.js` — Sultan's Dine, Khana's, Domino's Pizza, Takeout, Fry Bucket
- `backend/scripts/divisionBranches.js`, `expandBranches.js` — one outlet per division for every restaurant
- `backend/data/commons-photo-sources.json` — the author and licence of every downloaded photo

---

**Flow (exam-level explanation):**

**First, why signing in is now three pages instead of one.**

Cravio has three kinds of user who can register themselves: a customer, a
rider, and a restaurant owner. Previously all three shared one form, and
the visitor picked their kind from a dropdown *inside* it.

That is backwards. A rider and a diner want completely different things
from the next screen, so real delivery apps ask "who are you here as?"
*before* asking for a password.

1. `/signup` shows three cards — Customer, Rider, Restaurant owner — each
   with its own photograph, colour and one-line promise.
2. Choosing one goes to `/signup/customer`, `/signup/rider` or
   `/signup/owner`.
3. That page renders the same form component, themed for the role, with
   the role already decided. There is no dropdown left to get wrong.
4. `/login` works the same way.

The URL says `owner`, not `restaurant_owner`, because a web address should
not leak the database's spelling of a value.

**A security point worth making out loud.** The role in the signup request
is still just a value the browser sent, and the server does not trust it
any further than it did before: `POST /api/auth/signup` refuses `admin`
outright, and on *login* the role is read from the user's own row rather
than taken from the client at all. These pages are a nicer way to ask the
question, never the thing that answers it.

**Second, the homepage slideshow.**

The hero used to show one fixed burger. It now cross-fades through six
dishes. Three details matter:

1. Every slide sits in the *same* grid cell and only its opacity changes,
   so the panel never resizes and the page cannot jump as pictures swap.
2. The first image loads eagerly and the rest lazily — the hero should
   paint at once, but nobody should pay to download picture six before
   seeing picture one.
3. If the visitor's system asks for reduced motion, the rotation stops.
   Dots underneath let anyone step through by hand, and the current dish
   is announced to screen readers.

**Third, where the new photographs came from.**

The five added restaurants have no published menu snapshot, so they needed
food photography. It is downloaded from **Wikimedia Commons** rather than
a general image search, for one reason: every file on Commons states its
author and its licence in machine-readable metadata, so the script can
record both. A photo whose licence we cannot state is a photo we should
not hand in.

Each downloaded photo is a stock picture *of the dish*, not of that
restaurant's cooking, so every one is flagged `image_is_illustrative` and
the menu prints "Illustrative photo" beneath it.

Logos are split. Domino's is on Commons under a free licence, so it is the
real logo. The four Bangladeshi chains' logos are ordinary copyrighted
brand art with no licence permitting redistribution, so
`makeWordmarks.js` draws a plain wordmark from the restaurant's own name
instead. It obviously is not the real logo — which is the honest outcome.

**Fourth, why the five added restaurants are marked `is_demo`.**

Sultan's Dine, Khana's, Domino's Pizza, Takeout and Fry Bucket are real
businesses, but their menus and prices here were written by us. Publishing
invented prices under a real business's name without saying so is the one
thing this catalogue has refused to do throughout.

So each carries `is_demo: true`, and the restaurant card prints "Sample
restaurant" because of it. They remain fully orderable, so the entire
checkout → delivery → review lifecycle can be demonstrated against them.
They deliberately carry no `source_url`, because that field drives an
"Official listing · source checked" line and we checked no source.

**Fifth, the "IMAGE COMING SOON" bug.**

Kacchi Bhai's restaurant page showed a grey graphic reading "IMAGE COMING
SOON". That was not a broken image: it was the file itself. Every one of
its 47 outlet pages publishes that placeholder where a photograph should
be, and the scraper stored it like any other image, so it became the
brand's hero.

The builder now keeps a list of known placeholder files and refuses to let
one become a hero image or enter a gallery. Kacchi Bhai's hero is
overridden with a licensed photograph of kacchi biryani — the only other
images its snapshot carries are dining-room interiors, which tell a hungry
customer nothing. A regression test asserts the placeholder can never come
back.

This forced one deliberate change to the importer's validation. It used to
refuse live ordering on any real-named restaurant whose hero was flagged
illustrative. That rule was aimed at a real risk — passing stock
photography off as a restaurant's own — but `image_is_illustrative` is
precisely the *admission* that we are not doing so, and the page says as
much underneath the picture. The guard now still demands a verified owner,
a checked date and an actual image; what stays banned is a missing image
or an **unflagged** stand-in.

**Sixth, national coverage.**

Every restaurant now has an outlet in all eight divisions, so a customer
in Sylhet is not shown an empty homepage. Dhaka keeps three or four
branches, because that is where the testing happens and one city-wide
branch makes the branch picker pointless.

For the four sourced brands the three Dhaka branches are their real
published addresses; the seven added ones are ordinary city-centre areas.
`expandBranches.js` does the same for the older sample restaurants, which
had only one or two Dhaka outlets each.

---

**Key SQL queries:**

```sql
INSERT INTO restaurant_branches
  (restaurant_id, address, area, city, division, is_open,
   delivery_fee, min_order_amount, eta_min, eta_max)
SELECT $1, $2, $3, $4, $5, true, $6, $7, $8, $9
WHERE NOT EXISTS (
  SELECT 1 FROM restaurant_branches WHERE restaurant_id = $1 AND address = $2
);
```

The division top-up. `INSERT … SELECT … WHERE NOT EXISTS` rather than a
plain `INSERT` makes the script safe to run twice: the row is only written
if that restaurant does not already have a branch at that address, and the
check happens inside the same statement, so two runs at once cannot both
decide the row is missing.

```sql
UPDATE restaurants
SET image_url = $1, image_credit = $2, image_source_url = $3, image_is_illustrative = true,
    gallery = (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
               FROM jsonb_array_elements(gallery) p
               WHERE p->>'image_url' <> $4)
WHERE catalog_slug = 'brand-kacchi-bhai';
```

Replaces the placeholder hero already sitting in the database. The
importer only ever inserts, so a bad value it wrote once has to be
corrected explicitly. The gallery is rebuilt by unnesting the JSON array,
dropping the placeholder element and re-aggregating — with `COALESCE`
because `jsonb_agg` over no surviving rows returns `NULL`, which would
wipe the column rather than empty it.

```sql
SELECT r.*, COUNT(rb.id)::int AS branch_count
FROM restaurants r
LEFT JOIN restaurant_branches rb ON rb.restaurant_id = r.id
WHERE ($3::text = '' OR rb.division = $3)
GROUP BY r.id;
```

The division filter behind "restaurants in Sylhet". The `$3::text = ''`
half is what lets one query serve both the filtered and unfiltered case
without building SQL by hand — an empty filter matches every row, so there
is no second query and no string concatenation.

---

### Account profiles, addresses and favorites

**Files involved:** `backend/routes/account.js`, `frontend/src/pages/AccountPage.jsx`, `frontend/src/services/accountApi.js`, `backend/db/migrations/003_marketplace.sql`.

**Flow:** Authentication resolves the active database user rather than trusting a caller-supplied role. Profile edits accept a limited set of fields. Address mutations constrain the row by both address ID and customer ID; a per-customer lock ensures two concurrent writes cannot leave two default addresses. Coordinate pairs are validated together. Favorite insertion uses a composite key to make repeated saves idempotent. The frontend renders each mutation's actual result or API error.

### Cart concurrency, pricing and checkout snapshots

**Files involved:** `backend/routes/cart.js`, `backend/services/orderService.js`, `backend/db/functions/place_order.sql`, `frontend/src/context/CartContext.jsx`, `frontend/src/pages/CheckoutPage.jsx`, `frontend/src/components/OrderReceipt.jsx`.

**Flow:** Cart mutations lock the parent cart so equivalent modifier sets merge correctly under concurrent additions. Checkout runs inside an explicit transaction, checks customer/owner activity and branch/restaurant ordering state, locks the cart and relevant menu/modifier rows, validates stock choices, applies a valid promo and adds the branch delivery fee. Name, photo and price/modifier snapshots are stored on the order before the cart is emptied. A second simultaneous checkout cannot create another order from that consumed cart. The UI clears its cart only after a committed response and navigates to the saved receipt. Client estimates are never the payment authority.

### Delivery assignment and atomic COD completion

**Files involved:** `backend/routes/rider.js`, `backend/db/functions/complete_delivery.sql`, `frontend/src/pages/RiderDashboardPage.jsx`.

**Flow:** Available-job listings omit a customer's private delivery address until assignment. Claiming locks the rider profile/order and verifies availability and order state. Concurrent riders cannot both win a claim. Only the assigned rider can move through pickup and delivery states. The completion procedure updates delivery and order, settles cash on delivery and makes the rider available again atomically. If any prerequisite fails, no partial update is committed. Gross completed delivery fees are displayed; there is no claim that these are actual payout transfers.

### Timeline and manual payment reconciliation

**Files involved:** `backend/db/migrations/003_marketplace.sql`, `backend/routes/payments.js`, `backend/services/orderService.js`, `frontend/src/components/OrderReceipt.jsx`.

**Flow:** The order-status trigger appends status events inside the same transaction as each transition. Receipts display those recorded times and item snapshots. Legacy records are not assigned invented historical event timestamps. Mobile-wallet references are enabled only through configuration and are recorded as unverified references. A customer cannot mark a payment paid. Owner/admin verification uses row/advisory locks to serialize settlement/reference reuse. Paid payments cannot be silently reversed; paid cancellations return a refund-required error pending a real refund workflow.

### Restaurant, admin and support operations

**Files involved:** `backend/routes/operations.js`, `backend/routes/restaurants.js`, `backend/routes/menu.js`, `frontend/src/pages/OwnerDashboardPage.jsx`, `AdminDashboardPage.jsx`, `frontend/src/components/OwnerItemEditor.jsx`, `RestaurantSettings.jsx`, `BusinessSummary.jsx`, `SupportPanel.jsx`.

**Flow:** Owners edit only their own restaurant/menu records, including images and modifier options. Operational order transitions retain their allowed state rules. Admins view paginated orders/users, manage percentage promotions and resolve support tickets. All roles can open/read their own support requests, while admin replies/resolutions are separately authorized. Business summaries aggregate recorded completed/paid amounts within the caller's role scope. Customer roles are rejected at business-summary and admin endpoints. Dashboards periodically refresh current orders; they do not simulate live map tracking.

### Optional Google Places city directory

**Files involved:** `backend/routes/directory.js`, `backend/services/placesService.js`, `frontend/src/pages/DirectoryPage.jsx`, `backend/tests/catalog.test.js`, `docs/DATA_SOURCES.md`.

**Flow:** The user chooses one of eight division-capital cities and submits a neighborhood/food search. A fixed city search viewport and restaurant type restrict the query. The server holds the API key, requests only needed fields and returns source attribution with a signed next-page token. Photo requests use a signed expiring resource name and only redirect to an approved Google image host. Browser/server responses are not persisted as a catalog. The page preserves Google Maps and contributor attribution, deduplicates results within a search and honestly reports disabled configuration or exhausted results. The adapter does not turn directory discoveries into orderable merchants.

### Regression verification

**Files involved:** `scripts/test-backend.js`, `backend/tests/e2e.js`, `marketplace.js`, `operations.js`, `catalog.test.js`.

**Flow:** The harness refuses the application database and requires an explicitly named disposable test/review database. It migrates, seeds, starts a temporary API, exercises auth/ownership/concurrency/full order lifecycle and stops the API. Catalog/provider unit tests separately validate the source snapshots and exercise the optional Places adapter with fixture fetches, so they do not incur provider charges. `docs/REVIEW.md` records the observed results and remaining verification boundaries.

### Role-gated login (the card you click is checked, never believed)

**Files involved:**

- `backend/routes/auth.js` — the login and signup routes, the role allowlists, the mismatch check
- `backend/db/schema.sql` — the `CHECK (role IN (...))` constraint the allowlist mirrors
- `frontend/src/components/AuthForm.jsx` — sends `expectedRole`, shows the server's refusal, redirects on the server's answer
- `frontend/src/components/RoleChooser.jsx` — the three cards plus the cardless staff link
- `frontend/src/utils/roles.js`, `frontend/src/pages/LoginPage.jsx`, `frontend/src/App.jsx` — the role each URL is scoped to, including `/admin/login`

---

**Flow (exam-level explanation):**

**The problem.** The three cards on the login page — Customer, Rider,
Restaurant owner — used to be decoration. A rider could click "Customer",
type their own password, and land on the rider dashboard anyway, because
the server never asked which card had been clicked. The cards promised a
rule that nothing enforced.

**The rule we must not break.** A user's role is *not* something the
browser is allowed to tell the server. If the server believed a role sent
in a request body, anyone could type `"role":"admin"` into the request and
become an administrator. So the browser is allowed to send only a *claim*,
and the claim can do exactly one thing: cause a rejection.

The field is called `expectedRole` for that reason — "this is what I expect
this account to be." It can never widen what someone may do, and it is
never the value written into the token.

**What happens, step by step, when someone logs in.**

1. The visitor clicks a card, say Rider, and lands on `/login/rider`.
2. They type an email and a password and press Log in.
3. The browser sends three things: the email, the password, and
   `expectedRole: "rider"`.
4. The server checks the shape of the request first. If the email or
   password is missing, it answers **400 Bad Request** — "you sent me
   something malformed." If `expectedRole` is present but is not one of the
   four role words the database accepts, that is also a **400**.
5. The server looks the email up in the `users` table. If there is no such
   row it answers **401 Unauthorized** with the deliberately vague message
   "Invalid email or password." (401 means "I do not know who you are.")
6. If the row exists, the server compares the typed password against the
   stored **bcrypt hash** — bcrypt is a one-way password scrambler, so the
   database holds the scramble and never the password itself. A mismatch is
   the *same* generic 401 as step 5, so a stranger cannot learn whether an
   email is registered.
7. **Only now** does the server read `role` off the row it fetched and
   compare it with `expectedRole`. If they disagree it answers **403
   Forbidden** — "I know who you are, and you may not do this" — with a
   message that names the mismatch: "This account is not registered as a
   rider."
8. If they agree (or no card was clicked at all), the server issues the
   **JWT** — a signed slip of paper the browser hands back on every later
   request — carrying the role it read *from the row*, never the one from
   the request body.

**Why step 7 comes after step 6, and not before.** Suppose the role check
ran first. Then anyone could type someone else's email with a junk
password: a 403 would mean "that email is a rider", a 401 would mean "that
email is not a rider." Without knowing a single password, an attacker could
map out every account on the platform. This is called **user enumeration**.
Verifying the password first means the answer is identical — a flat 401 —
to anyone who does not already know the password. The code carries a
comment saying exactly this, so the ordering is not lost in a later edit.

**Signup is the same idea pointed the other way.** The card decides which
role is *created*, so the role does travel in the signup body — but the
server never inserts that string. It first rejects `admin` outright with a
**403** (admin accounts come from `npm run seed:admin`, never from the
public internet), then looks the value up in a server-side list of the
three self-service roles and inserts *its own copy*. The row can only ever
hold a word this file approved.

**The admin door is scoped too.** Admins have no card, so `/admin/login`
(also reachable as `/login/staff`) renders the same form. It was briefly
wired as an *un-scoped* screen that sent no `expectedRole` — which meant a
customer's own password authenticated there, because the server had nothing
to compare against. It now sends `expectedRole: 'admin'` like every other
screen, so a non-admin is refused with a 403 by the server. The role word it
sends is `admin`, the value stored in `users.role` — not the URL word
`staff`, which the database has never heard of and would reject as a 400.

A login request with no `expectedRole` at all is still accepted, and still
behaves as it always did: look up the row, check the password, issue a token
for whatever role the row holds. That path exists for API clients and curl,
not for any screen in the app.

**The frontend's two jobs.** First, it shows the 403 message verbatim, so
the user reads "This account is not registered as a rider" instead of
watching the form fail silently. Second, it sends the visitor to the
dashboard matching the role the **server returned**, not the card they
clicked. If the two ever disagreed, the server would win. And none of this
is security by itself — hiding a button protects nothing. Every protected
endpoint re-checks the role server-side out of the token on every request.

**Key SQL used by this feature:**

```sql
SELECT * FROM users WHERE email=$1
```

The whole feature rests on this one read. It fetches the account by email
using a **parameter** (`$1`) rather than pasting the typed email into the
query text — that is what makes a typed-in quote mark a harmless character
instead of SQL the database would run. Both the password hash and the
authoritative `role` come out of this row, which is the point: the role
used for the token is read from the database, not from the request.

```sql
INSERT INTO users (name, email, password, role, phone)
VALUES ($1,$2,$3,$4,$5)
RETURNING id, name, email, role
```

Signup's write. `$4` is bound to the copy of the role taken from the
server's own allowlist, never to the raw request body, and the table's
`CHECK (role IN ('customer','restaurant_owner','rider','admin'))`
constraint is a second, database-level refusal of anything unexpected.
`RETURNING` hands back the stored row so the token is built from what was
actually saved.

### The profile page, one route with four faces

**Files involved:**

- `backend/routes/profile.js` — the whole feature's server side: one dispatcher plus four builders
- `backend/routes/account.js` — the shared editable details, and the new change-password endpoint
- `backend/server.js` — mounts `/api/profile`
- `frontend/src/services/profileApi.js` — `GET /api/profile`, `PATCH /api/account/password`
- `frontend/src/pages/AccountPage.jsx` — the single page, served at `/account` and `/profile`
- `frontend/src/components/profile/ProfileIdentity.jsx` — the block every role shares
- `frontend/src/components/profile/CustomerProfile.jsx`, `RiderProfile.jsx`, `OwnerProfile.jsx`, `AdminProfile.jsx`

---

**Flow (exam-level explanation):**

**The idea.** There is one profile page and one profile route. What it draws
depends on *who is looking*: a diner sees addresses and past orders, a rider
sees an availability switch and delivery times, an owner sees their
restaurants and takings, an admin sees platform totals. Four different
pages would have meant four places to forget a permission check.

**Where "who is looking" comes from.** Not from the browser. Every request
carries a **token** — a signed slip of paper handed out at login. The
`authenticateToken` middleware (a piece of code that runs *before* the
handler) checks the signature, then re-reads that user's row from the
database and puts the result on `req.user`. So `req.user.id` and
`req.user.role` are the database's answer. Nothing in `profile.js` ever
reads a user id from the address bar or the request body — which is exactly
why one customer cannot open another customer's profile by typing a
different number. There is no number to type.

**Step by step when someone opens the page.**

1. The page calls `GET /api/profile`, sending no arguments at all.
2. The middleware verifies the token and loads the account row.
3. The handler fetches the shared details (name, email, phone, role,
   join date) by id.
4. It looks its role up in a small table of four builder functions and runs
   the matching one, passing only the token's id.
5. It returns `{ user, role, ...that role's data }`.
6. React reads `profile.role` — the role the *server* sent — and renders
   `CustomerProfile`, `RiderProfile`, `OwnerProfile` or `AdminProfile`. The
   shared details block is rendered once, above whichever face was chosen,
   so no role's file repeats it.

**Why there are also four role-specific endpoints.** `/api/profile/customer`,
`/rider`, `/owner` and `/admin` return the same four payloads, each behind
`requireRole(...)`. A customer calling `/api/profile/admin` gets **403
Forbidden** — "I know who you are, and you may not have this." The page does
not use them; they exist so the enforcement is written down explicitly rather
than merely implied by the dispatch table.

**Changing your password.** `PATCH /api/account/password` takes the current
password and a new one. It re-checks the current password with **bcrypt**
(the one-way scrambler passwords are stored as) before writing, because
someone who walked up to an unlocked laptop should not be able to lock the
real owner out. The account updated is always the token's own.

**Every number on the page is counted by the database.** Not one of them is
produced by fetching rows and counting them in JavaScript. The queries follow.

**Key SQL queries used in this feature:**

```sql
-- Customer: every headline number in one pass over their own orders.
SELECT COUNT(*)::INTEGER AS total_orders,
       COUNT(*) FILTER (WHERE status = 'delivered')::INTEGER AS delivered_orders,
       COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS total_spent,
       COALESCE(AVG(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS average_order_value
FROM orders WHERE customer_id = $1;
```

`FILTER` lets one scan answer several questions at once — count everything,
but only add up the money for orders that were not cancelled. `COALESCE`
turns the `NULL` a sum over zero rows produces into `0`, so a brand-new
account shows "0" rather than a blank.

```sql
-- Customer: the five most recent orders, with where the food came from.
SELECT o.id, o.status, o.total_amount, o.created_at,
       r.name AS restaurant_name, b.area AS branch_area
FROM orders o
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE o.customer_id = $1
ORDER BY o.created_at DESC LIMIT 5;
```

An order records the *branch* it was placed at, not the restaurant, so the
restaurant's name is two steps away: order → branch → restaurant. That is
what the two `JOIN`s walk.

```sql
-- Rider: how many trips, and how long they take on average.
SELECT COUNT(*)::INTEGER AS deliveries_assigned,
       COUNT(*) FILTER (WHERE d.delivery_status = 'delivered')::INTEGER AS deliveries_completed,
       ROUND(EXTRACT(EPOCH FROM AVG(d.delivery_time - o.created_at)
         FILTER (WHERE d.delivery_status = 'delivered' AND d.delivery_time IS NOT NULL)) / 60
       )::INTEGER AS average_delivery_minutes,
       COALESCE(SUM(o.delivery_fee) FILTER (WHERE d.delivery_status = 'delivered'), 0) AS delivery_fees_earned
FROM deliveries d JOIN orders o ON o.id = d.order_id
WHERE d.rider_id = $1;
```

`deliveries` knows when the food arrived; `orders` knows when it was ordered.
Subtracting two timestamps gives an **interval**; `AVG` averages those
intervals; `EXTRACT(EPOCH ...)` converts the average into seconds and `/ 60`
into minutes, because "1847 seconds" is not a thing to print on a page.

```sql
-- Owner: one row per owned restaurant, with its branch and menu counts.
SELECT r.id, r.name, r.cuisine, r.avg_rating, r.review_count,
       COUNT(DISTINCT b.id)::INTEGER AS branch_count,
       COUNT(DISTINCT mi.id)::INTEGER AS menu_item_count
FROM restaurants r
LEFT JOIN restaurant_branches b ON b.restaurant_id = r.id
LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
WHERE r.owner_id = $1
GROUP BY r.id, r.name, r.cuisine, r.avg_rating, r.review_count
ORDER BY r.name;
```

Joining two independent lists to one restaurant multiplies the rows: 10
branches and 55 menu items make 550 combinations. `COUNT(DISTINCT ...)`
counts each branch and each item once regardless. `LEFT JOIN` keeps a
restaurant with no menu yet visible, showing zero instead of vanishing.

```sql
-- Owner: orders and revenue, reached only through the ownership chain.
SELECT COUNT(o.id)::INTEGER AS orders_received,
       COUNT(o.id) FILTER (WHERE o.status = 'delivered')::INTEGER AS orders_delivered,
       COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'delivered'), 0) AS revenue
FROM orders o
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE r.owner_id = $1;
```

This is the ownership rule written as SQL. The filter is on `owner_id` —
the logged-in user — and the joins are how an order is proved to belong to
them. No restaurant id from the browser takes part, so there is nothing to
tamper with. It is a separate query from the one above on purpose: adding
orders as a third branch of that join would have multiplied the rows again
and inflated the revenue.

```sql
-- Owner: one rating across every restaurant they run.
SELECT ROUND(SUM(r.avg_rating * r.review_count) / NULLIF(SUM(r.review_count), 0), 2) AS average_rating,
       COALESCE(SUM(r.review_count), 0)::INTEGER AS review_count
FROM restaurants r WHERE r.owner_id = $1;
```

Averaging the averages would let a restaurant with 2 reviews count as much
as one with 200, so each average is multiplied by its own review count
before dividing by the total — a weighted average. `NULLIF(x, 0)` turns a
zero divisor into `NULL`, which reads as "no rating yet" instead of crashing
with a division by zero.

```sql
-- Admin: how many accounts of each kind.
SELECT role, COUNT(*)::INTEGER AS count FROM users GROUP BY role ORDER BY role;
```

`GROUP BY role` collapses the whole users table into one row per role with
its count — four rows out of however many thousand, and the counting happens
in the database rather than by shipping every user to the browser.

```sql
-- Admin: the platform headline figures, in one trip.
SELECT (SELECT COUNT(*) FROM users)::INTEGER AS user_count,
       (SELECT COUNT(*) FROM restaurants)::INTEGER AS restaurant_count,
       (SELECT COUNT(*) FROM restaurant_branches)::INTEGER AS branch_count,
       (SELECT COUNT(*) FROM orders)::INTEGER AS order_count,
       (SELECT COUNT(*) FROM orders WHERE status = 'delivered')::INTEGER AS delivered_order_count,
       (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'delivered') AS delivered_revenue;
```

Each bracketed `SELECT` is its own aggregate returned as one column. They
are bundled into a single statement so the page makes one round trip to the
database instead of six.

### Restaurant owner analytics dashboard

**Files involved:**

- `backend/routes/owner.js` — the five queries, the date-range validation and the ownership gate
- `backend/server.js` — mounts `/api/owner`
- `frontend/src/services/ownerApi.js` — `getAnalytics(restaurantId, { from, to })`
- `frontend/src/components/OwnerAnalytics.jsx` — the tables and the date controls
- `frontend/src/pages/OwnerAnalyticsPage.jsx` — the standalone page at `/owner/analytics`
- `frontend/src/pages/OwnerDashboardPage.jsx` — the same component as an "Analytics" tab
- `frontend/src/components/Navbar.jsx`, `frontend/src/App.jsx` — the owner's link and route

---

**Flow (exam-level explanation):**

**What it is.** A page that answers five questions an owner actually asks:
what did we take each day, what sells, how are we doing overall, when are we
busy, and where did the orders end up. Every one of those numbers is
calculated by PostgreSQL. Node runs the query and hands the rows to the
browser; it never adds anything up itself.

**The ownership problem, and how it is solved twice.**

The restaurant's id is in the web address: `/api/owner/analytics/7`. Anyone
can type a different number. So the id in the URL is treated as a *request*,
not as permission.

1. `authenticateToken` runs first. No token → **401 Unauthorized**.
2. `requireRole('restaurant_owner')` runs next. A customer or rider with a
   perfectly valid token → **403 Forbidden**.
3. `requireOwnedRestaurant` then loads the restaurant by that id. No such
   restaurant → **404 Not Found**. Restaurant exists but its `owner_id` is
   not the id inside the token → **403 Forbidden**.
4. And then *every one of the five queries independently repeats the
   ownership test in its own `WHERE` clause* — `r.id = $1 AND r.owner_id = $2`
   — so even if step 3 were deleted by accident, the queries would return
   nothing rather than another owner's takings.

The id compared against is `req.user.id`, which `authenticateToken` read
from the database after checking the token's signature. It cannot be sent,
edited or guessed by the caller.

**The join that enforces it.** An order does not store a restaurant. It
stores the *branch* it was placed at. So proving an order belongs to this
owner takes two hops:

```sql
FROM orders o
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE r.id = $1 AND r.owner_id = $2
```

Read it as a sentence: "take the orders, find each one's branch, find that
branch's restaurant, and keep only the rows where that restaurant is the one
being asked about *and* is owned by the person asking." Every query in the
file starts from that chain.

**Dates.** `?from=&to=` are optional and default to the last 30 days. They
are checked before use: the shape must be `YYYY-MM-DD`, the date must be a
real day (`2026-02-31` is rejected — JavaScript would otherwise silently
roll it into March), the start must not be after the end, and the window is
capped at a year. Anything else is **400 Bad Request**. They are then passed
as **parameters** (`$3`, `$4`), never pasted into the query text, so a date
box containing SQL is just an invalid date.

**How the page is laid out.** Top to bottom, the way a dashboard is read:
the five headline figures with their period-over-period deltas, then the
revenue trend, then top items, then busiest hours, then the status
breakdown. Above them sit four range buttons — Today, 7 days, 30 days,
Custom — which only set the `from`/`to` the endpoints already accept.
Each row of the status breakdown is a button: clicking "cancelled" opens the
owner's order list already filtered to cancelled orders, so the number and
the orders behind it are one click apart.

**Endpoints.** `GET /api/owner/analytics/:restaurantId` returns all five
reports in one response — that is what the page calls. Each report also has
its own address (`/revenue`, `/top-items`, `/headline`, `/busiest-hours`,
`/status-breakdown`) behind the identical checks.

**The empty state.** A restaurant that has never been ordered from returns
zeros, not blanks: the aggregate queries still produce one row, `COALESCE`
turns the empty sums into `0`, and the page says so in words instead of
printing `NaN`.

**The five queries:**

```sql
-- 1. Revenue over time: one row per day, including days that sold nothing.
WITH owned_orders AS (
  SELECT o.id, o.total_amount, o.created_at
  FROM orders o
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1 AND r.owner_id = $2
    AND o.status <> 'cancelled'
    AND o.created_at >= $3::date AND o.created_at < ($4::date + INTERVAL '1 day')
)
SELECT to_char(series.day, 'YYYY-MM-DD') AS day,
       COUNT(oo.id)::INTEGER AS order_count,
       COALESCE(SUM(oo.total_amount), 0) AS revenue
FROM generate_series($3::date, $4::date, INTERVAL '1 day') AS series(day)
LEFT JOIN owned_orders oo
  ON oo.created_at >= series.day AND oo.created_at < series.day + INTERVAL '1 day'
GROUP BY series.day ORDER BY series.day;
```

`WITH ... AS` names a temporary result — here, "this owner's orders in this
window". `generate_series` manufactures the calendar, one row per day, and
the orders are `LEFT JOIN`ed onto it so a day that sold nothing still appears
with a zero instead of vanishing from the chart. Cancelled orders are
excluded because they were never money.

```sql
-- 2. Top selling items: five bestsellers by quantity.
SELECT mi.id, mi.name,
       SUM(oi.quantity)::INTEGER AS quantity_sold,
       SUM(oi.quantity * oi.unit_price) AS revenue,
       COUNT(DISTINCT o.id)::INTEGER AS order_count
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN menu_items mi ON mi.id = oi.menu_item_id
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE r.id = $1 AND r.owner_id = $2 AND o.status <> 'cancelled'
  AND o.created_at >= $3::date AND o.created_at < ($4::date + INTERVAL '1 day')
GROUP BY mi.id, mi.name
ORDER BY quantity_sold DESC, revenue DESC
LIMIT 5;
```

Five tables at once: an order line (`order_items`) knows its dish and its
order, the order knows its branch, the branch knows the restaurant, and the
restaurant knows its owner. `GROUP BY` the dish and `SUM` the quantities, so
one dish bought three at a time across four orders counts as twelve. Revenue
uses `oi.unit_price` — the price *recorded on the line at the time* — so
raising a menu price today does not rewrite last month's takings.

```sql
-- 3. Headline stats: current period AND the one before it, in one row.
WITH bounds AS (
  SELECT $3::date AS current_from,
         $4::date AS current_to,
         ($4::date - $3::date + 1) AS period_days,
         ($3::date - ($4::date - $3::date + 1)) AS previous_from,
         ($3::date - 1) AS previous_to
),
totals AS (
  SELECT
    COUNT(o.id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER AS current_orders,
    COUNT(o.id) FILTER (WHERE o.created_at >= bounds.current_from AND o.status = 'cancelled')::INTEGER
      AS current_cancelled_orders,
    COALESCE(SUM(o.total_amount) FILTER (
      WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled'), 0) AS current_revenue,
    AVG(o.total_amount) FILTER (
      WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled') AS current_average_order_value,
    COUNT(DISTINCT o.customer_id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER
      AS current_customers_served,
    COUNT(o.id) FILTER (WHERE o.created_at < bounds.current_from)::INTEGER AS previous_orders,
    COALESCE(SUM(o.total_amount) FILTER (
      WHERE o.created_at < bounds.current_from AND o.status <> 'cancelled'), 0) AS previous_revenue,
    AVG(o.total_amount) FILTER (
      WHERE o.created_at < bounds.current_from AND o.status <> 'cancelled') AS previous_average_order_value,
    COUNT(DISTINCT o.customer_id) FILTER (WHERE o.created_at < bounds.current_from)::INTEGER
      AS previous_customers_served
  FROM bounds
  LEFT JOIN orders o
    ON o.created_at >= bounds.previous_from
   AND o.created_at < (bounds.current_to + INTERVAL '1 day')
   AND o.branch_id IN (
     SELECT b.id FROM restaurant_branches b
     JOIN restaurants r ON r.id = b.restaurant_id
     WHERE r.id = $1 AND r.owner_id = $2
   )
  GROUP BY bounds.current_from
)
SELECT totals.*,
       bounds.period_days::INTEGER AS period_days,
       to_char(bounds.previous_from, 'YYYY-MM-DD') AS previous_from,
       to_char(bounds.previous_to, 'YYYY-MM-DD') AS previous_to,
       ROUND((totals.current_revenue - totals.previous_revenue)
             / NULLIF(totals.previous_revenue, 0) * 100, 1) AS revenue_change_pct,
       ROUND((totals.current_orders - totals.previous_orders)::NUMERIC
             / NULLIF(totals.previous_orders, 0) * 100, 1) AS orders_change_pct,
       ROUND((COALESCE(totals.current_average_order_value, 0) - COALESCE(totals.previous_average_order_value, 0))
             / NULLIF(totals.previous_average_order_value, 0) * 100, 1) AS average_order_value_change_pct,
       (SELECT ROUND(AVG(rev.rating), 2)
        FROM restaurant_reviews rev
        JOIN orders o2 ON o2.id = rev.order_id
        JOIN restaurant_branches b2 ON b2.id = o2.branch_id
        WHERE b2.restaurant_id = $1) AS average_rating
FROM totals, bounds;
```

Read it in three parts.

**`bounds`** works out the two windows. A **CTE** — the `WITH name AS (...)`
form — is just a named temporary result you can refer to further down. The
current window is what the owner asked for. The previous one is the same
*length*, ending the day before: subtracting two dates in Postgres gives a
number of days, so `$4 - $3 + 1` is the period's length, and going that far
back from the start lands exactly one period earlier. Ask for 1–30
September and you are compared against 2–31 August, without the browser
calculating a thing.

**`totals`** does the counting. This is the part worth understanding: the
`LEFT JOIN` fetches the *whole* span — previous start through current end —
in one pass, and then each aggregate's `FILTER` decides which half it wants.
`FILTER (WHERE o.created_at >= bounds.current_from)` is this period;
`FILTER (WHERE o.created_at < bounds.current_from)` is the one before. Two
windows, one scan, one row returned — rather than two round trips and a
subtraction in JavaScript.

The ownership proof sits in the join condition as `branch_id IN (...)`: only
branches belonging to restaurant `$1` *owned by* `$2` qualify. It is written
as a sub-select rather than another join so that the `LEFT JOIN` still
produces its single row of zeros when a restaurant has no orders at all —
which is what stops a brand-new restaurant rendering as a blank page.

**The final `SELECT`** turns the six totals into three percentages, also in
SQL. `NULLIF(previous, 0)` makes the divisor `NULL` when the previous period
was empty, and anything divided by `NULL` is `NULL` — so instead of dividing
by zero or claiming an infinite rise, the page simply says "no comparison".
`COUNT(DISTINCT o.customer_id)` is "how many different people", so one
regular who ordered twenty times counts once. The rating is a bracketed
sub-select because a review hangs off an *order*, not a restaurant, so it is
reached by its own chain: review → order → branch → restaurant, and it is a
lifetime figure that ignores the date range.

```sql
-- 4. Busiest hours: which hour of the day sells most.
SELECT EXTRACT(HOUR FROM o.created_at)::INTEGER AS hour,
       COUNT(o.id)::INTEGER AS order_count,
       COALESCE(SUM(o.total_amount), 0) AS revenue
FROM orders o
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE r.id = $1 AND r.owner_id = $2 AND o.status <> 'cancelled'
  AND o.created_at >= $3::date AND o.created_at < ($4::date + INTERVAL '1 day')
GROUP BY hour ORDER BY hour;
```

`EXTRACT(HOUR FROM ...)` pulls just the hour number (0–23) out of a
timestamp, throwing the date away. `GROUP BY` then collapses every order
ever placed in that hour, on any day, into a single row — so "we are busiest
at 8pm" is one query rather than a scan of every order in the browser.

```sql
-- 5. Order status breakdown.
SELECT o.status, COUNT(o.id)::INTEGER AS order_count,
       COALESCE(SUM(o.total_amount), 0) AS order_value
FROM orders o
JOIN restaurant_branches b ON b.id = o.branch_id
JOIN restaurants r ON r.id = b.restaurant_id
WHERE r.id = $1 AND r.owner_id = $2
  AND o.created_at >= $3::date AND o.created_at < ($4::date + INTERVAL '1 day')
GROUP BY o.status ORDER BY order_count DESC;
```

One row per status with its count and value. This is the one report that
deliberately *keeps* cancelled orders, because "how many did we lose" is
exactly what the breakdown is for.

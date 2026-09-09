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

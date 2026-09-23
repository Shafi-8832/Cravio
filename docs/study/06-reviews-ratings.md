# 06 — Reviews & ratings

## Files involved

**Frontend**
- `frontend/src/components/OrderReceipt.jsx` — where a customer leaves a review, from inside a delivered order's receipt.
- `frontend/src/pages/RestaurantPage.jsx:104-109` — the public review list, with the owner's reply shown beneath each one.
- `frontend/src/pages/OwnerReviewsPage.jsx` — the owner's review inbox: distribution, filters, reply box.
- `frontend/src/components/StarRating.jsx` — the star display used on cards and headers.
- `frontend/src/services/restaurantApi.js:5` — `getRestaurantReviews`.
- `frontend/src/services/ownerApi.js` — `getOwnerReviews`, `getOwnerReviewSummary`, `replyToReview`, `deleteReviewReply`.

**Route**
- `backend/routes/reviews.js` — `POST /api/reviews/orders/:orderId` (`:25`) and the public `GET /api/reviews/restaurants/:restaurantId` (`:222`).
- `backend/routes/owner.js:402-660` — the owner's four review routes.

**Controller**
- None. Both files query `pool` / a pooled `client` directly.

**Middleware**
- `authenticateToken` + `requireRole('customer')` on the write (`reviews.js:27-28`); the public read has **no middleware at all**.
- `owner.js:12` — `router.use(authenticateToken, requireRole('restaurant_owner'))` covers the reply routes.

**SQL**
- `backend/db/schema.sql:596-643` — `restaurant_reviews`. `order_id` is UNIQUE, which is what makes "one review per order" a database guarantee rather than a hope.
- `backend/db/migrations/006_review_replies.sql` — adds `owner_reply`, `owner_replied_at`, and the 1000-character CHECK.
- `backend/db/functions/restaurant_rating.sql` — the function, the trigger function and the trigger.
- `backend/db/schema.sql:644-664` — `quality_flag_log`.

---

## Flow

### A customer leaves a review

1. The customer opens a delivered order's receipt. The review form only appears for an order the server marked `review_eligible`.
2. `POST /api/reviews/orders/:orderId` with `{ rating, portion_accuracy?, comment? }`.
3. `reviews.js:27-28` — logged in, and a customer. Anything else → 401/403.
4. `reviews.js:30-64` validates: the order id parses, `rating` is an integer 1-5, `portion_accuracy` (if sent) is one of three words, comment ≤ 1000 characters. Any failure → **400**.
5. `reviews.js:66` takes a connection; `:69` opens the transaction.
6. `reviews.js:73-84` loads the order **`FOR UPDATE`** — a row lock. Two submissions racing on the same order now queue behind each other instead of both passing the "already reviewed" check.
7. Not found → **404** (`:90`). **Ownership:** `order.customer_id !== req.user.id` → **403** (`:97-103`) — you may only review your own order.
8. `:105-112` — the order must be `delivered` and `review_eligible`, else **409**. That flag is set by the delivery procedure, so it doubles as proof the food actually arrived.
9. `:114-126` — already reviewed → **409**.
10. `:128-137` inserts the review.
11. **The trigger fires here, inside the same transaction** (see The SQL). `restaurants.avg_rating` and `review_count` are recomputed before the COMMIT, so the stored summary can never be observed disagreeing with the reviews.
12. `:147-187` — if the customer reported `way_less` portion, every item on the order gets a row in `quality_flag_log`, and any item reported across 3+ distinct orders gets `quality_flag = true`.
13. `:189` COMMIT → **201** with the review and any newly flagged items.

### Anyone reads a restaurant's reviews

1. `GET /api/reviews/restaurants/:restaurantId` — **no authentication**; this is public browsing.
2. `reviews.js:238-242` reads `avg_rating` and `review_count` straight off the `restaurants` row. **It does not recompute them** — that is the whole point of the trigger. Missing restaurant → **404**.
3. `reviews.js:250-276` lists the reviews with the reviewer's name and the owner's reply. → **200**.

### An owner replies

1. `GET /api/owner/reviews` (`owner.js:402`) lists only this owner's reviews, with filters; `GET /api/owner/reviews/summary` (`:510`) gives the star distribution.
2. `PUT /api/owner/reviews/:id/reply` (`:554`) — `BEGIN` at `:568`, then a single UPDATE whose `WHERE` clause **contains** the ownership test (`:581-590`). No match → ROLLBACK → **404**. COMMIT → **200**.
3. `DELETE /api/owner/reviews/:id/reply` (`:620`) — same shape, sets both columns back to NULL, → **204**.
4. **The owner can never touch the review itself.** No route in the project updates `rating`, `comment` or `portion_accuracy`, and none deletes a review row.

---

## The SQL

**1. Lock and load the order** — `reviews.js:74-84`
```sql
SELECT
  id,
  customer_id,
  status,
  review_eligible
FROM orders
WHERE id = $1
FOR UPDATE
```
Returns the order's owner and whether it is reviewable. `$1` = the order id from the URL. `FOR UPDATE` holds the row until the transaction ends, so a second submission for the same order waits rather than racing past the duplicate check.

**2. Duplicate guard** — `reviews.js:115`
```sql
SELECT id FROM restaurant_reviews WHERE order_id = $1
```
Returns a row only if this order was already reviewed. `$1` = order id. Belt to the `UNIQUE` constraint's braces — the constraint is the real guarantee, this gives the clean 409.

**3. Insert the review** — `reviews.js:129-135`
```sql
INSERT INTO restaurant_reviews
  (order_id, rating, portion_accuracy, comment)
VALUES
  ($1, $2, $3, $4)
RETURNING id, order_id, rating, portion_accuracy, comment, created_at
```
`$1` order id, `$2` the validated integer rating, `$3` portion accuracy or NULL, `$4` the trimmed comment or NULL. **This statement is what fires the rating trigger.**

**4. The rating calculation (FUNCTION)** — `db/functions/restaurant_rating.sql:58-63`
```sql
SELECT ROUND(AVG(rev.rating), 2)
FROM restaurant_reviews rev
JOIN orders o
    ON o.id = rev.order_id
JOIN restaurant_branches b
    ON b.id = o.branch_id
WHERE b.restaurant_id = p_restaurant_id;
```
Declared `LANGUAGE sql STABLE` at `:50`. **The two joins exist because a review has no `restaurant_id`** — it belongs to an order, the order was placed at a branch, the branch belongs to a restaurant. That three-table walk is the only path between a review and a restaurant, and it recurs all over this codebase. Returns NULL (not 0) for a restaurant with no reviews.

**5. The maintained summary (inside the TRIGGER function)** — `restaurant_rating.sql:152-170`
```sql
UPDATE restaurants
SET
    avg_rating   = restaurant_avg_rating(v_restaurant_id),
    review_count = (
        SELECT COUNT(*)
        FROM restaurant_reviews rev
        JOIN orders o
            ON o.id = rev.order_id
        JOIN restaurant_branches b
            ON b.id = o.branch_id
        WHERE b.restaurant_id = v_restaurant_id
    )
WHERE id = v_restaurant_id;
```
Recomputes both stored columns from scratch. It is preceded by `PERFORM id FROM restaurants WHERE id = ANY(v_restaurant_ids) ORDER BY id FOR UPDATE` (`:147`) — locking the restaurant rows in id order so two concurrent reviews cannot interleave their recomputes or deadlock.

**6. The trigger itself** — `restaurant_rating.sql:209-215`
```sql
DROP TRIGGER IF EXISTS trg_sync_restaurant_rating ON restaurant_reviews;

CREATE TRIGGER trg_sync_restaurant_rating
    AFTER INSERT OR UPDATE OF rating, order_id OR DELETE
    ON restaurant_reviews
    FOR EACH ROW
    EXECUTE FUNCTION sync_restaurant_rating();
```
`AFTER` so only committed changes move the average. `UPDATE OF rating, order_id` — **not a bare UPDATE** — so an owner writing a reply (which updates the same row) does not trigger a pointless recompute. `order_id` is in the list because re-pointing a review at a different order moves it between restaurants, and both then need recomputing.

**7. Quality-flag log** — `reviews.js:149-158`
```sql
INSERT INTO quality_flag_log
  (menu_item_id, order_id)
SELECT
  oi.menu_item_id,
  oi.order_id
FROM order_items oi
WHERE oi.order_id = $1
  AND oi.menu_item_id IS NOT NULL
```
INSERT … SELECT: one statement records a complaint against every item on that order. `$1` = order id.

**8. Promote to a menu-level flag** — `reviews.js:165-182`
```sql
UPDATE menu_items
SET quality_flag = true
WHERE id IN (
  SELECT qfl.menu_item_id
  FROM quality_flag_log qfl
  WHERE qfl.menu_item_id IN (
    SELECT menu_item_id
    FROM order_items
    WHERE order_id = $1
      AND menu_item_id IS NOT NULL
  )
  GROUP BY qfl.menu_item_id
  HAVING COUNT(DISTINCT qfl.order_id) >= $2
)
AND quality_flag = false
RETURNING id, name
```
`$1` order id, `$2` the threshold constant `3` (`reviews.js:15`). **`COUNT(DISTINCT qfl.order_id)` is the important bit** — a pattern across *separate orders*, not one angry customer complaining repeatedly. `AND quality_flag = false` makes it idempotent, and `RETURNING` tells the customer which items their report just flagged.

**9. Public summary read** — `reviews.js:240`
```sql
SELECT id, avg_rating, review_count FROM restaurants WHERE id = $1
```
Doubles as the existence check and the rating summary. `$1` = restaurant id. It reads the stored columns instead of re-walking the three-table path — that is the payoff for maintaining them with a trigger.

**10. Public review list** — `reviews.js:252-273`
```sql
SELECT
  rev.id,
  rev.order_id,
  rev.rating,
  rev.portion_accuracy,
  rev.comment,
  rev.created_at,
  rev.owner_reply,
  rev.owner_replied_at,
  u.name AS customer_name
FROM restaurant_reviews rev
JOIN orders o
  ON o.id = rev.order_id
JOIN restaurant_branches rb
  ON rb.id = o.branch_id
JOIN users u
  ON u.id = o.customer_id
WHERE rb.restaurant_id = $1
ORDER BY rev.created_at DESC
```
The same review → order → branch climb, plus a fourth join to `users` for the reviewer's name. `$1` = restaurant id. The reply travels with the review it answers so the page can render the pair without a second query.

**11. Owner reply, ownership inside the write** — `owner.js:581-590`
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
`$1` reply text, `$2` review id from the URL, `$3` the owner id **from the token**. The tables in `FROM` are the same climb, run backwards, used as the authorization test. No match → zero rows → 404. `DELETE …/reply` (`owner.js:634-645`) is identical but sets both columns to NULL.

**12. Star distribution** — `owner.js:517-530`
```sql
SELECT
  stars.rating::INTEGER AS rating,
  COUNT(rev.id)::INTEGER AS review_count,
  ROUND(100.0 * COUNT(rev.id) / NULLIF(SUM(COUNT(rev.id)) OVER (), 0), 1) AS share_pct
FROM generate_series(1, 5) AS stars(rating)
LEFT JOIN (
  SELECT rev.id, rev.rating
  FROM restaurant_reviews rev
  JOIN orders o ON o.id = rev.order_id
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.owner_id = $1
) rev ON rev.rating = stars.rating
GROUP BY stars.rating
ORDER BY stars.rating DESC
```
`$1` = owner id from the token. `generate_series` supplies the five star levels so a rating nobody has given still returns 0 rather than vanishing; `SUM(COUNT(*)) OVER ()` is the grand total, giving each star's share without a second query.

---

## Transactions

**Creating a review — YES, and it is the best example in the project.** `reviews.js:66` connect, `:69` `BEGIN`, `:189` `COMMIT`, `ROLLBACK` at `:88`, `:98`, `:106`, `:120` and `:198`, `client.release()` at `:207`.

Inside it: the `FOR UPDATE` order lock, the duplicate check, the review INSERT, **the trigger's recompute of `restaurants`**, the `quality_flag_log` INSERT and the `menu_items` UPDATE. Five tables, one atomic unit. If the flag pipeline failed, the review would roll back too — and, crucially, so would the rating recompute, because the trigger runs inside the caller's transaction.

**Owner reply / delete reply — YES.** `owner.js:568` and `:628`, both with ROLLBACK on the 404 path and in the catch.

**Public read — NO**, correctly; it writes nothing.

---

## Status codes

| Code | Trigger |
|---|---|
| **200** | Public review list (`reviews.js:278`); owner reply published (`owner.js:605`). |
| **201** | Review created (`reviews.js:191`). |
| **204** | Owner reply removed (`owner.js:655`). |
| **400** | Bad order id (`reviews.js:34`), rating not an integer 1-5 (`:42`), unknown `portion_accuracy` (`:52`), comment over 1000 chars (`:61`), bad restaurant id (`:228`); owner side: bad review id, empty or over-long reply, bad filter/sort values (`owner.js:406-431`, `:559-562`). |
| **401 / 403** | Not logged in / not a customer on the write; not an owner on the reply routes. **403** also for reviewing an order that is not yours (`reviews.js:100`). |
| **404** | Order not found (`reviews.js:90`); restaurant not found (`:245`); review not yours or nonexistent (`owner.js:600`, `:650`). |
| **409** | Order not delivered or not review-eligible (`reviews.js:108`, code `NOT_REVIEW_ELIGIBLE`); already reviewed (`:122`, code `ALREADY_REVIEWED`). |
| **500** | Unexpected failure (`reviews.js:202`, `:289`). |

---

## Graded requirements touched

| Requirement | How |
|---|---|
| **TRIGGER** | `trg_sync_restaurant_rating` (`restaurant_rating.sql:211-215`). Real use case: a derived summary read on nearly every page and written rarely. The application **never** writes `avg_rating`. |
| **FUNCTION** | `restaurant_avg_rating(p_restaurant_id)` (`:50-68`) — returns a computed statistical value, exactly the rubric's example. Exists as a function so the trigger and the backfill (`:234`) cannot disagree. |
| **Explicit transaction** | `reviews.js:69/189`, and the two owner reply routes. |
| **Object-level ownership** | Customer side: `reviews.js:97`. Owner side: inside the UPDATE, `owner.js:586-590`. |
| **Complex query** | The three-table review→order→branch climb appears in five queries here; the distribution query adds `generate_series`, a `LEFT JOIN` and a window function; the quality-flag promotion uses `GROUP BY … HAVING COUNT(DISTINCT …)`. |
| **Role authorization** | `requireRole('customer')` on the write, `requireRole('restaurant_owner')` on replies, none on the public read. |
| PROCEDURE | Not here — `complete_delivery` belongs to unit 05, though it is what sets `review_eligible`. |

---

## Likely viva questions

**1. Why store `avg_rating` on the restaurant at all instead of computing it when asked?**
Because it is read on nearly every page — the browse grid, the restaurant header, the owner dashboard — and written only when a delivered order is reviewed. Recomputing a three-table join on every card of every listing would be wasteful. Storing it is only safe because the application never maintains it: `trg_sync_restaurant_rating` recomputes it inside the same transaction as the review change, so it cannot drift.

**2. Why does the trigger recompute from scratch instead of adjusting the average incrementally? (design justification)**
Incremental arithmetic — "new_avg = (old_avg × n + rating) / (n+1)" — is faster but unforgiving. One bad backfill, one manual `UPDATE` in psql, and the number drifts with nothing to pull it back. A full recompute is self-healing: every fire re-derives the truth from the review rows themselves. Reviews are written rarely, so the cost is irrelevant. The file says exactly this at `restaurant_rating.sql:99-104`.

**3. Why `AFTER INSERT OR UPDATE OF rating, order_id OR DELETE` rather than a plain `UPDATE`?**
`UPDATE OF <columns>` fires only when one of those columns is in the SET list. When we added owner replies, replying became an UPDATE of the same row — with a bare `UPDATE` trigger, every reply would recompute an average that cannot have changed. `rating` is obvious; `order_id` is there because re-pointing a review at a different order moves it to another restaurant, and the trigger function handles that two-restaurant case (`:118-145`).

**4. What stops two people reviewing the same order at the same time, or one person reviewing twice?**
Three layers. The `FOR UPDATE` lock at `reviews.js:82` serialises concurrent attempts on that order. The duplicate `SELECT` at `:115` gives a clean 409. And the `UNIQUE` constraint on `restaurant_reviews.order_id` is the actual guarantee — if both checks were somehow bypassed, the database still refuses.

**5. A customer reports `way_less` portion. Walk me through what happens, and why the threshold is 3.**
`reviews.js:147` sees the value and inserts one `quality_flag_log` row per item on that order (`:149-158`). Then `:165-182` flags any item whose reports reach the threshold — but the count is `COUNT(DISTINCT qfl.order_id)`, so it is three *separate orders*, not three complaints from one person. One angry customer is not evidence of a systematic problem; a pattern across separate orders is. Every report is still logged regardless; the threshold only governs the visible flag on the menu item.

---

## Gaps and defects

**DML with no transaction**
- None in this slice. Both writes (`reviews.js:69`, `owner.js:568`/`:628`) are wrapped, and the public read writes nothing.

**Ownership bypassable via an id in the URL or body**
- None found. The write checks `order.customer_id` against the token (`reviews.js:97`); the reply routes put the ownership test inside the UPDATE (`owner.js:586-590`) and return 404 rather than 403 so review ids cannot be enumerated.
- Worth naming: `GET /api/reviews/restaurants/:restaurantId` is **fully public and returns `customer_name` in full** (`reviews.js:264`). That is a deliberate product choice — reviews are public — but note the inconsistency below.

**SQL built by string concatenation**
- None. The only interpolations in `reviews.js` are the `portion_accuracy` error message (`:53`) and `menu_items` messages; the owner file's `${OWNED_REVIEWS_FROM}` and `${REVIEW_SORTS[sort]}` are a fixed constant and an allowlisted value.

**Other defects**

1. **The public list leaks full names while the owner list deliberately does not.** `reviews.js:264` selects `u.name AS customer_name` unredacted, whereas `owner.js:464` goes out of its way to return `split_part(u.name, ' ', 1)` — first name only. Both views show the same review. The owner's caution is therefore undone by the public page, which anyone including that owner can read.
2. **No route lets a customer edit or delete their own review.** Probably deliberate, but it means a review posted by mistake is permanent, and the rubric's CRUD expectations are only partly met for this entity.
3. **`portion_accuracy` is recorded but never surfaced to the owner.** `owner.js:452` selects it, but neither the owner page nor the public page renders it, so the signal the quality pipeline is built on is invisible to the person who could act on it.
4. **`quality_flag_log` has no unique constraint on `(menu_item_id, order_id)`.** If a review could ever be written twice for one order the log would double-count — the review `UNIQUE` makes that unreachable today, so this is a latent dependency rather than a live bug.
5. **The 1000-character comment limit is enforced in JavaScript only** (`reviews.js:60`). The owner's *reply* got a database `CHECK` in migration 006, but the customer's comment never did — the two halves of the same table are guarded to different standards.
6. **The public endpoint has no pagination.** `reviews.js:252-273` returns every review a restaurant has ever received, unbounded, to an unauthenticated caller.

---

## Explain-it-in-60-seconds

Reviews hang off orders, not restaurants — so everywhere we touch a review we walk review → order → branch → restaurant. That's the join you'll see five times in this slice.

A customer posts a review from a delivered order. The whole thing is one transaction: we lock the order row with FOR UPDATE so two submissions can't race, check it's actually theirs and actually delivered, check it hasn't been reviewed, then insert. The moment that insert lands, a trigger fires inside the same transaction and recomputes the restaurant's `avg_rating` and `review_count` from scratch. That's why the stored rating can never be seen disagreeing with the reviews — it's updated atomically with them, and the application never writes those columns itself. The trigger is deliberately narrowed to `UPDATE OF rating, order_id`, because owner replies update the same row and recomputing an average for a reply would be pointless work.

If the customer reports a short portion, we log one row per item on that order, and flag an item on the menu once three *distinct orders* have complained — distinct orders, not three complaints, so one angry customer can't flag a dish.

The owner can reply but can never touch the review. The reply UPDATE joins all the way up to `restaurants.owner_id` and requires it to match the token, so a review that isn't theirs matches zero rows and they get a 404 — not a 403, because a 403 would confirm the review exists and let them enumerate ids. The one thing I'd flag: the public review list returns the customer's full name, even though the owner's own view carefully shows first names only.

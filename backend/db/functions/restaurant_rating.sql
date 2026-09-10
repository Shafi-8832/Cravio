-- ============================================================
-- CRAVIO RESTAURANT RATING — function + trigger + backfill
--
-- Run this file after db/schema.sql (a fresh database), or after
-- db/migrations/002_restaurant_ratings.sql (an existing one). Either way
-- it needs restaurants.avg_rating and restaurants.review_count to exist
-- already.
--
-- Safe to re-run: everything here is CREATE OR REPLACE / DROP IF EXISTS,
-- and the backfill at the bottom recomputes from the reviews themselves
-- rather than adjusting whatever is currently stored.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Supporting index.
--
-- The recompute below looks reviews up the opposite way round from the
-- read endpoints: it starts from a known restaurant and walks DOWN to its
-- reviews. That entry point is restaurant_branches.restaurant_id, which
-- has no index of its own.
--
-- The rest of the path is already covered: orders(branch_id, ...) from
-- place_order.sql, and restaurant_reviews.order_id gets an implicit index
-- from its UNIQUE constraint.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_restaurant_branches_restaurant
    ON restaurant_branches(restaurant_id);



-- ------------------------------------------------------------
-- 1. The reusable "what is this restaurant worth" calculation.
--
-- This exists as a function rather than being inlined into the trigger
-- because the same number is needed in two places that must never
-- disagree: the trigger that maintains the stored column, and the
-- one-off backfill at the bottom of this file. Two hand-written copies of
-- an average are two chances to write it differently.
--
-- It is STABLE, not VOLATILE: it only reads, and it returns the same
-- answer for the same argument within a single statement, which lets the
-- planner call it once instead of once per row.
--
-- Returns NULL, not 0, when a restaurant has no reviews — see the note on
-- the column in migration 002.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION restaurant_avg_rating(p_restaurant_id INTEGER)
RETURNS NUMERIC
AS $$

    -- Reviews carry no restaurant_id of their own, so this walks the only
    -- path that connects them: a review belongs to an order, an order was
    -- placed at a branch, and a branch belongs to a restaurant. Rounded to
    -- 2 decimals to match the NUMERIC(3,2) column it feeds.
    SELECT ROUND(AVG(rev.rating), 2)
    FROM restaurant_reviews rev
    JOIN orders o
        ON o.id = rev.order_id
    JOIN restaurant_branches b
        ON b.id = o.branch_id
    WHERE b.restaurant_id = p_restaurant_id;

$$ LANGUAGE sql STABLE;



-- ------------------------------------------------------------
-- 2. The trigger function — the thing that makes storing a derived value
--    safe.
--
-- Without it, restaurants.avg_rating would be a number somebody has to
-- remember to update, and every code path that forgets leaves a
-- permanently wrong rating on a real restaurant. With it, the recompute
-- is not the application's job at all: the database performs it inside
-- the same transaction as the review change, so the column cannot be
-- observed disagreeing with the reviews it summarises.
--
-- It recomputes from scratch instead of adjusting the stored average by
-- the difference. Incremental arithmetic is faster but unforgiving — one
-- bad backfill or one manual UPDATE in psql and the number drifts, with
-- nothing to pull it back. A full recompute is self-healing: every fire
-- re-derives the truth from the review rows.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_restaurant_rating()
RETURNS TRIGGER
AS $$

DECLARE
    -- Plural because one review change can touch two restaurants — see
    -- the re-pointed-review case below.
    v_restaurant_ids INTEGER[] := ARRAY[]::INTEGER[];
    v_restaurant_id  INTEGER;

BEGIN

    -- INSERT and UPDATE both leave a review in place: the restaurant it
    -- now belongs to needs recomputing.
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN

        SELECT b.restaurant_id
        INTO v_restaurant_id
        FROM orders o
        JOIN restaurant_branches b
            ON b.id = o.branch_id
        WHERE o.id = NEW.order_id;

        IF v_restaurant_id IS NOT NULL THEN
            v_restaurant_ids := array_append(v_restaurant_ids, v_restaurant_id);
        END IF;

    END IF;


    -- DELETE and UPDATE both leave a restaurant that no longer has the
    -- review it had a moment ago.
    --
    -- For a plain UPDATE this is the same restaurant as above and the
    -- dedupe below drops it. It differs only if a review is re-pointed at
    -- a different order (OLD.order_id <> NEW.order_id), which would move
    -- it to another restaurant; without this branch the restaurant it left
    -- would keep counting a review it no longer has.
    IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN

        SELECT b.restaurant_id
        INTO v_restaurant_id
        FROM orders o
        JOIN restaurant_branches b
            ON b.id = o.branch_id
        WHERE o.id = OLD.order_id;

        -- = ANY(...) is the dedupe: recomputing the same restaurant twice
        -- in one fire would be wasted work, not a wrong answer.
        IF v_restaurant_id IS NOT NULL
           AND NOT (v_restaurant_id = ANY(v_restaurant_ids)) THEN
            v_restaurant_ids := array_append(v_restaurant_ids, v_restaurant_id);
        END IF;

    END IF;


    -- Serialize before computing the aggregate. Waiting only during UPDATE can
    -- otherwise reuse an aggregate calculated before another review committed.
    PERFORM id FROM restaurants WHERE id = ANY(v_restaurant_ids) ORDER BY id FOR UPDATE;

    FOREACH v_restaurant_id IN ARRAY v_restaurant_ids
    LOOP

        UPDATE restaurants
        SET
            avg_rating   = restaurant_avg_rating(v_restaurant_id),

            -- The count is taken here rather than added to the function
            -- because the function's job is to answer one question — the
            -- average. Same three-table path, described in the function.
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

        -- Deleting the last review is handled by this same statement, not
        -- by a special case: with no rows left, AVG returns NULL and
        -- COUNT returns 0, so the restaurant correctly goes back to
        -- "unrated" instead of keeping the rating it used to have.

    END LOOP;


    -- An AFTER ... FOR EACH ROW trigger's return value is discarded, so
    -- NULL is the conventional thing to return.
    RETURN NULL;

END;

$$ LANGUAGE plpgsql;



-- ------------------------------------------------------------
-- 3. Attaching the trigger.
--
-- AFTER, because the stored summary should reflect what actually
-- committed, not what was merely proposed — a review that fails its
-- rating CHECK must not move the restaurant's average.
--
-- FOR EACH ROW, because the recompute needs OLD/NEW to know which
-- restaurant was affected; a statement-level trigger does not get them.
--
-- All three of INSERT, UPDATE and DELETE. Only inserts happen through the
-- API today (routes/reviews.js), but a rating that silently stops being
-- correct the moment someone edits or removes a row in psql is not a
-- guarantee worth relying on.
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sync_restaurant_rating ON restaurant_reviews;

CREATE TRIGGER trg_sync_restaurant_rating
    AFTER INSERT OR UPDATE OR DELETE
    ON restaurant_reviews
    FOR EACH ROW
    EXECUTE FUNCTION sync_restaurant_rating();



-- ------------------------------------------------------------
-- 4. Backfill.
--
-- The trigger only fires on changes made from now on, so every review
-- that already existed when this file was first run is invisible to it.
-- This one statement brings the stored columns up to date with the
-- reviews already in the table.
--
-- It covers EVERY restaurant, not just those with reviews, so that
-- unrated ones are explicitly set to (NULL, 0) rather than being left at
-- whatever the column happened to hold.
-- ------------------------------------------------------------

UPDATE restaurants r
SET
    avg_rating   = restaurant_avg_rating(r.id),
    review_count = (
        SELECT COUNT(*)
        FROM restaurant_reviews rev
        JOIN orders o
            ON o.id = rev.order_id
        JOIN restaurant_branches b
            ON b.id = o.branch_id
        WHERE b.restaurant_id = r.id
    );

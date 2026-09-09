-- ============================================================
-- MIGRATION 002 — stored rating columns on restaurants
--
-- Apply to an existing database:
--   psql "$DATABASE_URL" -f db/migrations/002_restaurant_ratings.sql
--
-- Databases created from the current db/schema.sql already include these
-- columns; this file exists so an existing dev database does not have to
-- be dropped and reseeded. It is idempotent — safe to re-run.
--
-- This migration only ADDS THE COLUMNS. The function, the trigger that
-- keeps them correct, and the backfill of existing rows all live in
-- db/functions/restaurant_rating.sql, which must be run after this.
-- Splitting them that way means the logic file can be re-run on its own
-- whenever the function or trigger changes, without touching the table.
-- ============================================================


-- ------------------------------------------------------------
-- Why store a rating at all, when it can be derived?
--
-- Every restaurant read was recomputing it. The list endpoint ran two
-- correlated subqueries PER RESTAURANT ROW (routes/restaurants.js), each
-- walking restaurant_reviews -> orders -> restaurant_branches, just to
-- print one number in a list. Ratings are read on nearly every page and
-- written only when someone finishes a meal, so paying that join cost on
-- every read is the wrong trade.
--
-- The risk of storing a derived value is that it can drift out of sync
-- with the rows it was derived from. The trigger in
-- db/functions/restaurant_rating.sql is what removes that risk: the
-- column cannot go stale because nothing can change a review without the
-- database itself recomputing the column in the same transaction.
-- ------------------------------------------------------------

ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS avg_rating NUMERIC(3,2);

-- Deliberately nullable with no default. NULL means "nobody has rated
-- this restaurant yet", which is not the same statement as 0.00 — a
-- default of zero would display a brand-new restaurant as the worst
-- possible score. NUMERIC(3,2) rather than the DECIMAL(2,1) sketched in
-- the original schema because an average like 4.33 has to survive; the
-- endpoints already rounded to 2 decimal places.

ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;

-- review_count, unlike the average, has a meaningful zero, so it is NOT
-- NULL and defaults to 0.
--
-- The supporting index for the recompute lives in
-- db/functions/restaurant_rating.sql instead of here, because that file
-- is run by both setup paths (fresh and migrated) and this one is not.

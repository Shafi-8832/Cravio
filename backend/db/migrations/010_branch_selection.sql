-- ============================================================
-- 010 — AUTOMATIC BRANCH SELECTION BY LOCATION (columns + demo data)
--
-- Adds what a branch needs so the app can pick the nearest branch that
-- can actually deliver to the customer:
--   * a delivery radius   (how far this branch's riders will go)
--   * opening hours       (so "open" can depend on the clock, not only
--                          on the owner's manual is_open switch)
--
-- The functions and the trigger that USE these columns live in
-- db/functions/restaurant_branches.sql, because the migration runner
-- re-installs every file in db/functions on each run (CREATE OR REPLACE).
--
-- What already existed and is NOT added again here:
--   * restaurant_branches.latitude / longitude — DECIMAL(9,6), which is
--     the same type as NUMERIC(9,6); their range and "both or neither"
--     CHECKs were added by 008_live_tracking.sql.
--   * orders.branch_id — already a foreign key to restaurant_branches(id)
--     since the base schema, and every existing order has one.
--   * orders.delivery_latitude / delivery_longitude — added by 008.
--
-- Additive only: no table is dropped and no existing order is changed.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Delivery radius, in km.
--
-- NOT NULL DEFAULT 5: every existing branch gets 5 km straight away, so
-- nothing is left without a radius. NUMERIC(4,1) allows values like 7.5.
-- The CHECK keeps it sensible: a radius of 0 would deliver nowhere, and
-- more than 30 km is not a food delivery any more in Dhaka traffic.
-- ------------------------------------------------------------

ALTER TABLE restaurant_branches
  ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC(4,1) NOT NULL DEFAULT 5;

ALTER TABLE restaurant_branches DROP CONSTRAINT IF EXISTS chk_branch_delivery_radius;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_delivery_radius
  CHECK (delivery_radius_km > 0 AND delivery_radius_km <= 30);


-- ------------------------------------------------------------
-- 2. Opening hours, as two TIME columns (local Dhaka time).
--
-- Both NULL means "no fixed hours" — the branch is open whenever the
-- owner's is_open switch is on. That is how every existing branch starts.
--
-- Pair CHECK: an opening time without a closing time is meaningless.
-- Not-equal CHECK: 10:00–10:00 could mean "open 24 hours" or "open zero
-- hours"; forbidding it removes the guess. (If either side is NULL the
-- comparison is NULL, and a CHECK treats NULL as passing.)
--
-- closes_at may be EARLIER than opens_at: 18:00–02:00 is an overnight
-- branch. branch_is_open() handles that case.
-- ------------------------------------------------------------

ALTER TABLE restaurant_branches ADD COLUMN IF NOT EXISTS opens_at TIME;
ALTER TABLE restaurant_branches ADD COLUMN IF NOT EXISTS closes_at TIME;

ALTER TABLE restaurant_branches DROP CONSTRAINT IF EXISTS chk_branch_hours_pair;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_hours_pair
  CHECK ((opens_at IS NULL) = (closes_at IS NULL));

ALTER TABLE restaurant_branches DROP CONSTRAINT IF EXISTS chk_branch_hours_not_equal;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_hours_not_equal
  CHECK (opens_at <> closes_at);


-- ------------------------------------------------------------
-- 3. Make every pinned branch sit on its own spot.
--
-- Two pairs of branches (of DIFFERENT restaurants) were given the exact
-- same Khilgaon coordinates by the 008 backfill. Two shops cannot stand
-- on the same pixel, and identical distances make "which branch is
-- nearest" a coin toss in the demo.
--
-- ROW_NUMBER() numbers the branches that share one coordinate pair
-- (0 = the first, by id). The first keeps its pin; each later one moves
-- north by 0.0012 degrees of latitude (about 130 m) per position.
-- ------------------------------------------------------------

UPDATE restaurant_branches rb
SET latitude = ROUND(rb.latitude + same_spot.position * 0.0012, 6)
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY latitude, longitude ORDER BY id) - 1 AS position
  FROM restaurant_branches
  WHERE latitude IS NOT NULL
) AS same_spot
WHERE same_spot.id = rb.id
  AND same_spot.position > 0;


-- ------------------------------------------------------------
-- 4. Demo opening hours for two branches, so both cases can be shown.
--
-- Everything else keeps NULL hours (always open unless the owner closes
-- it). Matched by restaurant name + area, not by id, because ids differ
-- between databases. A database without these restaurants simply
-- updates 0 rows.
--
--   Chuli Kitchen, Dhanmondi : 11:00 – 23:00  (normal day hours)
--   Kacchi Bhai,  Dhanmondi : 18:00 – 02:00  (overnight: open in the
--                                             evening, closes after midnight)
-- ------------------------------------------------------------

UPDATE restaurant_branches rb
SET opens_at = demo_hours.opens_at,
    closes_at = demo_hours.closes_at
FROM restaurants r,
  (VALUES
    ('Chuli Kitchen', 'dhanmondi', TIME '11:00', TIME '23:00'),
    ('Kacchi Bhai',   'dhanmondi', TIME '18:00', TIME '02:00')
  ) AS demo_hours(restaurant_name, area, opens_at, closes_at)
WHERE r.id = rb.restaurant_id
  AND r.name = demo_hours.restaurant_name
  AND lower(btrim(rb.area)) = demo_hours.area
  AND rb.opens_at IS NULL;

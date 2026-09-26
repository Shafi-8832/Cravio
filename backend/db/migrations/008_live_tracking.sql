-- ============================================================
-- MIGRATION 008 — map + live rider location tracking
--
-- Applied by `npm run db:migrate`. Additive and idempotent: every column
-- is ADD ... IF NOT EXISTS, every table CREATE ... IF NOT EXISTS, and every
-- constraint is dropped-if-present before it is added (ADD CONSTRAINT has
-- no IF NOT EXISTS form — same pattern as 006_review_replies.sql).
--
-- This file holds only TABLES, COLUMNS, CONSTRAINTS and the one-time
-- coordinate backfill. The distance_km() function and the location-logging
-- trigger live in db/functions/live_tracking.sql, which the migration
-- runner re-installs on every run, so they can be edited later without a
-- new migration.
--
-- Where does a restaurant's pin live? On restaurant_branches, not on
-- restaurants. A restaurant here has several branches, and an order is
-- placed at ONE branch (orders.branch_id), so the pickup point of an
-- order is the branch's coordinates. The branch table already had
-- latitude/longitude columns; this migration only adds the CHECKs.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Branch coordinates: add the missing CHECKs.
--
-- NUMERIC(9,6) = up to 3 digits before the point and 6 after, i.e.
-- about 10 cm precision — plenty for a food-delivery pin.
--
-- The pair CHECK stops a half-filled location: a latitude without a
-- longitude is not a place, and every distance query would silently
-- return NULL for it.
-- ------------------------------------------------------------

ALTER TABLE restaurant_branches DROP CONSTRAINT IF EXISTS chk_branch_latitude;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_latitude
  CHECK (latitude BETWEEN -90 AND 90);

ALTER TABLE restaurant_branches DROP CONSTRAINT IF EXISTS chk_branch_longitude;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_longitude
  CHECK (longitude BETWEEN -180 AND 180);

ALTER TABLE restaurant_branches DROP CONSTRAINT IF EXISTS chk_branch_coordinates_pair;
ALTER TABLE restaurant_branches ADD CONSTRAINT chk_branch_coordinates_pair
  CHECK ((latitude IS NULL) = (longitude IS NULL));


-- ------------------------------------------------------------
-- 2. Saved customer addresses already have latitude/longitude with range
--    CHECKs (migration 003). Only the "both or neither" rule is missing.
-- ------------------------------------------------------------

ALTER TABLE customer_addresses DROP CONSTRAINT IF EXISTS chk_address_coordinates_pair;
ALTER TABLE customer_addresses ADD CONSTRAINT chk_address_coordinates_pair
  CHECK ((latitude IS NULL) = (longitude IS NULL));


-- ------------------------------------------------------------
-- 3. The drop-off point, copied onto the order at checkout.
--
-- A SNAPSHOT, for the same reason order_items.unit_price is one: if the
-- customer later edits or deletes a saved address, an order that is
-- already on the road must still point at the place the food is going.
--
-- Nullable because older orders (and customers who skip the map pin)
-- have no coordinates; the tracking endpoint handles that with NULLs.
-- ------------------------------------------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_latitude NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_longitude NUMERIC(9,6);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_delivery_latitude;
ALTER TABLE orders ADD CONSTRAINT chk_order_delivery_latitude
  CHECK (delivery_latitude BETWEEN -90 AND 90);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_delivery_longitude;
ALTER TABLE orders ADD CONSTRAINT chk_order_delivery_longitude
  CHECK (delivery_longitude BETWEEN -180 AND 180);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_delivery_coordinates_pair;
ALTER TABLE orders ADD CONSTRAINT chk_order_delivery_coordinates_pair
  CHECK ((delivery_latitude IS NULL) = (delivery_longitude IS NULL));


-- ------------------------------------------------------------
-- 4. Where each rider is RIGHT NOW — exactly one row per rider.
--
-- rider_id is the PRIMARY KEY, so the rider app never piles up rows here:
-- every GPS update overwrites the same row with INSERT ... ON CONFLICT
-- (rider_id) DO UPDATE (an "upsert"). The history lives in
-- delivery_location_log below, written by a trigger.
--
-- Riders are users with role 'rider', so the FK points at users(id) —
-- the same column orders.rider_id and deliveries.rider_id point at.
-- ON DELETE CASCADE: a deleted account has no location to keep.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rider_current_location (

  rider_id INTEGER PRIMARY KEY
    REFERENCES users(id) ON DELETE CASCADE,

  latitude NUMERIC(9,6) NOT NULL
    CHECK (latitude BETWEEN -90 AND 90),

  longitude NUMERIC(9,6) NOT NULL
    CHECK (longitude BETWEEN -180 AND 180),

  -- How far off the phone thinks its own GPS reading may be, in metres.
  -- Optional: not every browser reports it.
  accuracy_m NUMERIC(8,2)
    CHECK (accuracy_m >= 0),

  -- TIMESTAMPTZ (with time zone) so "seconds since the last update" is
  -- correct no matter what time zone the server or database runs in.
  -- This is what the stale-signal check compares against now().
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- 5. The breadcrumb trail of each delivery.
--
-- Never written by application code: trg_log_rider_location (see
-- db/functions/live_tracking.sql) inserts a row here every time a rider's
-- current location changes while they carry an order.
--
-- order_id is stored (not just rider_id) because the customer's map must
-- show the path of THEIR order only — the same rider's earlier deliveries
-- must never leak onto it.
-- BIGSERIAL because a location row arrives every few seconds per rider,
-- which is the table most likely to outgrow a 32-bit id.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS delivery_location_log (

  log_id BIGSERIAL PRIMARY KEY,

  order_id INTEGER NOT NULL
    REFERENCES orders(id) ON DELETE CASCADE,

  rider_id INTEGER NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,

  latitude NUMERIC(9,6) NOT NULL
    CHECK (latitude BETWEEN -90 AND 90),

  longitude NUMERIC(9,6) NOT NULL
    CHECK (longitude BETWEEN -180 AND 180),

  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The trail query is always "this order's points, in time order", so the
-- index is on exactly those two columns in that order.
CREATE INDEX IF NOT EXISTS idx_delivery_location_log_order_time
  ON delivery_location_log(order_id, recorded_at);


-- ------------------------------------------------------------
-- 6. Demo coordinates for Dhaka branches that have none yet.
--
-- APPROXIMATE, not surveyed: each branch gets the centre of its
-- neighbourhood plus a small offset derived from its id (steps of
-- ~150 m), so two branches in the same area do not sit on the exact same
-- pixel. Owners can correct any pin from their dashboard.
--
-- Only rows whose latitude AND longitude are both NULL are touched, so a
-- real pin that is already set is never overwritten. Branches outside
-- Dhaka city are left without a pin and simply do not appear in
-- "near me" results.
-- ------------------------------------------------------------

UPDATE restaurant_branches rb
SET latitude  = ROUND(area_centre.lat + ((rb.id % 7) - 3) * 0.0015, 6),
    longitude = ROUND(area_centre.lng + ((rb.id % 5) - 2) * 0.0015, 6)
FROM (VALUES
  ('dhanmondi',   23.7465, 90.3760),
  ('dhannmondi',  23.7465, 90.3760),   -- a misspelling present in imported data
  ('gulshan',     23.7925, 90.4078),
  ('banani',      23.7940, 90.4030),
  ('mirpur',      23.8223, 90.3654),
  ('mirpur 1',    23.7957, 90.3537),
  ('mirpur 10',   23.8069, 90.3687),
  ('uttara',      23.8759, 90.3795),
  ('mohammadpur', 23.7662, 90.3589),
  ('badda',       23.7806, 90.4265),
  ('khilgaon',    23.7516, 90.4240),
  ('lalbagh',     23.7189, 90.3882),
  ('panthapath',  23.7516, 90.3870),
  ('bashundhara', 23.8193, 90.4526),
  ('motijheel',   23.7330, 90.4172)
) AS area_centre(area, lat, lng)
WHERE rb.latitude IS NULL
  AND rb.longitude IS NULL
  AND rb.city = 'Dhaka'
  AND lower(btrim(rb.area)) = area_centre.area;

-- Any Dhaka branch whose area is not in the list above falls back to the
-- city centre (23.8103, 90.4125), with the same small offset.
UPDATE restaurant_branches rb
SET latitude  = ROUND(23.8103 + ((rb.id % 7) - 3) * 0.0015, 6),
    longitude = ROUND(90.4125 + ((rb.id % 5) - 2) * 0.0015, 6)
WHERE rb.latitude IS NULL
  AND rb.longitude IS NULL
  AND rb.city = 'Dhaka';

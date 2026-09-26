-- ============================================================
-- CRAVIO LIVE TRACKING — distance function + location-logging trigger
--
-- Installed by `npm run db:migrate` on every run, after the migrations,
-- so it needs db/migrations/008_live_tracking.sql to have created
-- rider_current_location and delivery_location_log first.
--
-- Safe to re-run: CREATE OR REPLACE for both functions and
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- ============================================================


-- ------------------------------------------------------------
-- 1. distance_km(lat1, lng1, lat2, lng2) — the Haversine formula.
--
-- In plain English: the Earth is (nearly) a ball, so the distance between
-- two points on it is an arc, not a straight line on a flat map.
--   a) Turn the difference in latitude and in longitude into radians
--      (the unit trigonometry functions expect).
--   b) Combine them into "a" — the square of half the straight-line
--      chord between the two points, on a ball of radius 1. The cos()
--      factor shrinks the longitude part as you move away from the
--      equator, because lines of longitude get closer together there.
--   c) 2 * asin(sqrt(a)) turns that chord into the angle between the two
--      points, as seen from the centre of the Earth.
--   d) Angle x Earth's radius (6371 km) = distance along the surface.
--
-- LEAST(1, ...) guards against floating-point rounding pushing the value
-- a hair above 1, which would make asin() raise an error for two points on
-- opposite sides of the planet.
--
-- IMMUTABLE: the same four numbers always give the same answer and nothing
-- is read from any table, so PostgreSQL may cache or pre-compute it.
-- STRICT: if ANY argument is NULL the function is not even run and the
-- result is NULL — exactly what we want for a rider with no location yet
-- or an order with no drop-off pin.
--
-- Rounded to 3 decimals = 1 metre. Returned as NUMERIC so it compares and
-- sorts exactly like the coordinate columns it is fed from.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION distance_km(
    p_lat1 NUMERIC,
    p_lng1 NUMERIC,
    p_lat2 NUMERIC,
    p_lng2 NUMERIC
)
RETURNS NUMERIC
AS $$

    SELECT ROUND((
        2 * 6371 * asin(
            sqrt(
                LEAST(
                    1,
                    power(sin(radians(p_lat2 - p_lat1) / 2), 2)
                    + cos(radians(p_lat1)) * cos(radians(p_lat2))
                      * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
                )
            )
        )
    )::NUMERIC, 3);

$$ LANGUAGE sql IMMUTABLE STRICT;



-- ------------------------------------------------------------
-- 2. The trigger function: copy every new rider position into the
--    trail of the order(s) that rider is carrying.
--
-- Why a TRIGGER and not a second INSERT in the Express route?
-- Because the log is a shadow table of rider_current_location: every
-- change to one must show up in the other. As a trigger, the database
-- itself guarantees that, inside the same transaction, no matter which
-- code (the API, a psql session, a future script) moves the rider. If the
-- log insert fails, the location update rolls back with it, so the two
-- tables can never disagree.
--
-- ONE INSERT ... SELECT, not an IF plus a single INSERT: the SELECT finds
-- every order this rider is carrying right now. Zero orders (rider is
-- idle) inserts nothing, one order inserts one row, and if the business
-- ever allowed stacked deliveries it would insert one row per order with
-- no code change. Today a rider can hold only one active delivery (the
-- accept route in routes/rider.js enforces that).
--
-- 'out_for_delivery' is the only TRACKABLE status: it is set when the
-- rider marks the food as picked up. Before that the rider is travelling
-- to the restaurant, which is not part of the customer's delivery trail.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION log_rider_location()
RETURNS TRIGGER
AS $$

BEGIN

    INSERT INTO delivery_location_log (order_id, rider_id, latitude, longitude, recorded_at)
    SELECT o.id, NEW.rider_id, NEW.latitude, NEW.longitude, NEW.updated_at
    FROM orders o
    WHERE o.rider_id = NEW.rider_id
      AND o.status = 'out_for_delivery';

    -- The return value of an AFTER ... FOR EACH ROW trigger is ignored.
    RETURN NULL;

END;

$$ LANGUAGE plpgsql;



-- ------------------------------------------------------------
-- 3. Attaching the trigger.
--
-- AFTER, so only a location row that passed its CHECKs is logged.
-- INSERT OR UPDATE, because a rider's very first position is an INSERT
-- into rider_current_location and every later one is an UPDATE (the
-- ON CONFLICT branch of the upsert).
-- UPDATE OF latitude, longitude — not a bare UPDATE — so only a statement
-- that writes a POSITION is logged. The rider API's upsert always sets
-- both columns, so every GPS report still counts (even a rider standing
-- still). But touching only updated_at or accuracy_m (say, from psql) is
-- not movement and must not add a fake point to a customer's trail. Same
-- idea as "UPDATE OF rating, order_id" on trg_sync_restaurant_rating.
-- FOR EACH ROW, because the function needs NEW (the new coordinates).
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_log_rider_location ON rider_current_location;

CREATE TRIGGER trg_log_rider_location
    AFTER INSERT OR UPDATE OF latitude, longitude
    ON rider_current_location
    FOR EACH ROW
    EXECUTE FUNCTION log_rider_location();

-- ============================================================
-- CRAVIO BRANCH SELECTION — two functions + one validation trigger
--
-- Installed by `npm run db:migrate` on every run, after the migrations,
-- so 010_branch_selection.sql has already added delivery_radius_km,
-- opens_at and closes_at. The runner installs db/functions in
-- alphabetical order, and this file sorts after live_tracking.sql, so
-- distance_km() already exists when branches_by_distance() is created.
--
-- Safe to re-run: CREATE OR REPLACE for the functions and
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- ============================================================


-- ------------------------------------------------------------
-- 1. branch_is_open(opens, closes) — is a branch inside its opening
--    hours right now?
--
-- The clock: the database server runs in GMT (SHOW timezone), but the
-- opening hours are Dhaka wall-clock times. now()::time would give GMT,
-- six hours behind, and a branch that opens at 11:00 would look closed
-- until 17:00 Dhaka time. So we first convert now() to Asia/Dhaka.
--
-- Three cases:
--   * NULL hours            -> TRUE (no fixed hours = always open).
--   * opens < closes        -> normal day, e.g. 11:00–23:00:
--                              open if 11:00 <= t < 23:00.
--   * opens > closes        -> overnight, e.g. 18:00–02:00: the open
--                              period crosses midnight, so it is open
--                              in the evening (t >= 18:00) OR after
--                              midnight (t < 02:00). At 01:00 -> open;
--                              at 15:00 -> closed.
-- (opens = closes is forbidden by a CHECK in migration 010.)
--
-- STABLE, not IMMUTABLE: the answer depends on now(), which changes
-- between transactions, but stays the same within one statement.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION branch_is_open(
    p_opens TIME,
    p_closes TIME
)
RETURNS BOOLEAN
AS $$

    SELECT CASE
        WHEN p_opens IS NULL OR p_closes IS NULL THEN TRUE
        WHEN p_opens < p_closes THEN dhaka.now_time >= p_opens AND dhaka.now_time < p_closes
        ELSE dhaka.now_time >= p_opens OR dhaka.now_time < p_closes
    END
    FROM (SELECT (now() AT TIME ZONE 'Asia/Dhaka')::time AS now_time) AS dhaka;

$$ LANGUAGE sql STABLE;



-- ------------------------------------------------------------
-- 2. branches_by_distance(restaurant, lat, lng) — every branch of one
--    restaurant, measured from one point, best choice first.
--
-- Returns one row per branch, for example:
--   branch_id | branch_name      | distance_km | delivery_radius_km | is_open | can_deliver
--   231       | Khilgaon, Dhaka  | 0.412       | 5.0                | true    | true
--   1         | Dhanmondi, Dhaka | 5.112       | 5.0                | true    | false
--
-- Only branches that can take orders at all are listed: the restaurant
-- has ordering switched on, the owner's account is active (the same two
-- rules place_order() checks), and the branch has a map pin — without a
-- pin there is no distance to measure.
--
-- is_open     = the owner's manual switch AND the opening hours.
-- can_deliver = is_open AND the point is inside the delivery radius.
--
-- ORDER BY can_deliver DESC puts the branches that can deliver first,
-- then distance_km ASC puts the nearest of those at the top. So the
-- first row with can_deliver = TRUE is the branch the app auto-selects.
--
-- Why a FUNCTION: the result is pure computation (no side effects), and
-- the same rule is needed by the /branches API and by checkout, so it is
-- written once, in the database.
-- STABLE because it reads tables and now(); STRICT so a NULL lat/lng
-- simply returns no rows instead of rows full of NULL distances.
--
-- The inner SELECT exists because can_deliver needs distance_km and
-- is_open, and a column alias cannot be reused in the same SELECT list.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION branches_by_distance(
    p_restaurant_id INTEGER,
    p_lat NUMERIC,
    p_lng NUMERIC
)
RETURNS TABLE (
    branch_id INTEGER,
    branch_name TEXT,
    address TEXT,
    latitude NUMERIC,
    longitude NUMERIC,
    distance_km NUMERIC,
    delivery_radius_km NUMERIC,
    is_open BOOLEAN,
    can_deliver BOOLEAN
)
AS $$

    SELECT
        b.branch_id,
        b.branch_name,
        b.address,
        b.latitude,
        b.longitude,
        b.distance_km,
        b.delivery_radius_km,
        b.is_open,
        (b.is_open AND b.distance_km <= b.delivery_radius_km) AS can_deliver
    FROM (
        SELECT
            rb.id AS branch_id,
            rb.area || ', ' || rb.city AS branch_name,
            rb.address,
            rb.latitude,
            rb.longitude,
            distance_km(p_lat, p_lng, rb.latitude, rb.longitude) AS distance_km,
            rb.delivery_radius_km,
            -- COALESCE: is_open is a nullable column; treat NULL as closed
            -- so can_deliver is always TRUE or FALSE, never NULL.
            (COALESCE(rb.is_open, false) AND branch_is_open(rb.opens_at, rb.closes_at)) AS is_open
        FROM restaurant_branches rb
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        JOIN users u
          ON u.id = r.owner_id
        WHERE rb.restaurant_id = p_restaurant_id
          AND r.ordering_enabled = true
          AND u.is_active = true
          AND rb.latitude IS NOT NULL
          AND rb.longitude IS NOT NULL
    ) AS b
    ORDER BY can_deliver DESC, b.distance_km ASC, b.branch_id;

$$ LANGUAGE sql STABLE STRICT;



-- ------------------------------------------------------------
-- 3. The trigger function: validate an order's branch BEFORE it is
--    stored ("data validation before DML").
--
-- Every order must have a delivery pin, and its branch must exist, be
-- able to take orders, be open, and be within its delivery radius of
-- that pin. The API picks a sensible branch, but only this trigger
-- GUARANTEES the rule: it runs inside the database for every INSERT or
-- UPDATE of these columns, no matter which code path (the API,
-- place_order(), psql, a future script) writes the order.
--
-- A RAISE here aborts the statement. Order creation runs inside a
-- transaction, so the whole transaction is rolled back: the order AND
-- its order_items disappear together.
--
-- Every rejection uses our own error code (SQLSTATE) 'CRV01', so the
-- API can recognise "this branch cannot take this order" by err.code
-- and answer 409, while each case keeps its own readable message.
--
-- Orders have no restaurant_id column — the restaurant is always found
-- through branch_id — so "the branch belongs to the order's restaurant"
-- is true by construction and needs no separate check here.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_order_branch_range()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_branch RECORD;
    v_distance NUMERIC;
BEGIN
    -- Every new order must say where the food is going.
    IF NEW.delivery_latitude IS NULL OR NEW.delivery_longitude IS NULL THEN
        RAISE EXCEPTION 'Every order needs a delivery pin on the map.'
            USING ERRCODE = 'CRV01';
    END IF;

    -- Look up the branch together with the two "may take orders" rules.
    SELECT
        rb.latitude,
        rb.longitude,
        rb.delivery_radius_km,
        (COALESCE(rb.is_open, false) AND branch_is_open(rb.opens_at, rb.closes_at)) AS is_open,
        (r.ordering_enabled AND u.is_active) AS is_active
    INTO v_branch
    FROM restaurant_branches rb
    JOIN restaurants r ON r.id = rb.restaurant_id
    JOIN users u ON u.id = r.owner_id
    WHERE rb.id = NEW.branch_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'This branch does not exist.'
            USING ERRCODE = 'CRV01';
    END IF;

    -- IS NOT TRUE (not just NOT) so a NULL flag also counts as "no".
    IF v_branch.is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'This restaurant is not accepting orders right now.'
            USING ERRCODE = 'CRV01';
    END IF;

    IF NOT v_branch.is_open THEN
        RAISE EXCEPTION 'This branch is closed right now.'
            USING ERRCODE = 'CRV01';
    END IF;

    -- A branch without a map pin has no measurable distance, so it
    -- cannot promise to reach any delivery pin.
    IF v_branch.latitude IS NULL OR v_branch.longitude IS NULL THEN
        RAISE EXCEPTION 'This branch has no map location yet, so it cannot deliver.'
            USING ERRCODE = 'CRV01';
    END IF;

    v_distance := distance_km(
        v_branch.latitude, v_branch.longitude,
        NEW.delivery_latitude, NEW.delivery_longitude
    );

    -- Example message: "This branch doesn't deliver to your location
    -- (7.3 km away; it delivers within 5.0 km)."
    IF v_distance > v_branch.delivery_radius_km THEN
        RAISE EXCEPTION 'This branch doesn''t deliver to your location (% km away; it delivers within % km).',
            ROUND(v_distance, 1), v_branch.delivery_radius_km
            USING ERRCODE = 'CRV01';
    END IF;

    RETURN NEW;
END;
$$;


-- BEFORE, so a bad row is rejected before it is ever written.
-- UPDATE OF lists only the columns this rule depends on: changing an
-- order's status (confirm, deliver, cancel) does not re-check the
-- branch, so old orders keep moving through their life cycle normally.
DROP TRIGGER IF EXISTS trg_validate_order_branch_range ON orders;

CREATE TRIGGER trg_validate_order_branch_range
BEFORE INSERT OR UPDATE OF branch_id, delivery_latitude, delivery_longitude
ON orders
FOR EACH ROW
EXECUTE FUNCTION validate_order_branch_range();

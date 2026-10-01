-- ============================================================
-- CRAVIO ORDER LIFECYCLE — the status state machine, enforced in the
-- database, plus the pickup routine that the "food ready" gate lives in.
--
-- Installed by `npm run db:migrate` on every run, after the migrations,
-- so it needs db/migrations/012_order_lifecycle.sql to have added
-- orders.food_ready_at and the 'food_ready' status first.
--
-- Safe to re-run: CREATE OR REPLACE for the functions and the procedure,
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The state machine.
--
-- A "state machine" here just means: an order's status may only move
-- along a fixed set of arrows, and every other move is an error.
--
--   pending          -> confirmed | cancelled
--   confirmed        -> preparing | cancelled
--   preparing        -> food_ready | cancelled
--   food_ready       -> out_for_delivery | cancelled
--   out_for_delivery -> delivered
--   delivered        -> (nothing)
--   cancelled        -> (nothing)
--
-- Why a TRIGGER and not an IF in the Express route?
-- Because "an order cannot skip a stage" is a rule about the DATA, not
-- about one request handler. The route already checks it, which is what
-- produces a friendly 409. The trigger is what makes the rule TRUE: a
-- seed script, a psql session, a future endpoint written by someone who
-- never read orderService.js, and even a hand-typed UPDATE all hit it.
-- Without it, "preparing" is a label; with it, "preparing" is a fact
-- that something had to happen to reach.
--
-- The whole map is one CASE expression returning an array of the statuses
-- that may follow OLD.status. A row is also free to go nowhere: an UPDATE
-- that leaves the status alone (writing food_ready_at, a rider id, a
-- delivery pin) is not a transition and returns early.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER
AS $$

DECLARE
    v_allowed TEXT[];

BEGIN

    -- IS DISTINCT FROM, not <>, because <> with a NULL on either side
    -- yields NULL rather than true, and an IF on NULL does not run.
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    v_allowed := CASE OLD.status
        WHEN 'pending'          THEN ARRAY['confirmed', 'cancelled']
        WHEN 'confirmed'        THEN ARRAY['preparing', 'cancelled']
        WHEN 'preparing'        THEN ARRAY['food_ready', 'cancelled']
        WHEN 'food_ready'       THEN ARRAY['out_for_delivery', 'cancelled']
        WHEN 'out_for_delivery' THEN ARRAY['delivered']
        -- Both end states. An empty array means every move fails below,
        -- which is what makes 'delivered' and 'cancelled' final.
        WHEN 'delivered'        THEN ARRAY[]::TEXT[]
        WHEN 'cancelled'        THEN ARRAY[]::TEXT[]
        ELSE ARRAY[]::TEXT[]
    END;

    IF NOT (NEW.status = ANY (v_allowed)) THEN
        -- The message names both ends so the log line is readable on its
        -- own. ERRCODE 'CRV03' is a custom SQLSTATE from our own CRV0x
        -- range: 'CRV01' is the branch-range trigger
        -- (restaurant_branches.sql) and 'CRV02' the overlapping-offer
        -- trigger (item_offers.sql). Node matches on the code rather than
        -- on English text, so the wording here can change freely.
        RAISE EXCEPTION 'ILLEGAL_STATUS_TRANSITION: order % cannot go from % to %',
            OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'CRV03';
    END IF;

    RETURN NEW;

END;

$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- 2. Attaching the trigger.
--
-- BEFORE, because the point is to STOP the write. An AFTER trigger would
-- also abort the transaction, but only once the row had been changed and
-- any other AFTER trigger on orders had already reacted to a status that
-- was never legal.
--
-- UPDATE OF status — not a bare UPDATE — so an order being given a rider,
-- a delivery pin or a food_ready_at timestamp does not pay for a check
-- that cannot fail. Same narrowing as trg_sync_restaurant_rating.
--
-- No INSERT: a new order starts at 'pending' from place_order() and has
-- no previous status to move from. The CHECK constraint on the column is
-- what guards the inserted value.
--
-- FOR EACH ROW, because the check needs OLD and NEW.
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_enforce_order_status_transition ON orders;

CREATE TRIGGER trg_enforce_order_status_transition
    BEFORE UPDATE OF status
    ON orders
    FOR EACH ROW
    EXECUTE FUNCTION enforce_order_status_transition();


-- ------------------------------------------------------------
-- 3. pickup_delivery(order_id, rider_id) — the gate.
--
-- Called inside BEGIN/COMMIT by the rider route, exactly like
-- complete_delivery(). It is a PROCEDURE for the same reason: confirming
-- a pickup is two writes in two tables (deliveries and orders) that must
-- both land or neither.
--
-- The rule this exists for: a rider cannot confirm pickup until the
-- kitchen has marked the food ready. Putting that check here rather than
-- in Node means it holds for every caller, now and later.
--
-- Locks are taken in the SAME order as complete_delivery() — rider
-- profile, order, delivery — because two routines that lock the same
-- three rows in opposite orders are how a deadlock happens.
-- ------------------------------------------------------------

CREATE OR REPLACE PROCEDURE pickup_delivery(p_order_id INTEGER, p_rider_id INTEGER)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$

DECLARE
    v_order orders%ROWTYPE;
    v_delivery deliveries%ROWTYPE;

BEGIN

    PERFORM 1 FROM rider_profiles WHERE user_id = p_rider_id FOR UPDATE;
    SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
    SELECT * INTO v_delivery FROM deliveries WHERE order_id = p_order_id FOR UPDATE;

    -- Object-level ownership, checked again at the lowest level: the
    -- delivery must exist AND belong to the rider asking.
    --
    -- Two separate errors on purpose, because they are two different
    -- answers: no such delivery is a 404, and someone else's delivery is a
    -- 403. Collapsing them would tell a rider guessing order ids the same
    -- thing either way, which is tidier but less honest to the caller who
    -- simply mistyped an id.
    IF v_delivery.id IS NULL THEN
        RAISE EXCEPTION 'DELIVERY_NOT_FOUND';
    END IF;

    IF v_delivery.rider_id <> p_rider_id THEN
        RAISE EXCEPTION 'DELIVERY_NOT_ASSIGNED';
    END IF;

    IF v_delivery.delivery_status <> 'assigned' THEN
        RAISE EXCEPTION 'INVALID_DELIVERY_TRANSITION';
    END IF;

    -- THE GATE. Checked before the status check below, because while the
    -- food is not ready the order is still 'preparing' and the generic
    -- transition error would hide the real reason from the rider.
    IF v_order.food_ready_at IS NULL THEN
        RAISE EXCEPTION 'FOOD_NOT_READY';
    END IF;

    -- food_ready_at being set should mean the status is 'food_ready'.
    -- Checking anyway costs nothing and catches a row that some other
    -- path left inconsistent.
    IF v_order.status <> 'food_ready' THEN
        RAISE EXCEPTION 'INVALID_DELIVERY_TRANSITION';
    END IF;

    UPDATE deliveries
    SET delivery_status = 'picked_up'
    WHERE order_id = p_order_id;

    -- trg_enforce_order_status_transition allows food_ready ->
    -- out_for_delivery, and trg_record_order_event logs it.
    UPDATE orders
    SET status = 'out_for_delivery'
    WHERE id = p_order_id;

END;

$$;

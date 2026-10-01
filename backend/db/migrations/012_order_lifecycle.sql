-- ============================================================
-- 012 — ORDER LIFECYCLE: a prep-time commitment and a real "food ready" gate
--
-- Until now the order status was a label: the restaurant could tap
-- "start preparing" and a rider could confirm pickup seconds later,
-- because nothing recorded whether the kitchen had actually finished.
--
-- This migration adds the facts the lifecycle needs:
--   * what the restaurant promised (prep_minutes, accepted_at, ready_at)
--   * what actually happened (food_ready_at)
--   * why an order was turned down (rejected_reason)
-- and inserts a new status, 'food_ready', between 'preparing' and
-- 'out_for_delivery'.
--
-- The rules that USE these columns live in db/functions/order_lifecycle.sql
-- (the state-machine trigger and the pickup procedure). This file only
-- creates storage, so it stays additive and safe to re-run.
--
-- Applied by `npm run db:migrate`. Idempotent: ADD COLUMN IF NOT EXISTS,
-- and each constraint is dropped by name before being re-added.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The new columns.
--
-- All five are nullable, because each one is a fact that only becomes
-- true at a particular point in the order's life. An order still waiting
-- to be accepted genuinely has no accepted_at, and NULL says exactly
-- that — a zero or a sentinel date would be a lie the reports would read.
--
-- TIMESTAMP (not TIMESTAMPTZ) to match orders.created_at, which the rest
-- of the order code already compares against.
-- ------------------------------------------------------------

ALTER TABLE orders
  -- What the restaurant committed to when accepting, in minutes. Not a
  -- free number: the owner picks one of five buttons, and the CHECK below
  -- is what makes that a database rule rather than a UI convention.
  ADD COLUMN IF NOT EXISTS prep_minutes INTEGER,

  -- When the restaurant accepted the order.
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP,

  -- The TARGET: accepted_at + prep_minutes. Stored rather than computed on
  -- read so the promise cannot move later. Every countdown the customer,
  -- the owner and the rider see is counting down to this one value, so
  -- they are all looking at the same number.
  ADD COLUMN IF NOT EXISTS ready_at TIMESTAMP,

  -- When the kitchen ACTUALLY pressed "food is ready". This is the gate:
  -- while it is NULL no rider can confirm pickup. ready_at is a promise,
  -- food_ready_at is the fact, and keeping both is what lets the platform
  -- tell "ready on time" from "ready twenty minutes late".
  ADD COLUMN IF NOT EXISTS food_ready_at TIMESTAMP,

  -- Only ever set when a restaurant rejects an order, so a cancellation
  -- made by the customer stays distinguishable from a rejection made by
  -- the kitchen.
  ADD COLUMN IF NOT EXISTS rejected_reason VARCHAR(50);


-- ------------------------------------------------------------
-- 2. 'food_ready' joins the status list.
--
-- A CHECK constraint cannot be altered in place, so the old one is
-- dropped and an identical list plus the new value is added back.
-- The name is the one PostgreSQL generated for the table in schema.sql,
-- which is why it is spelled out rather than guessed at runtime.
-- ------------------------------------------------------------

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (
    status IN (
      'pending',
      'confirmed',
      'preparing',
      'food_ready',
      'out_for_delivery',
      'delivered',
      'cancelled'
    )
  );


-- ------------------------------------------------------------
-- 3. The two value lists, as constraints.
--
-- The route validates these as well, so the caller gets a 400 with a
-- helpful message instead of a 500. The constraints are here because a
-- validation that only exists in Node is not a rule about the data: a
-- script or a psql session would walk straight past it.
-- ------------------------------------------------------------

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_prep_minutes;

ALTER TABLE orders
  ADD CONSTRAINT chk_order_prep_minutes
  CHECK (prep_minutes IS NULL OR prep_minutes IN (10, 15, 20, 30, 45));


ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_rejected_reason;

ALTER TABLE orders
  ADD CONSTRAINT chk_order_rejected_reason
  CHECK (
    rejected_reason IS NULL
    OR rejected_reason IN ('item_unavailable', 'kitchen_overloaded', 'closing_soon')
  );


-- A rejection is a cancellation with a reason attached, so a reason on a
-- live order would be a contradiction. Enforcing the pairing here means
-- no code path can leave the row in that state.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_order_rejected_reason_cancelled;

ALTER TABLE orders
  ADD CONSTRAINT chk_order_rejected_reason_cancelled
  CHECK (rejected_reason IS NULL OR status = 'cancelled');


-- ------------------------------------------------------------
-- 4. Backfill.
--
-- Three decisions, each stated plainly because none of them can be
-- recovered from the data we have:
--
-- (a) accepted_at = created_at for every order that got past 'pending'.
--     The real acceptance time was never recorded. created_at is the only
--     timestamp we have and it is a lower bound on the truth, so the
--     backfilled promise reads as "accepted immediately" rather than as
--     a guess at a time that might be wrong in either direction.
--
-- (b) prep_minutes = 20, the middle of the five allowed values, and
--     ready_at = accepted_at + 20 minutes. Any value here is invented;
--     20 is invented and obvious, and it keeps ready_at consistent with
--     prep_minutes instead of leaving a half-filled row.
--
-- (c) food_ready_at is set ONLY for orders that already reached
--     'out_for_delivery' or 'delivered'. For those the food demonstrably
--     was ready — a rider was carrying it. Orders sitting at 'preparing'
--     are left NULL on purpose: nobody ever pressed "food is ready" for
--     them, so the new gate correctly holds their pickup until the
--     kitchen does. That is the safe direction to be wrong in.
--
-- rejected_reason is deliberately NOT backfilled. Existing cancellations
-- have no recorded reason, and writing one would put a fact in the
-- database that nobody ever stated.
-- ------------------------------------------------------------

UPDATE orders
SET accepted_at  = created_at,
    prep_minutes = 20,
    ready_at     = created_at + INTERVAL '20 minutes'
WHERE accepted_at IS NULL
  AND status IN ('confirmed', 'preparing', 'out_for_delivery', 'delivered');

UPDATE orders
SET food_ready_at = ready_at
WHERE food_ready_at IS NULL
  AND status IN ('out_for_delivery', 'delivered');


-- ------------------------------------------------------------
-- 5. Index.
--
-- The rider's job board asks "which orders at my division are cooking or
-- ready and unclaimed?" on every poll. idx_orders_branch_status_created
-- (place_order.sql) already covers branch + status; this one serves the
-- status-first scan the board does across all branches.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_orders_status_ready
  ON orders(status, ready_at);

-- ============================================================
-- 011 — ITEM OFFERS (time-limited discounts on single menu items)
--
-- One row = "item X is Y% off between starts_at and ends_at".
-- This file only creates the table. The things built ON it are
-- re-installed on every `npm run db:migrate` from db/functions:
--   * db/functions/item_offers.sql — the overlap trigger and the
--     active_item_offers view
-- Demo offers are NOT inserted here: their times are relative to "now",
-- and a migration runs only once, so they would all be expired a few
-- days later. `npm run seed:offers` (re)creates them on demand.
--
-- Additive only: no existing table or row is changed.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The table.
--
-- item_id -> menu_items ON DELETE CASCADE: an offer on a dish that no
-- longer exists means nothing, so it disappears with the dish.
--
-- discount_percent 5..80: below 5% is not worth a banner, above 80% is
-- almost certainly a typing mistake.
--
-- TIMESTAMPTZ (with time zone): an offer ends at one exact moment, the
-- same for the server (GMT) and the customer (Dhaka).
--
-- CHECK (ends_at > starts_at): an offer must last a positive amount of
-- time. Overlapping offers on the same item are stopped by a TRIGGER
-- (a CHECK can only look at one row, not at the other rows).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS item_offers (
  offer_id SERIAL PRIMARY KEY,

  item_id INTEGER NOT NULL
    REFERENCES menu_items(id) ON DELETE CASCADE,

  discount_percent INTEGER NOT NULL
    CONSTRAINT chk_item_offer_discount CHECK (discount_percent BETWEEN 5 AND 80),

  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_item_offer_period CHECK (ends_at > starts_at)
);


-- ------------------------------------------------------------
-- 2. Index on (item_id, ends_at).
--
-- Both hot queries look offers up BY ITEM and then compare times:
--   * checkout / cart / menu: "does item X have an offer running now?"
--   * the overlap trigger:    "does item X already have an offer in this
--                              time range?"
-- item_id first finds the item's few rows directly; ends_at second lets
-- the "not ended yet" condition be answered from the index as well.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_item_offers_item_ends
  ON item_offers(item_id, ends_at);

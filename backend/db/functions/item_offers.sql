-- ============================================================
-- CRAVIO ITEM OFFERS — overlap trigger + active_item_offers view
--
-- Installed by `npm run db:migrate` on every run, after the migrations,
-- so migration 011 has already created the item_offers table.
-- Safe to re-run: CREATE OR REPLACE for the function and the view,
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The trigger function: one item may not have two offers at the
--    same time ("data validation before DML").
--
-- Why a trigger: a CHECK constraint sees only the row being written,
-- but "overlaps another offer" needs to look at the OTHER rows of the
-- same table. A trigger can run that SELECT before the row is stored.
--
-- Two time ranges overlap when each one starts before the other ends:
--     existing.starts_at < NEW.ends_at  AND  NEW.starts_at < existing.ends_at
-- Example: existing 10:00–14:00, new 13:00–18:00 -> 10 < 18 and 13 < 14
-- -> overlap, rejected. New 14:00–18:00 -> 14 < 14 is false -> allowed,
-- because an offer ending at 14:00 is no longer running at 14:00.
--
-- offer_id <> NEW.offer_id: on UPDATE, the row being edited must not be
-- compared with its own old version. (On INSERT the SERIAL default has
-- already filled NEW.offer_id before a BEFORE trigger runs, so the same
-- line works for both.)
--
-- The FOR UPDATE lock on the menu item makes two offers for the SAME
-- item wait for each other; otherwise two transactions could both see
-- "no overlap" at the same moment and both insert.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_overlapping_item_offers()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_clash item_offers%ROWTYPE;
BEGIN
    PERFORM 1 FROM menu_items WHERE id = NEW.item_id FOR UPDATE;

    SELECT *
    INTO v_clash
    FROM item_offers io
    WHERE io.item_id = NEW.item_id
      AND io.offer_id <> NEW.offer_id
      AND io.starts_at < NEW.ends_at
      AND NEW.starts_at < io.ends_at
    LIMIT 1;

    -- Times in the message are shown in Dhaka time, e.g. "27 Sep 19:16".
    IF FOUND THEN
        RAISE EXCEPTION 'Menu item % already has offer % running % to %, which overlaps the new period % to % (Dhaka time).',
            NEW.item_id, v_clash.offer_id,
            to_char(v_clash.starts_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI'),
            to_char(v_clash.ends_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI'),
            to_char(NEW.starts_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI'),
            to_char(NEW.ends_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI')
            USING ERRCODE = 'CRV02';
    END IF;

    RETURN NEW;
END;
$$;


-- UPDATE OF only the columns that can create an overlap; changing the
-- discount_percent of an offer does not need the check.
DROP TRIGGER IF EXISTS trg_prevent_overlapping_item_offers ON item_offers;

CREATE TRIGGER trg_prevent_overlapping_item_offers
BEFORE INSERT OR UPDATE OF item_id, starts_at, ends_at
ON item_offers
FOR EACH ROW
EXECUTE FUNCTION prevent_overlapping_item_offers();



-- ------------------------------------------------------------
-- 2. The view active_item_offers: every offer running RIGHT NOW, with
--    the dish, its restaurant and the discounted price already computed.
--
-- A VIEW is a saved SELECT that other queries use like a table. Putting
-- "is it running now?" and the discount maths here means the home page
-- deals, the popular rail, the menu, the cart AND checkout all use the
-- exact same rule and the exact same price — nobody re-implements it.
--
-- starts_at <= now() AND ends_at > now(): started, and not yet ended
-- (the same half-open range the trigger uses). An expired offer and a
-- future offer are both invisible here.
--
-- discounted_price: price x (100 - percent) / 100, rounded to whole taka.
-- 100.0 (not 100) keeps the division in NUMERIC so nothing is truncated;
-- ::NUMERIC(10,2) gives it the same type as menu_items.price.
-- Example: 450.00 at 25% off -> 450 x 75 / 100 = 337.5 -> 338.00.
--
-- is_available / ordering_enabled are exposed so the home page can hide
-- deals that cannot be ordered, while checkout still prices by the view.
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW active_item_offers AS
SELECT
    io.offer_id,
    io.item_id,
    mi.name AS item_name,
    mi.image_url,
    r.id AS restaurant_id,
    r.name AS restaurant_name,
    mi.price AS original_price,
    io.discount_percent,
    ROUND(mi.price * (100 - io.discount_percent) / 100.0, 0)::NUMERIC(10,2) AS discounted_price,
    io.starts_at,
    io.ends_at,
    mi.is_available,
    r.ordering_enabled
FROM item_offers io
JOIN menu_items mi
  ON mi.id = io.item_id
JOIN restaurants r
  ON r.id = mi.restaurant_id
WHERE io.starts_at <= now()
  AND io.ends_at > now();

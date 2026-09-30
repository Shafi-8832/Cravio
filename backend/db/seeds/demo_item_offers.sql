-- ============================================================
-- DEMO ITEM OFFERS — run with `npm run seed:offers` (re-runnable).
--
-- Times are relative to now(), so running this again right before a
-- demo gives fresh countdowns. Runs as ONE transaction (the script wraps
-- it in BEGIN/COMMIT): either every demo offer is replaced, or nothing.
--
-- 13 offers on 12 restaurants' dishes (only dishes WITH a photo):
--   * 4 end within a few hours   -> short "ends in 1h 30m" countdowns
--   * 7 end in a few days
--   * 1 already EXPIRED          -> must NOT appear in active_item_offers
--   * 1 starts TOMORROW          -> must NOT appear yet either
-- Those last two prove the view filters by time.
-- ============================================================

-- The dishes: the Nth most expensive photographed, available dish of each
-- named restaurant (a main course makes a better deal than a soft drink). Matched by name so it works on any copy of the catalogue;
-- a restaurant that does not exist simply contributes no row.
CREATE TEMP TABLE demo_offer_plan ON COMMIT DROP AS
SELECT
    mi.id AS item_id,
    plan.discount_percent,
    now() + plan.starts_in AS starts_at,
    now() + plan.ends_in AS ends_at
FROM (VALUES
    -- restaurant,        dish #, % off, starts in,          ends in
    ('Kacchi Bhai',        1, 25, INTERVAL '-1 hour',     INTERVAL '3 hours'),
    ('KFC',                1, 30, INTERVAL '-2 hours',    INTERVAL '5 hours'),
    ('Sultan''s Dine',     1, 40, INTERVAL '-30 minutes', INTERVAL '90 minutes'),
    ('Fry Bucket',         1, 20, INTERVAL '-1 hour',     INTERVAL '7 hours'),
    ('Chillox',            1, 20, INTERVAL '-1 day',      INTERVAL '2 days'),
    ('Domino''s Pizza',    1, 35, INTERVAL '-1 hour',     INTERVAL '4 days'),
    ('BFC',                1, 15, INTERVAL '-1 day',      INTERVAL '6 days'),
    ('Takeout',            1, 25, INTERVAL '-2 hours',    INTERVAL '3 days'),
    ('Khana''s',           1, 20, INTERVAL '-1 day',      INTERVAL '5 days'),
    ('Pizza Republic',     1, 50, INTERVAL '-3 hours',    INTERVAL '2 days'),
    ('Chuli Kitchen',      1, 10, INTERVAL '-1 hour',     INTERVAL '8 days'),
    ('KFC',                2, 45, INTERVAL '-3 days',     INTERVAL '-1 day'),   -- expired
    ('Chillox',            2, 30, INTERVAL '1 day',       INTERVAL '3 days')    -- future
) AS plan(restaurant_name, dish_number, discount_percent, starts_in, ends_in)
JOIN restaurants r
  ON r.name = plan.restaurant_name
JOIN (
    -- Number each restaurant's photographed, available dishes 1, 2, 3 ...
    -- from the most expensive down (id breaks ties so it is repeatable).
    SELECT
        id,
        restaurant_id,
        ROW_NUMBER() OVER (PARTITION BY restaurant_id ORDER BY price DESC, id) AS dish_number
    FROM menu_items
    WHERE image_url IS NOT NULL
      AND btrim(image_url) <> ''
      AND is_available = true
) AS mi
  ON mi.restaurant_id = r.id
 AND mi.dish_number = plan.dish_number;

-- Remove the old offers of THESE dishes only, so the fresh ones below do
-- not overlap them (the overlap trigger would reject the insert).
DELETE FROM item_offers
WHERE item_id IN (SELECT item_id FROM demo_offer_plan);

-- Insert through the normal table, so every row passes the CHECKs and the
-- overlap trigger exactly like an owner-created offer would.
INSERT INTO item_offers (item_id, discount_percent, starts_at, ends_at)
SELECT item_id, discount_percent, starts_at, ends_at
FROM demo_offer_plan;

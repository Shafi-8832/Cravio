-- ============================================================
-- MIGRATION 001 — make modifiers usable
--
-- Apply to an existing database:
--   psql "$DATABASE_URL" -f db/migrations/001_modifiers.sql
--
-- Databases created from the current db/schema.sql already include
-- everything here; this file exists so an existing dev database does not
-- have to be dropped and reseeded. It is idempotent — safe to re-run.
--
-- The modifier tables (modifier_groups, modifier_options,
-- cart_item_modifiers) shipped in the original schema but had no code
-- behind them. Wiring them up exposed two problems this migration fixes.
-- ============================================================


-- ------------------------------------------------------------
-- 1. A cart line is (menu item + its chosen modifiers), not just
--    the menu item.
--
-- UNIQUE(cart_id, menu_item_id) made "Margherita, extra cheese" and
-- "Margherita, no basil" collide: the second add would merge into the
-- first and silently inherit its modifiers. Two configurations of the
-- same dish are two different things to cook, so they have to be two
-- rows.
--
-- Uniqueness is now enforced in the application instead (see the
-- matching-line lookup in routes/cart.js), because "same item with the
-- same set of modifiers" is a set comparison that a table constraint
-- cannot express.
-- ------------------------------------------------------------

ALTER TABLE cart_items
    DROP CONSTRAINT IF EXISTS cart_items_cart_id_menu_item_id_key;

-- The constraint was also doing duty as the lookup index for
-- "find this item in this cart", which is on the hot path of every add.
-- Keep that access path, without the uniqueness.
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_menu_item
    ON cart_items(cart_id, menu_item_id);


-- ------------------------------------------------------------
-- 2. Orders had nowhere to record which modifiers were chosen.
--
-- cart_item_modifiers is deleted along with the cart at checkout, so
-- without this table the kitchen would never learn that the customer
-- asked for extra cheese, and the order total could not be explained
-- after the fact.
--
-- price_modifier is a snapshot, for the same reason order_items.unit_price
-- is: re-pricing "extra cheese" next month must not silently rewrite what
-- an old order charged.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_item_modifiers (

    id SERIAL PRIMARY KEY,


    order_item_id INTEGER
        REFERENCES order_items(id)
        ON DELETE CASCADE,


    modifier_option_id INTEGER
        REFERENCES modifier_options(id),


    -- Denormalised on purpose: the option can be renamed or deleted later,
    -- and the order still has to render.
    name VARCHAR(100)
        NOT NULL,


    price_modifier DECIMAL(10,2)
        NOT NULL
        DEFAULT 0.00,


    UNIQUE(order_item_id, modifier_option_id)
);


CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_order_item
    ON order_item_modifiers(order_item_id);


-- ------------------------------------------------------------
-- 3. Supporting indexes for the modifier reads added to the menu
--    endpoint, which fetches every group and option for a restaurant
--    on each menu load.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_modifier_groups_menu_item
    ON modifier_groups(menu_item_id);

CREATE INDEX IF NOT EXISTS idx_modifier_options_group
    ON modifier_options(modifier_group_id);

CREATE INDEX IF NOT EXISTS idx_cart_item_modifiers_cart_item
    ON cart_item_modifiers(cart_item_id);

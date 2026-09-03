-- ============================================================
-- CRAVIO ORDER CHECKOUT FUNCTION
-- Run this file once after db/schema.sql.
-- PostgreSQL functions run inside the transaction opened by orderService.js.
-- ============================================================

-- explain indexes? Indexes are used to speed up the retrieval of rows from a table. They are like a table of contents for a book, allowing the database to quickly find the rows that match a query without having to scan the entire table. In this case, we are creating indexes on the orders and restaurants tables to improve the performance of queries that filter by customer_id, branch_id, status, and owner_id.
-- like hash table, but more like a tree structure that allows for efficient searching and sorting of data. The indexes we are creating here will help speed up queries that filter by customer_id, branch_id, status, and owner_id, which are common filters used in the application.

CREATE INDEX IF NOT EXISTS idx_orders_customer_created
    ON orders(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_branch_status_created
    ON orders(branch_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_restaurants_owner
    ON restaurants(owner_id);


CREATE OR REPLACE FUNCTION place_order(
    p_customer_id INTEGER,
    p_branch_id INTEGER,
    p_delivery_address TEXT,
    p_payment_method VARCHAR(20),
    p_promo_code VARCHAR(20) DEFAULT NULL
)
RETURNS TABLE (
    order_id INTEGER,
    subtotal DECIMAL(10,2),
    discount_amount DECIMAL(10,2),
    total_amount DECIMAL(10,2)
)
LANGUAGE plpgsql
SECURITY INVOKER -- wth is this? This means that the function will execute with the privileges of the user who calls it, rather than the privileges of the user who created it. This is important for security, as it ensures that the function cannot perform actions that the calling user is not allowed to do.
SET search_path = public, pg_temp -- wth is this syntax? This sets the search path for the function to the public schema and the temporary schema. This means that when the function looks for tables, it will first look in the public schema, and then in the temporary schema. This is important for ensuring that the function can access the correct tables, especially if there are temporary tables created during the transaction.
-- so the search will first look in the public schema, then in the temporary schema, and if it doesn't find the table there, it will look in the default schema. This is important for ensuring that the function can access the correct tables, especially if there are temporary tables created during the transaction.

AS $$
DECLARE
    v_restaurant_id INTEGER;
    v_branch_is_open BOOLEAN;
    v_cart_id INTEGER;
    v_order_id INTEGER;
    v_subtotal DECIMAL(10,2);
    v_discount DECIMAL(10,2) := 0.00;
    v_total DECIMAL(10,2);
    v_promo promo_codes%ROWTYPE;
BEGIN

    -- SETUP && VALIDATION
    -- CHECK 3 THINGS : 1. USER EXISTS && ROLE OK? 2. ADDRESS OK? 3. PAYMENT METHOD OK?
    -- Authentication is checked in Express. This is defense in depth.
    IF NOT EXISTS (
        SELECT 1
        FROM users
        WHERE id = p_customer_id
          AND role = 'customer'
    ) THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND_OR_INVALID_ROLE';
    END IF;

    IF p_delivery_address IS NULL OR btrim(p_delivery_address) = '' THEN
        RAISE EXCEPTION 'INVALID_DELIVERY_ADDRESS';
    END IF;

    IF p_payment_method NOT IN ('cash_on_delivery', 'bkash', 'nagad') THEN
        RAISE EXCEPTION 'INVALID_PAYMENT_METHOD';
    END IF;
    -- SETUP && VALIDATION


    -- FOR SHARE = row level lock, locks UPDATE/DELETE for others, but others can READ that row
    -- FOR UPDATE = brutal full row level lock. locks UPDATE/DELETE/READ for others


    -- The branch identifies which restaurant cart must be checked out.
    SELECT rb.restaurant_id, rb.is_open
    INTO v_restaurant_id, v_branch_is_open
    FROM restaurant_branches rb
    WHERE rb.id = p_branch_id
    FOR SHARE; -- Prevents restaurant_owner from UPDATE ing/closing the branch mid-transaction, while allowing concurrent customer checkouts (READ).
    -- t=1 is_open is read TRUE
    -- t=2 owner closes restaurant
    -- t=51 order is completed. written into DB
    -- now customers moeny is gone, but they need to wait until the restaurant reopens and starts to cook their food!
    
    -- wait minutes X
    -- wait mili seconds ⚡︎

    IF NOT FOUND THEN
        RAISE EXCEPTION 'BRANCH_NOT_FOUND';
    END IF;

    IF NOT v_branch_is_open THEN
        RAISE EXCEPTION 'BRANCH_CLOSED';
    END IF;

    -- Lock the cart so two checkout requests cannot consume it together.
    SELECT c.id
    INTO v_cart_id
    FROM carts c
    WHERE c.user_id = p_customer_id
      AND c.restaurant_id = v_restaurant_id
    FOR UPDATE; -- if the user hits the place order 4 times, the first click arrives, locks the row FULLY, then deletes the CART
    -- the last 3 clicks find the cart empty so they fail safely.

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CART_NOT_FOUND'; -- the v_cart_id TH cart might not even have been created
    END IF;

    -- if I don't find any row/item in cart_items in v_cart_id TH cart, then the v_cart_id cart is just empty
    IF NOT EXISTS (
        SELECT 1
        FROM cart_items
        WHERE cart_id = v_cart_id
    ) THEN
        RAISE EXCEPTION 'CART_EMPTY';
    END IF;

    -- A cart row is labeled with restaurant_id, but every actual item is
    -- revalidated here so malformed/tampered cart data cannot be ordered.
    IF EXISTS (
        SELECT 1
        FROM cart_items ci
        JOIN menu_items mi ON mi.id = ci.menu_item_id
        WHERE ci.cart_id = v_cart_id
          AND mi.restaurant_id <> v_restaurant_id 
          -- hacker trying to put a $499 pizza from another restaurant's menu to this restaurants cart, 
          -- so check whether the item actually belongs to that restaurant's menu or not
    ) THEN
        RAISE EXCEPTION 'CART_CONTAINS_INVALID_ITEM';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM cart_items ci
        JOIN menu_items mi ON mi.id = ci.menu_item_id
        WHERE ci.cart_id = v_cart_id
          AND mi.is_available = false
    ) THEN
        RAISE EXCEPTION 'CART_CONTAINS_UNAVAILABLE_ITEM';
    END IF;

    -- Never accept subtotal/total from the client. Current menu prices are
    -- recalculated while the transaction owns the cart lock.
    SELECT ROUND(SUM(mi.price * ci.quantity), 2)
    INTO v_subtotal
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
    WHERE ci.cart_id = v_cart_id;

    IF v_subtotal IS NULL OR v_subtotal <= 0 THEN
        RAISE EXCEPTION 'CART_EMPTY';
    END IF;

    IF p_promo_code IS NOT NULL AND btrim(p_promo_code) <> '' THEN
        -- Locking the promo row prevents concurrent requests from exceeding promo code usage limit
        SELECT pc.*
        INTO v_promo
        FROM promo_codes pc
        WHERE upper(pc.code) = upper(btrim(p_promo_code))
        FOR UPDATE;
        -- why for update?
        -- suppose the promo code use_count is at 49/50
        -- two customers try to use it at the same time
        -- both read the row, see 49/50, and proceed to use it
        -- the first customer updates the row to 50/50, and the second customer also updates the row to 50/50, 
        -- both make it 50 then both WRITE to the DB, use_count = 50/50, but the second customer should have been blocked because the promo code was already exhausted
        -- so the promo code is used 51 times, exceeding the limit
        -- that is why we need to lock the promo code row for update, 
        -- so that the second customer has to wait until the first customer finishes and commits the transaction, then the second customer will see 50/50 and be blocked from using it

        IF NOT FOUND THEN
            RAISE EXCEPTION 'PROMO_CODE_INVALID';
        END IF;

        IF v_promo.expiry_date < CURRENT_DATE THEN
            RAISE EXCEPTION 'PROMO_CODE_EXPIRED';
        END IF;

        IF NOT v_promo.is_active THEN
            RAISE EXCEPTION 'PROMO_CODE_INACTIVE';
        END IF;

        IF v_promo.used_count >= v_promo.usage_limit THEN
            RAISE EXCEPTION 'PROMO_CODE_EXHAUSTED';
        END IF;

        -- why do we need COALESCE here? 
        -- Because if the promo code has no minimum order amount, 
        -- then v_promo.min_order_amount will be NULL, and we want to treat that as 0. 
        -- So if the subtotal is less than 0, we raise an exception. 
        -- If the promo code has a minimum order amount, 
        -- then we check if the subtotal is less than that amount, and if so, we raise an exception.
        IF v_subtotal < COALESCE(v_promo.min_order_amount, 0) THEN
            RAISE EXCEPTION 'PROMO_MINIMUM_NOT_MET';
        END IF;

        v_discount := ROUND(
            v_subtotal * v_promo.discount_percent / 100.0,
            2
        );

        UPDATE promo_codes
        SET used_count = used_count + 1 
        -- why don't we write for update here? Because we already locked the row for update when we selected it, so we don't need to lock it again.
        -- SET is already an update, so we don't need to lock it again. We just need to update the used_count in the database.
        -- why don't we just do v_promo.used_count := v_promo.used_count + 1? Because that would only change the local variable, not the database row. We need to update the actual row in the database to reflect the new used_count.
        WHERE id = v_promo.id;
    END IF;

    -- explain this line? This line calculates the total amount for the order by subtracting the discount from the subtotal and ensuring it's not negative.
    v_total := GREATEST(v_subtotal - v_discount, 0.00);

    INSERT INTO orders (
        customer_id,
        branch_id,
        promo_code_id,
        delivery_address,
        subtotal,
        discount_amount,
        total_amount,
        status
    )
    VALUES (
        p_customer_id,
        p_branch_id,
        v_promo.id,
        btrim(p_delivery_address),
        v_subtotal,
        v_discount,
        v_total,
        'pending'
    )
    RETURNING id INTO v_order_id;

    -- unit_price is a historical price snapshot. Later menu price changes do not change an already-created order.
    INSERT INTO order_items (
        order_id,
        menu_item_id,
        quantity,
        unit_price -- explain this line? This line records the price of the menu item at the time of order, so that if the menu price changes later, the order still reflects the original price.
    )
    SELECT -- what is the work of this SELECT statement? 
    -- This SELECT statement retrieves the menu item IDs, quantities, and prices from the cart_items table for the given cart ID, and inserts them into the order_items table along with the order ID. It effectively transfers the items from the cart to the order while preserving their prices at the time of checkout.
    -- whatever is selected here is inserted up into order_items

        v_order_id,
        ci.menu_item_id,
        ci.quantity,
        mi.price
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
    WHERE ci.cart_id = v_cart_id -- don't get confused about v_cart_id, we have already found the cart_id before and put it in v_cart_id, now we are just reusing the variable
    ORDER BY ci.id;

    -- Online methods are recorded as unpaid until a trusted payment callback
    -- verifies them. The client is never allowed to declare a payment "paid".
    INSERT INTO payments (
        order_id,
        method,
        amount,
        status
    )
    VALUES (
        v_order_id,
        p_payment_method,
        v_total,
        'unpaid'
    );

    -- Clearing items keeps the cart row reusable for this restaurant.

    -- deleting the cart so that this prevents duplicate orders from being placed with the same cart items.
    DELETE FROM cart_items
    WHERE cart_id = v_cart_id;

    UPDATE carts
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = v_cart_id;

    RETURN QUERY
    SELECT
        v_order_id,
        v_subtotal,
        v_discount,
        v_total;
END;
$$;

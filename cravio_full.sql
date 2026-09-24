--
-- PostgreSQL database dump
--

\restrict frTzHE6jiEckT5AKEvykmrTJBRxFwQU1eekxTeYykPhmblHVQchNfLiGoBk5uAC

-- Dumped from database version 16.14 (Homebrew)
-- Dumped by pg_dump version 16.14 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: complete_delivery(integer, integer); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.complete_delivery(IN p_order_id integer, IN p_rider_id integer)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_delivery deliveries%ROWTYPE;
BEGIN
  -- Every delivery write locks profile, order, delivery, then payment in that order.
  PERFORM 1 FROM rider_profiles WHERE user_id = p_rider_id FOR UPDATE;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  SELECT * INTO v_delivery FROM deliveries WHERE order_id = p_order_id FOR UPDATE;
  IF v_delivery.id IS NULL OR v_delivery.rider_id <> p_rider_id THEN
    RAISE EXCEPTION 'DELIVERY_NOT_ASSIGNED';
  END IF;
  IF v_delivery.delivery_status <> 'picked_up' OR v_order.status <> 'out_for_delivery' THEN
    RAISE EXCEPTION 'INVALID_DELIVERY_TRANSITION';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE order_id = p_order_id
             AND method <> 'cash_on_delivery' AND status <> 'paid') THEN
    RAISE EXCEPTION 'PAYMENT_NOT_VERIFIED';
  END IF;
  UPDATE deliveries SET delivery_status = 'delivered', delivery_time = CURRENT_TIMESTAMP
    WHERE order_id = p_order_id;
  UPDATE orders SET status = 'delivered', review_eligible = true WHERE id = p_order_id;
  UPDATE payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP
    WHERE order_id = p_order_id AND method = 'cash_on_delivery' AND status = 'unpaid';
  UPDATE rider_profiles SET status = 'online' WHERE user_id = p_rider_id;
END;
$$;


--
-- Name: place_order(integer, integer, text, character varying, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.place_order(p_customer_id integer, p_branch_id integer, p_delivery_address text, p_payment_method character varying, p_promo_code character varying DEFAULT NULL::character varying) RETURNS TABLE(order_id integer, subtotal numeric, discount_amount numeric, total_amount numeric)
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
    v_restaurant_id INTEGER;
    v_branch_is_open BOOLEAN;
    v_ordering_enabled BOOLEAN;
    v_delivery_fee NUMERIC(10,2);
    v_min_order_amount NUMERIC(10,2);
    v_cart_id INTEGER;
    v_order_id INTEGER;
    v_subtotal DECIMAL(10,2);
    v_discount DECIMAL(10,2) := 0.00;
    v_total DECIMAL(10,2);
    v_promo promo_codes%ROWTYPE;
    v_cart_item RECORD;
    v_order_item_id INTEGER;
BEGIN

    -- SETUP && VALIDATION
    -- CHECK 3 THINGS : 1. USER EXISTS && ROLE OK? 2. ADDRESS OK? 3. PAYMENT METHOD OK?
    -- Authentication is checked in Express. This is defense in depth.
    IF NOT EXISTS (
        SELECT 1
        FROM users
        WHERE id = p_customer_id
          AND role = 'customer' AND is_active = true
    ) THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND_OR_INVALID_ROLE';
    END IF;

    IF p_delivery_address IS NULL OR btrim(p_delivery_address) = '' THEN
        RAISE EXCEPTION 'INVALID_DELIVERY_ADDRESS';
    END IF;

    IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash_on_delivery', 'bkash', 'nagad') THEN
        RAISE EXCEPTION 'INVALID_PAYMENT_METHOD';
    END IF;
    -- SETUP && VALIDATION


    -- FOR SHARE = row level lock, locks UPDATE/DELETE for others, but others can READ that row
    -- FOR UPDATE blocks conflicting row locks and writes; ordinary SELECT still reads committed data.


    -- The branch identifies which restaurant cart must be checked out.
    SELECT rb.restaurant_id, rb.is_open, rb.delivery_fee, rb.min_order_amount, (r.ordering_enabled AND u.is_active)
    INTO v_restaurant_id, v_branch_is_open, v_delivery_fee, v_min_order_amount, v_ordering_enabled
    FROM restaurant_branches rb
    JOIN restaurants r ON r.id = rb.restaurant_id
    JOIN users u ON u.id = r.owner_id AND u.role = 'restaurant_owner'
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

    IF NOT v_ordering_enabled THEN
        RAISE EXCEPTION 'RESTAURANT_NOT_ORDERABLE';
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

    -- Hold menu prices and modifier definitions stable until snapshots are copied.
    -- All cart mutations take the cart row lock above before touching its lines.
    PERFORM mi.id FROM menu_items mi JOIN cart_items ci ON ci.menu_item_id = mi.id
      WHERE ci.cart_id = v_cart_id ORDER BY mi.id FOR SHARE OF mi;
    PERFORM mg.id FROM modifier_groups mg JOIN cart_items ci ON ci.menu_item_id = mg.menu_item_id
      WHERE ci.cart_id = v_cart_id ORDER BY mg.id FOR SHARE OF mg;
    PERFORM mo.id FROM modifier_options mo
      JOIN cart_item_modifiers cim ON cim.modifier_option_id = mo.id
      JOIN cart_items ci ON ci.id = cim.cart_item_id
      WHERE ci.cart_id = v_cart_id ORDER BY mo.id FOR SHARE OF mo;

    -- Group requirements may have changed since the customer added the item.
    IF EXISTS (
      SELECT 1 FROM cart_items ci JOIN modifier_groups mg ON mg.menu_item_id = ci.menu_item_id
      LEFT JOIN cart_item_modifiers cim ON cim.cart_item_id = ci.id
      LEFT JOIN modifier_options mo ON mo.id = cim.modifier_option_id AND mo.modifier_group_id = mg.id
      WHERE ci.cart_id = v_cart_id
      GROUP BY ci.id, mg.id
      HAVING COUNT(mo.id) > mg.max_selection OR
        ((mg.is_required OR COUNT(mo.id) > 0) AND COUNT(mo.id) < GREATEST(mg.min_selection, CASE WHEN mg.is_required THEN 1 ELSE 0 END))
    ) OR EXISTS (
      SELECT 1 FROM cart_item_modifiers cim JOIN cart_items ci ON ci.id = cim.cart_item_id
      JOIN modifier_options mo ON mo.id = cim.modifier_option_id
      JOIN modifier_groups mg ON mg.id = mo.modifier_group_id
      WHERE ci.cart_id = v_cart_id AND mg.menu_item_id <> ci.menu_item_id
    ) THEN
      RAISE EXCEPTION 'CART_MODIFIERS_CHANGED';
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

    -- A modifier can be switched off between adding to the cart and checking
    -- out, exactly like the menu item itself. Same rule, one level down.
    IF EXISTS (
        SELECT 1
        FROM cart_items ci
        JOIN cart_item_modifiers cim ON cim.cart_item_id = ci.id
        JOIN modifier_options mo ON mo.id = cim.modifier_option_id
        WHERE ci.cart_id = v_cart_id
          AND mo.is_available = false
    ) THEN
        RAISE EXCEPTION 'CART_CONTAINS_UNAVAILABLE_MODIFIER';
    END IF;

    -- Never accept subtotal/total from the client. Current menu prices are
    -- recalculated while the transaction owns the cart lock.
    --
    -- The price of one unit is the menu price PLUS its chosen modifiers, so
    -- the modifiers are summed per cart line first and only then multiplied by
    -- the quantity. Summing them in the outer query instead would multiply the
    -- base price once per modifier row and silently overcharge every item that
    -- has more than one.
    SELECT ROUND(SUM((mi.price + line.modifier_total) * ci.quantity), 2)
    INTO v_subtotal
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
    CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(mo.price_modifier), 0.00) AS modifier_total
        FROM cart_item_modifiers cim
        JOIN modifier_options mo ON mo.id = cim.modifier_option_id
        WHERE cim.cart_item_id = ci.id
    ) AS line
    WHERE ci.cart_id = v_cart_id;

    IF v_subtotal IS NULL OR v_subtotal <= 0 THEN
        RAISE EXCEPTION 'CART_EMPTY';
    END IF;

    IF v_subtotal < v_min_order_amount THEN
        RAISE EXCEPTION 'BRANCH_MINIMUM_NOT_MET';
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
    v_total := GREATEST(v_subtotal - v_discount, 0.00) + v_delivery_fee;

    INSERT INTO orders (
        customer_id,
        branch_id,
        promo_code_id,
        delivery_address,
        subtotal,
        discount_amount,
        total_amount,
        delivery_fee,
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
        v_delivery_fee,
        'pending'
    )
    RETURNING id INTO v_order_id;

    -- unit_price is a historical price snapshot. Later menu price changes do not change an already-created order.
    --
    -- This is a LOOP rather than one INSERT ... SELECT because each order_item
    -- may carry its own modifiers, and inserting them requires knowing the id
    -- of the order_item row that was just created. A set-based insert cannot
    -- give us that mapping: now that modifiers exist, the same menu_item_id can
    -- legitimately appear on several lines of one order ("Margherita + extra
    -- cheese" and "Margherita, plain"), so RETURNING menu_item_id would not
    -- identify which line is which.
    --
    -- unit_price stays the BASE menu price. The modifier deltas live in
    -- order_item_modifiers with their own snapshot, so a line's true cost is
    -- (unit_price + SUM(price_modifier)) * quantity — the same shape the cart
    -- and the subtotal above use.
    FOR v_cart_item IN
        SELECT
            ci.id AS cart_item_id,
            ci.menu_item_id,
            ci.quantity,
            mi.price, mi.name, mi.image_url
        FROM cart_items ci
        JOIN menu_items mi ON mi.id = ci.menu_item_id
        WHERE ci.cart_id = v_cart_id -- don't get confused about v_cart_id, we have already found the cart_id before and put it in v_cart_id, now we are just reusing the variable
        ORDER BY ci.id
    LOOP

        INSERT INTO order_items (
            order_id,
            menu_item_id,
            quantity,
            item_name,
            image_url,
            unit_price -- records the price of the menu item at the time of order, so that if the menu price changes later, the order still reflects the original price.
        )
        VALUES (
            v_order_id,
            v_cart_item.menu_item_id,
            v_cart_item.quantity,
            v_cart_item.name,
            v_cart_item.image_url,
            v_cart_item.price
        )
        RETURNING id INTO v_order_item_id;

        -- name and price_modifier are copied, not referenced, so renaming or
        -- re-pricing the option later cannot rewrite this order.
        INSERT INTO order_item_modifiers (
            order_item_id,
            modifier_option_id,
            name,
            price_modifier
        )
        SELECT
            v_order_item_id,
            mo.id,
            mo.name,
            mo.price_modifier
        FROM cart_item_modifiers cim
        JOIN modifier_options mo ON mo.id = cim.modifier_option_id
        WHERE cim.cart_item_id = v_cart_item.cart_item_id;

    END LOOP;

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
$_$;


--
-- Name: record_order_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_order_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_events(order_id, status, note) VALUES (NEW.id, NEW.status, 'Order placed');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_events(order_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: restaurant_avg_rating(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restaurant_avg_rating(p_restaurant_id integer) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$

    -- Reviews carry no restaurant_id of their own, so this walks the only
    -- path that connects them: a review belongs to an order, an order was
    -- placed at a branch, and a branch belongs to a restaurant. Rounded to
    -- 2 decimals to match the NUMERIC(3,2) column it feeds.
    SELECT ROUND(AVG(rev.rating), 2)
    FROM restaurant_reviews rev
    JOIN orders o
        ON o.id = rev.order_id
    JOIN restaurant_branches b
        ON b.id = o.branch_id
    WHERE b.restaurant_id = p_restaurant_id;

$$;


--
-- Name: sync_restaurant_rating(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_restaurant_rating() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

DECLARE
    -- Plural because one review change can touch two restaurants — see
    -- the re-pointed-review case below.
    v_restaurant_ids INTEGER[] := ARRAY[]::INTEGER[];
    v_restaurant_id  INTEGER;

BEGIN

    -- INSERT and UPDATE both leave a review in place: the restaurant it
    -- now belongs to needs recomputing.
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN

        SELECT b.restaurant_id
        INTO v_restaurant_id
        FROM orders o
        JOIN restaurant_branches b
            ON b.id = o.branch_id
        WHERE o.id = NEW.order_id;

        IF v_restaurant_id IS NOT NULL THEN
            v_restaurant_ids := array_append(v_restaurant_ids, v_restaurant_id);
        END IF;

    END IF;


    -- DELETE and UPDATE both leave a restaurant that no longer has the
    -- review it had a moment ago.
    --
    -- For a plain UPDATE this is the same restaurant as above and the
    -- dedupe below drops it. It differs only if a review is re-pointed at
    -- a different order (OLD.order_id <> NEW.order_id), which would move
    -- it to another restaurant; without this branch the restaurant it left
    -- would keep counting a review it no longer has.
    IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN

        SELECT b.restaurant_id
        INTO v_restaurant_id
        FROM orders o
        JOIN restaurant_branches b
            ON b.id = o.branch_id
        WHERE o.id = OLD.order_id;

        -- = ANY(...) is the dedupe: recomputing the same restaurant twice
        -- in one fire would be wasted work, not a wrong answer.
        IF v_restaurant_id IS NOT NULL
           AND NOT (v_restaurant_id = ANY(v_restaurant_ids)) THEN
            v_restaurant_ids := array_append(v_restaurant_ids, v_restaurant_id);
        END IF;

    END IF;


    -- Serialize before computing the aggregate. Waiting only during UPDATE can
    -- otherwise reuse an aggregate calculated before another review committed.
    PERFORM id FROM restaurants WHERE id = ANY(v_restaurant_ids) ORDER BY id FOR UPDATE;

    FOREACH v_restaurant_id IN ARRAY v_restaurant_ids
    LOOP

        UPDATE restaurants
        SET
            avg_rating   = restaurant_avg_rating(v_restaurant_id),

            -- The count is taken here rather than added to the function
            -- because the function's job is to answer one question — the
            -- average. Same three-table path, described in the function.
            review_count = (
                SELECT COUNT(*)
                FROM restaurant_reviews rev
                JOIN orders o
                    ON o.id = rev.order_id
                JOIN restaurant_branches b
                    ON b.id = o.branch_id
                WHERE b.restaurant_id = v_restaurant_id
            )
        WHERE id = v_restaurant_id;

        -- Deleting the last review is handled by this same statement, not
        -- by a special case: with no rows left, AVG returns NULL and
        -- COUNT returns 0, so the restaurant correctly goes back to
        -- "unrated" instead of keeping the rating it used to have.

    END LOOP;


    -- An AFTER ... FOR EACH ROW trigger's return value is discarded, so
    -- NULL is the conventional thing to return.
    RETURN NULL;

END;

$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: cart_item_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cart_item_modifiers (
    id integer NOT NULL,
    cart_item_id integer,
    modifier_option_id integer
);


--
-- Name: cart_item_modifiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cart_item_modifiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cart_item_modifiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cart_item_modifiers_id_seq OWNED BY public.cart_item_modifiers.id;


--
-- Name: cart_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cart_items (
    id integer NOT NULL,
    cart_id integer,
    menu_item_id integer,
    quantity integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT cart_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: cart_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cart_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cart_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cart_items_id_seq OWNED BY public.cart_items.id;


--
-- Name: carts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carts (
    id integer NOT NULL,
    user_id integer,
    restaurant_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: carts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.carts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: carts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.carts_id_seq OWNED BY public.carts.id;


--
-- Name: customer_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_addresses (
    id integer NOT NULL,
    user_id integer,
    label character varying(50),
    area character varying(100) NOT NULL,
    full_address text NOT NULL,
    is_default boolean DEFAULT false,
    division character varying(20),
    city character varying(100),
    phone character varying(20),
    latitude numeric(9,6),
    longitude numeric(9,6),
    CONSTRAINT customer_addresses_label_check CHECK (((label)::text = ANY ((ARRAY['Home'::character varying, 'Work'::character varying, 'Other'::character varying])::text[]))),
    CONSTRAINT customer_addresses_latitude_check CHECK (((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))),
    CONSTRAINT customer_addresses_longitude_check CHECK (((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)))
);


--
-- Name: customer_addresses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_addresses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_addresses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_addresses_id_seq OWNED BY public.customer_addresses.id;


--
-- Name: customer_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_favorites (
    user_id integer NOT NULL,
    restaurant_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id integer NOT NULL,
    order_id integer,
    rider_id integer,
    delivery_status character varying(30) DEFAULT 'assigned'::character varying,
    delivery_time timestamp without time zone,
    recipient_note text,
    CONSTRAINT deliveries_delivery_status_check CHECK (((delivery_status)::text = ANY ((ARRAY['assigned'::character varying, 'picked_up'::character varying, 'delivered'::character varying])::text[])))
);


--
-- Name: deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deliveries_id_seq OWNED BY public.deliveries.id;


--
-- Name: menu_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_categories (
    id integer NOT NULL,
    restaurant_id integer,
    name character varying(50) NOT NULL
);


--
-- Name: menu_categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.menu_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: menu_categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.menu_categories_id_seq OWNED BY public.menu_categories.id;


--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_items (
    id integer NOT NULL,
    category_id integer,
    restaurant_id integer,
    name character varying(100) NOT NULL,
    description text,
    price numeric(10,2) NOT NULL,
    image_url character varying(255),
    is_available boolean DEFAULT true,
    is_veg boolean DEFAULT false,
    quality_flag boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    image_credit text,
    image_source_url text,
    image_is_illustrative boolean DEFAULT false NOT NULL
);


--
-- Name: menu_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.menu_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: menu_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.menu_items_id_seq OWNED BY public.menu_items.id;


--
-- Name: modifier_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_groups (
    id integer NOT NULL,
    menu_item_id integer,
    name character varying(100) NOT NULL,
    is_required boolean DEFAULT false,
    min_selection integer DEFAULT 0,
    max_selection integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: modifier_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.modifier_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: modifier_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.modifier_groups_id_seq OWNED BY public.modifier_groups.id;


--
-- Name: modifier_options; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.modifier_options (
    id integer NOT NULL,
    modifier_group_id integer,
    name character varying(100) NOT NULL,
    price_modifier numeric(10,2) DEFAULT 0.00,
    is_available boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: modifier_options_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.modifier_options_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: modifier_options_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.modifier_options_id_seq OWNED BY public.modifier_options.id;


--
-- Name: order_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_events (
    id bigint NOT NULL,
    order_id integer NOT NULL,
    status character varying(30) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: order_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_events_id_seq OWNED BY public.order_events.id;


--
-- Name: order_item_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_modifiers (
    id integer NOT NULL,
    order_item_id integer,
    modifier_option_id integer,
    name character varying(100) NOT NULL,
    price_modifier numeric(10,2) DEFAULT 0.00 NOT NULL
);


--
-- Name: order_item_modifiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_item_modifiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_item_modifiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_item_modifiers_id_seq OWNED BY public.order_item_modifiers.id;


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id integer NOT NULL,
    order_id integer,
    menu_item_id integer,
    quantity integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    special_instruction text,
    item_name character varying(100),
    image_url text,
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: order_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_items_id_seq OWNED BY public.order_items.id;


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id integer NOT NULL,
    customer_id integer,
    rider_id integer,
    branch_id integer,
    promo_code_id integer,
    delivery_address text NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    discount_amount numeric(10,2) DEFAULT 0,
    total_amount numeric(10,2) NOT NULL,
    status character varying(30) DEFAULT 'pending'::character varying,
    review_eligible boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    delivery_fee numeric(10,2) DEFAULT 0 NOT NULL,
    CONSTRAINT orders_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'preparing'::character varying, 'out_for_delivery'::character varying, 'delivered'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id integer NOT NULL,
    order_id integer,
    method character varying(20),
    amount numeric(10,2) NOT NULL,
    status character varying(20) DEFAULT 'unpaid'::character varying,
    transaction_ref character varying(100),
    paid_at timestamp without time zone,
    CONSTRAINT payments_method_check CHECK (((method)::text = ANY ((ARRAY['cash_on_delivery'::character varying, 'bkash'::character varying, 'nagad'::character varying])::text[]))),
    CONSTRAINT payments_status_check CHECK (((status)::text = ANY ((ARRAY['unpaid'::character varying, 'paid'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;


--
-- Name: promo_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_codes (
    id integer NOT NULL,
    code character varying(20) NOT NULL,
    discount_percent integer,
    min_order_amount numeric(10,2) DEFAULT 0,
    expiry_date date NOT NULL,
    is_active boolean DEFAULT true,
    usage_limit integer DEFAULT 100,
    used_count integer DEFAULT 0,
    CONSTRAINT promo_codes_discount_percent_check CHECK (((discount_percent >= 1) AND (discount_percent <= 100)))
);


--
-- Name: promo_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.promo_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: promo_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.promo_codes_id_seq OWNED BY public.promo_codes.id;


--
-- Name: quality_flag_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quality_flag_log (
    id integer NOT NULL,
    menu_item_id integer,
    order_id integer,
    flagged_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: quality_flag_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quality_flag_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quality_flag_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quality_flag_log_id_seq OWNED BY public.quality_flag_log.id;


--
-- Name: restaurant_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_branches (
    id integer NOT NULL,
    restaurant_id integer,
    address text NOT NULL,
    area character varying(100) NOT NULL,
    city character varying(100) NOT NULL,
    phone character varying(20),
    latitude numeric(9,6),
    longitude numeric(9,6),
    is_open boolean DEFAULT true,
    division character varying(20),
    delivery_fee numeric(10,2) DEFAULT 49 NOT NULL,
    min_order_amount numeric(10,2) DEFAULT 0 NOT NULL,
    eta_min integer DEFAULT 25 NOT NULL,
    eta_max integer DEFAULT 45 NOT NULL,
    CONSTRAINT restaurant_branches_check CHECK ((eta_max >= eta_min)),
    CONSTRAINT restaurant_branches_delivery_fee_check CHECK ((delivery_fee >= (0)::numeric)),
    CONSTRAINT restaurant_branches_division_check CHECK (((division)::text = ANY ((ARRAY['Dhaka'::character varying, 'Chattogram'::character varying, 'Rajshahi'::character varying, 'Khulna'::character varying, 'Barishal'::character varying, 'Sylhet'::character varying, 'Rangpur'::character varying, 'Mymensingh'::character varying])::text[]))),
    CONSTRAINT restaurant_branches_eta_min_check CHECK ((eta_min > 0)),
    CONSTRAINT restaurant_branches_min_order_amount_check CHECK ((min_order_amount >= (0)::numeric))
);


--
-- Name: restaurant_branches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.restaurant_branches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: restaurant_branches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.restaurant_branches_id_seq OWNED BY public.restaurant_branches.id;


--
-- Name: restaurant_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurant_reviews (
    id integer NOT NULL,
    order_id integer,
    rating integer,
    portion_accuracy character varying(20),
    comment text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT restaurant_reviews_portion_accuracy_check CHECK (((portion_accuracy)::text = ANY ((ARRAY['full'::character varying, 'slightly_less'::character varying, 'way_less'::character varying])::text[]))),
    CONSTRAINT restaurant_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: restaurant_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.restaurant_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: restaurant_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.restaurant_reviews_id_seq OWNED BY public.restaurant_reviews.id;


--
-- Name: restaurants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restaurants (
    id integer NOT NULL,
    owner_id integer,
    name character varying(100) NOT NULL,
    avg_rating numeric(3,2),
    review_count integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    description text,
    cuisine character varying(100) DEFAULT 'Bangladeshi'::character varying NOT NULL,
    image_url text,
    image_credit text,
    image_source_url text,
    image_is_illustrative boolean DEFAULT false NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    catalog_slug text,
    source_url text,
    verified_at timestamp with time zone,
    ordering_enabled boolean DEFAULT true NOT NULL,
    logo_url text,
    logo_source_url text,
    menu_source_url text,
    menu_scope character varying(20) DEFAULT 'branch'::character varying,
    gallery jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: restaurants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.restaurants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: restaurants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.restaurants_id_seq OWNED BY public.restaurants.id;


--
-- Name: revoked_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revoked_tokens (
    id integer NOT NULL,
    user_id integer,
    jti character varying(255) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    revoked_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: revoked_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.revoked_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: revoked_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.revoked_tokens_id_seq OWNED BY public.revoked_tokens.id;


--
-- Name: rider_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rider_profiles (
    id integer NOT NULL,
    user_id integer,
    vehicle_type character varying(20),
    status character varying(20) DEFAULT 'offline'::character varying,
    CONSTRAINT rider_profiles_status_check CHECK (((status)::text = ANY ((ARRAY['online'::character varying, 'offline'::character varying, 'busy'::character varying])::text[]))),
    CONSTRAINT rider_profiles_vehicle_type_check CHECK (((vehicle_type)::text = ANY ((ARRAY['bicycle'::character varying, 'motorcycle'::character varying, 'car'::character varying])::text[])))
);


--
-- Name: rider_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rider_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rider_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rider_profiles_id_seq OWNED BY public.rider_profiles.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    order_id integer,
    subject character varying(120) NOT NULL,
    message text NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    admin_reply text,
    resolved_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_tickets_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: support_tickets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_tickets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_tickets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_tickets_id_seq OWNED BY public.support_tickets.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(100) NOT NULL,
    password character varying(255) NOT NULL,
    role character varying(20) NOT NULL,
    phone character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['customer'::character varying, 'restaurant_owner'::character varying, 'rider'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: cart_item_modifiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_item_modifiers ALTER COLUMN id SET DEFAULT nextval('public.cart_item_modifiers_id_seq'::regclass);


--
-- Name: cart_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items ALTER COLUMN id SET DEFAULT nextval('public.cart_items_id_seq'::regclass);


--
-- Name: carts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts ALTER COLUMN id SET DEFAULT nextval('public.carts_id_seq'::regclass);


--
-- Name: customer_addresses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses ALTER COLUMN id SET DEFAULT nextval('public.customer_addresses_id_seq'::regclass);


--
-- Name: deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries ALTER COLUMN id SET DEFAULT nextval('public.deliveries_id_seq'::regclass);


--
-- Name: menu_categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories ALTER COLUMN id SET DEFAULT nextval('public.menu_categories_id_seq'::regclass);


--
-- Name: menu_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items ALTER COLUMN id SET DEFAULT nextval('public.menu_items_id_seq'::regclass);


--
-- Name: modifier_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups ALTER COLUMN id SET DEFAULT nextval('public.modifier_groups_id_seq'::regclass);


--
-- Name: modifier_options id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options ALTER COLUMN id SET DEFAULT nextval('public.modifier_options_id_seq'::regclass);


--
-- Name: order_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events ALTER COLUMN id SET DEFAULT nextval('public.order_events_id_seq'::regclass);


--
-- Name: order_item_modifiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers ALTER COLUMN id SET DEFAULT nextval('public.order_item_modifiers_id_seq'::regclass);


--
-- Name: order_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items ALTER COLUMN id SET DEFAULT nextval('public.order_items_id_seq'::regclass);


--
-- Name: orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);


--
-- Name: payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);


--
-- Name: promo_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes ALTER COLUMN id SET DEFAULT nextval('public.promo_codes_id_seq'::regclass);


--
-- Name: quality_flag_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_flag_log ALTER COLUMN id SET DEFAULT nextval('public.quality_flag_log_id_seq'::regclass);


--
-- Name: restaurant_branches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_branches ALTER COLUMN id SET DEFAULT nextval('public.restaurant_branches_id_seq'::regclass);


--
-- Name: restaurant_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_reviews ALTER COLUMN id SET DEFAULT nextval('public.restaurant_reviews_id_seq'::regclass);


--
-- Name: restaurants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants ALTER COLUMN id SET DEFAULT nextval('public.restaurants_id_seq'::regclass);


--
-- Name: revoked_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revoked_tokens ALTER COLUMN id SET DEFAULT nextval('public.revoked_tokens_id_seq'::regclass);


--
-- Name: rider_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_profiles ALTER COLUMN id SET DEFAULT nextval('public.rider_profiles_id_seq'::regclass);


--
-- Name: support_tickets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets ALTER COLUMN id SET DEFAULT nextval('public.support_tickets_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: cart_item_modifiers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cart_item_modifiers (id, cart_item_id, modifier_option_id) FROM stdin;
\.


--
-- Data for Name: cart_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cart_items (id, cart_id, menu_item_id, quantity, created_at) FROM stdin;
29	18	113	1	2026-09-10 06:22:13.501078
\.


--
-- Data for Name: carts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.carts (id, user_id, restaurant_id, created_at, updated_at) FROM stdin;
1	10	4	2026-09-09 21:35:49.641944	2026-09-09 21:36:15.361649
26	10	7	2026-09-10 00:52:12.203782	2026-09-14 23:48:49.695678
24	10	6	2026-09-10 00:26:46.600405	2026-09-10 00:27:03.099758
25	10	9	2026-09-10 00:48:40.307668	2026-09-10 00:49:04.479296
18	10	8	2026-09-10 00:16:43.557844	2026-09-10 06:22:13.501078
\.


--
-- Data for Name: customer_addresses; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customer_addresses (id, user_id, label, area, full_address, is_default, division, city, phone, latitude, longitude) FROM stdin;
1	10	Home	Khilgaon	347,South Goran,Road-36,Khilgaon,Dhaka	t	Dhaka	Khilgaon	01711137457	\N	\N
\.


--
-- Data for Name: customer_favorites; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.customer_favorites (user_id, restaurant_id, created_at) FROM stdin;
\.


--
-- Data for Name: deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.deliveries (id, order_id, rider_id, delivery_status, delivery_time, recipient_note) FROM stdin;
3	17	12	delivered	2026-09-10 00:47:15.460564	\N
4	19	12	delivered	2026-09-10 00:55:11.856176	\N
5	20	12	delivered	2026-09-10 01:15:28.074227	\N
7	23	12	delivered	2026-09-10 23:50:35.522611	\N
8	22	12	delivered	2026-09-10 23:50:39.437843	\N
9	24	12	delivered	2026-09-11 09:46:28.720388	\N
10	25	12	delivered	2026-09-12 23:03:56.476193	\N
11	26	12	delivered	2026-09-14 23:50:42.010767	\N
\.


--
-- Data for Name: menu_categories; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.menu_categories (id, restaurant_id, name) FROM stdin;
1	1	Biryani & Rice
2	1	Curries
3	1	Drinks
4	2	Pizzas
5	2	Sides
6	3	Noodles & Rice
7	3	From the Wok
8	3	Soups
9	4	Burgers
10	4	Fries & Shakes
11	5	Bowls
12	5	Cold Press
13	6	Published brand menu
14	7	Beverages
15	7	Box Master
16	7	Box Meals
17	7	Burgers
18	7	Chicken
19	7	Dips
20	7	Snacks
21	7	Wraps
22	8	FRIED CHICKEN
23	8	CHICKEN WINGS
24	8	CHICKEN DELIGHT
25	8	CHICKEN BURGER
26	8	RICE ITEMS
27	8	RICE MEAL
28	8	SIDE MENU
29	8	CHICKEN COMBO
30	8	BURGER COMBO
31	8	NEW BURGER COMBO
32	8	SPECIAL MEAL
33	8	MEGA FEAST
34	8	BEVERAGE
35	8	Chicken Wrap
36	8	Combos
37	9	Chicken Fry 🆕 ⭐⭐
38	9	🆕 Rice Bowls 🍚 
39	9	Beef Burgers
40	9	Chicken Burgers
41	9	Pankha Wings 
42	9	Sides
43	9	Naga Drums
44	9	Desserts
45	9	Fish Section
46	9	CRISPER- BURGERS 🆕 ⭐⭐
47	9	SMASHER Burgers
48	9	Shakes
49	9	WA WA
50	6	Kitchen favourites (demo additions)
51	10	Kacchi & Rice
52	10	Sides & Sweets
53	11	From the Tandoor
54	11	Rice & Sides
55	12	Pizzas
56	12	Sides & Desserts
57	13	Burgers & Wraps
58	13	Sides & Shakes
59	14	Buckets & Chicken
60	14	Sides
\.


--
-- Data for Name: menu_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.menu_items (id, category_id, restaurant_id, name, description, price, image_url, is_available, is_veg, quality_flag, created_at, image_credit, image_source_url, image_is_illustrative) FROM stdin;
233	50	6	Mutton Kacchi (1 person)	Added for the Cravio demonstration; not from the published brand menu.	420.00	/media/biryani.jpg	t	f	f	2026-09-10 00:24:25.011091	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
234	50	6	Beef Tehari (1 person)	Added for the Cravio demonstration; not from the published brand menu.	260.00	/media/biryani.jpg	t	f	f	2026-09-10 00:24:25.011091	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
235	50	6	Morog Polao (1 person)	Added for the Cravio demonstration; not from the published brand menu.	280.00	/media/biryani.jpg	t	f	f	2026-09-10 00:24:25.011091	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
236	50	6	Shahi Jorda (1 person)	Added for the Cravio demonstration; not from the published brand menu.	120.00	/media/biryani.jpg	t	f	f	2026-09-10 00:24:25.011091	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
237	50	6	Jali Kabab (2 pieces)	Added for the Cravio demonstration; not from the published brand menu.	160.00	/media/curry.jpg	t	f	f	2026-09-10 00:24:25.011091	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
238	50	6	Chicken Chaap (1 piece)	Added for the Cravio demonstration; not from the published brand menu.	190.00	/media/curry.jpg	t	f	f	2026-09-10 00:24:25.011091	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
239	50	6	Mango Lassi (250ml)	Added for the Cravio demonstration; not from the published brand menu.	120.00	/media/tea.jpg	t	f	f	2026-09-10 00:24:25.011091	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
240	50	6	Zafrani Borhani (500ml)	Added for the Cravio demonstration; not from the published brand menu.	150.00	/media/tea.jpg	t	f	f	2026-09-10 00:24:25.011091	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
241	50	6	Mineral Water (500ml)	Added for the Cravio demonstration; not from the published brand menu.	20.00	/media/tea.jpg	t	f	f	2026-09-10 00:24:25.011091	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
242	50	6	Salad & Achar	Added for the Cravio demonstration; not from the published brand menu.	60.00	/media/salad.jpg	t	t	f	2026-09-10 00:24:25.011091	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
44	14	7	7 UP	Published national menu price; branch availability, options and taxes must be checked with KFC.	50.00	/media/official-KFC-423e85f6b86c.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/beverages	f
49	16	7	Hot Wings Box	Published national menu price; branch availability, options and taxes must be checked with KFC.	419.00	/media/official-KFC-33dac08da119.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/box-meals	f
38	13	6	Basmati Kacchi (1 person)	Published single-portion price; may vary by branch.	330.00	/media/official-Kacchi-Bhai-1d36780a3be8.avif	t	f	f	2026-09-10 00:00:29.719907	Kacchi-Bhai · official website	https://www.kacchibhai.com/	f
39	13	6	Borhani (1 person)	Published single-portion price; may vary by branch.	80.00	/media/official-Kacchi-Bhai-ed371059405c.avif	t	f	f	2026-09-10 00:00:29.719907	Kacchi-Bhai · official website	https://www.kacchibhai.com/	f
40	13	6	Firni (1 person)	Published single-portion price; may vary by branch.	70.00	/media/official-Kacchi-Bhai-45aff9e82b5a.avif	t	f	f	2026-09-10 00:00:29.719907	Kacchi-Bhai · official website	https://www.kacchibhai.com/	f
41	13	6	Chicken Roast (1 person)	Published single-portion price; may vary by branch.	150.00	/media/official-Kacchi-Bhai-e74386108b9b.avif	t	f	f	2026-09-10 00:00:29.719907	Kacchi-Bhai · official website	https://www.kacchibhai.com/	f
42	14	7	Pepsi	Published national menu price; branch availability, options and taxes must be checked with KFC.	50.00	/media/official-KFC-ab20418d16a7.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/beverages	f
43	14	7	Mountain Dew	Published national menu price; branch availability, options and taxes must be checked with KFC.	50.00	/media/official-KFC-c89876cffa0e.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/beverages	f
45	14	7	Aquafina Water	Published national menu price; branch availability, options and taxes must be checked with KFC.	20.00	/media/official-KFC-98fd2d332fb4.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/beverages	f
46	15	7	Box Master	Published national menu price; branch availability, options and taxes must be checked with KFC.	399.00	/media/official-KFC-454bda6881df.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/box-master	f
47	16	7	Zinger Box	Published national menu price; branch availability, options and taxes must be checked with KFC.	529.00	/media/official-KFC-507f904c903d.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/box-meals	f
48	16	7	Super Charger Box	Published national menu price; branch availability, options and taxes must be checked with KFC.	499.00	/media/official-KFC-d5622bf4e5fd.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/box-meals	f
50	16	7	Strips Box	Published national menu price; branch availability, options and taxes must be checked with KFC.	419.00	/media/official-KFC-de13e6b6735a.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/box-meals	f
51	16	7	Rice Box	Published national menu price; branch availability, options and taxes must be checked with KFC.	319.00	/media/official-KFC-9cc6bccddd1e.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/box-meals	f
52	17	7	2 Classic Zinger Meal	Published national menu price; branch availability, options and taxes must be checked with KFC.	999.00	/media/official-KFC-789fac7e6c02.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
53	17	7	Mixed Zinger Doubles	Published national menu price; branch availability, options and taxes must be checked with KFC.	799.00	/media/official-KFC-e246576179a8.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
54	17	7	Spicy Zinger with Cheese	Published national menu price; branch availability, options and taxes must be checked with KFC.	404.00	/media/official-KFC-e0fd85c522fe.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
55	17	7	Classic Zinger with Cheese	Published national menu price; branch availability, options and taxes must be checked with KFC.	384.00	/media/official-KFC-618c0304de87.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
56	17	7	Spicy Zinger	Published national menu price; branch availability, options and taxes must be checked with KFC.	359.00	/media/official-KFC-22fce148e701.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
57	17	7	Classic Zinger	Published national menu price; branch availability, options and taxes must be checked with KFC.	339.00	/media/official-KFC-bcedd326a429.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
58	17	7	Super Charger Burger	Published national menu price; branch availability, options and taxes must be checked with KFC.	309.00	/media/official-KFC-bffbbf91542b.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/burgers	f
59	18	7	12pc + 6pc Free Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	1799.00	/media/official-KFC-6ac0d9544dba.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
60	18	7	10pc + 5pc Free Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	1499.00	/media/official-KFC-f85cda7017c8.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
61	18	7	Curry Crunch – 2 pcs	Published national menu price; branch availability, options and taxes must be checked with KFC.	349.00	/media/official-KFC-3dc84b437a95.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
62	18	7	8pc + 4pc Free Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	1299.00	/media/official-KFC-b23981b4a9db.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
63	18	7	Curry Crunch – 4 pcs	Published national menu price; branch availability, options and taxes must be checked with KFC.	669.00	/media/official-KFC-20610def6fb8.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
64	18	7	Curry Crunch Meal	Published national menu price; branch availability, options and taxes must be checked with KFC.	699.00	/media/official-KFC-032769cbbb13.jpeg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
65	18	7	Curry Crunch – 8 pcs	Published national menu price; branch availability, options and taxes must be checked with KFC.	1319.00	/media/official-KFC-3795382f00e4.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
66	18	7	Curry Crunch – 12 pcs	Published national menu price; branch availability, options and taxes must be checked with KFC.	1919.00	/media/official-KFC-9497cfc35842.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
67	18	7	12 pcs Smoky Red Chicken Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	1799.00	/media/official-KFC-b8add1d88e54.png	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
68	18	7	10 Pc Leg Bucket Meal	Published national menu price; branch availability, options and taxes must be checked with KFC.	1699.00	/media/official-KFC-441b7a5bab65.jpeg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
69	18	7	10 Pc Leg  Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	1249.00	/media/official-KFC-26935443aef1.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
70	18	7	8 PC Hot & Crispy Chicken Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	1299.00	/media/official-KFC-c916ec0f3c12.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
71	18	7	5pc Leg  Bucket Meal	Published national menu price; branch availability, options and taxes must be checked with KFC.	849.00	/media/official-KFC-904e33801de2.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
72	18	7	4 Pc Chicken & Fries Meal	Published national menu price; branch availability, options and taxes must be checked with KFC.	869.00	/media/official-KFC-20500704b446.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
73	18	7	5 pc Leg  Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	699.00	/media/official-KFC-2c89777fa5f7.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
74	18	7	2 PC Hot & Crispy Chicken	Published national menu price; branch availability, options and taxes must be checked with KFC.	329.00	/media/official-KFC-adb07a0980e5.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/chicken	f
75	19	7	Masala Salsa	Published national menu price; branch availability, options and taxes must be checked with KFC.	29.00	/media/official-KFC-5db674c6dbf3.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/dips	f
76	19	7	Spicy Mayo	Published national menu price; branch availability, options and taxes must be checked with KFC.	29.00	/media/official-KFC-95001ea2b3b9.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/dips	f
77	19	7	Mayonnaise	Published national menu price; branch availability, options and taxes must be checked with KFC.	29.00	/media/official-KFC-d062eb43b17f.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/dips	f
78	19	7	Nashville Sauce	Published national menu price; branch availability, options and taxes must be checked with KFC.	29.00	/media/official-KFC-a8b8f05b5e67.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/dips	f
79	20	7	Dips Bucket	Published national menu price; branch availability, options and taxes must be checked with KFC.	849.00	/media/official-KFC-692b6310d4d9.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
80	20	7	4 PC Hot & Crispy Chicken	Published national menu price; branch availability, options and taxes must be checked with KFC.	629.00	/media/official-KFC-b135f727ae42.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
81	20	7	4 pcs Smoky Red Chicken	Published national menu price; branch availability, options and taxes must be checked with KFC.	629.00	/media/official-KFC-f5ced7da8b69.png	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
82	20	7	6 PC Boneless Strips	Published national menu price; branch availability, options and taxes must be checked with KFC.	529.00	/media/official-KFC-e0d02f95bab9.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
83	20	7	6 PC Hot Wings	Published national menu price; branch availability, options and taxes must be checked with KFC.	329.00	/media/official-KFC-794f95d6d8ac.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
84	20	7	2 pcs Smoky Red Chicken	Published national menu price; branch availability, options and taxes must be checked with KFC.	329.00	/media/official-KFC-c86f75e9de26.png	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
85	20	7	Chicken Popcorn Large	Published national menu price; branch availability, options and taxes must be checked with KFC.	299.00	/media/official-KFC-29be204668e4.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
86	20	7	3 Pc Boneless Chicken Strips	Published national menu price; branch availability, options and taxes must be checked with KFC.	279.00	/media/official-KFC-85998d5f323a.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
87	20	7	Chicken Popcorn Medium	Published national menu price; branch availability, options and taxes must be checked with KFC.	239.00	/media/official-KFC-23f5dfa332e0.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
88	20	7	Fries  - Large	Published national menu price; branch availability, options and taxes must be checked with KFC.	199.00	/media/official-KFC-46f1255a8134.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
89	20	7	Potato Wedges	Published national menu price; branch availability, options and taxes must be checked with KFC.	189.00	/media/official-KFC-899663dc1e8a.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
90	20	7	1 pc Hot & Crispy	Published national menu price; branch availability, options and taxes must be checked with KFC.	179.00	/media/official-KFC-1eaa305ee72a.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
91	20	7	Fries  - Medium	Published national menu price; branch availability, options and taxes must be checked with KFC.	179.00	/media/official-KFC-c7a4b17ad2de.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
92	20	7	3 PC Hot Wings	Published national menu price; branch availability, options and taxes must be checked with KFC.	179.00	/media/official-KFC-d802b8e271bd.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
93	20	7	Rizo Rice	Published national menu price; branch availability, options and taxes must be checked with KFC.	129.00	/media/official-KFC-4e4fcad271e3.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/snacks	f
94	21	7	Toasted Twister	Published national menu price; branch availability, options and taxes must be checked with KFC.	359.00	/media/official-KFC-aea9bccbe9d4.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/wraps	f
95	21	7	Toasted Twister Box	Published national menu price; branch availability, options and taxes must be checked with KFC.	529.00	/media/official-KFC-799366419b45.jpg	t	f	f	2026-09-10 00:00:29.719907	KFC · official website	https://kfcbd.com/menu/wraps	f
96	22	8	FRIED CHICKEN	Published price for 1 pc Fried Chicken. Check the official menu for options and current availability.	140.00	/media/official-bfc-08f2c38f0cf4.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
97	22	8	Naga Fried Chicken	Published price for 1 pc Fried Chicken. Check the official menu for options and current availability.	145.00	/media/official-bfc-ad928749397b.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
98	23	8	HOT WING	Published price for 4 pcs. Check the official menu for options and current availability.	130.00	/media/official-bfc-5f9aecd68b23.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
100	23	8	BBQ HOT WINGS	Published price for 4 pcs. Check the official menu for options and current availability.	140.00	/media/official-bfc-eb5be0e1676f.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
243	51	10	Kacchi Biryani (Full)	Mutton kacchi layered with basmati rice, potato and aloo bukhara.	450.00	/media/dish-kacchi-biryani.jpg	t	f	f	2026-09-10 02:46:03.073202	Nahian / Wikimedia Commons (CC BY 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg	t
244	51	10	Kacchi Biryani (Half)	A single-portion plate of the same kacchi.	280.00	/media/dish-kacchi-biryani.jpg	t	f	f	2026-09-10 02:46:03.073202	Nahian / Wikimedia Commons (CC BY 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg	t
245	51	10	Morog Polao	Fragrant chicken polao with a boiled egg.	320.00	/media/dish-morog-polao.jpg	t	f	f	2026-09-10 02:46:03.073202	Great Hero32 / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Morog_Polao_3.jpg	t
104	24	8	CRISPY STRIPS	Published price for 3 pcs. Check the official menu for options and current availability.	160.00	/media/official-bfc-ec13a22e41dd.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
246	51	10	Beef Tehari	Spiced short-grain rice cooked through with beef.	300.00	/media/dish-beef-tehari.jpg	t	f	f	2026-09-10 02:46:03.073202	Riaz / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Tehari_(2).jpg	t
106	24	8	NUGGETS	Published price for 6 pieces. Check the official menu for options and current availability.	145.00	/media/official-bfc-e4e4d5f2d048.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
247	52	10	Chicken Roast	Slow-cooked roast leg in a sweet-savoury gravy.	190.00	/media/dish-chicken-roast.jpg	t	f	f	2026-09-10 02:46:03.073202	safaritravelplus / Wikimedia Commons (CC0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Roast_Chicken_Hot_Plate.jpg	t
99	23	8	Naga Wings	Published price for 4pcs. Check the official menu for options and current availability.	145.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
108	25	8	BEST BURGER	Published price. Check the official menu for options and current availability.	275.00	/media/official-bfc-9e342679fbae.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
109	25	8	BEST BURGER WITH CHEESE (Super)	Published price. Check the official menu for options and current availability.	305.00	/media/official-bfc-2935fc554b51.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
110	25	8	SPICY BURGER	Published price for regular. Check the official menu for options and current availability.	210.00	/media/official-bfc-eef41ce69c59.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
111	25	8	SPICY BURGER WITH CHEESE	Published price. Check the official menu for options and current availability.	305.00	/media/official-bfc-c37ca7d6e7c0.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
112	25	8	SUPREME BURGER	Published price. Check the official menu for options and current availability.	295.00	/media/official-bfc-7509de0aa471.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
113	25	8	SUPREME CHEESE BURGER	Published price. Check the official menu for options and current availability.	325.00	/media/official-bfc-0de1ddd6e688.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
248	52	10	Jali Kabab	Two lattice-fried minced beef kababs.	150.00	/media/dish-jali-kabab.jpg	t	f	f	2026-09-10 02:46:03.073202	Murcotipton / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:4th_October_2012_Shami_Kebab.jpg	t
249	52	10	Borhani	Chilled spiced yoghurt drink.	90.00	/media/dish-borhani.jpg	t	f	f	2026-09-10 02:46:03.073202	DarkSpartan / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:A_Glass_of_Borhani.jpg	t
250	52	10	Firni	Ground-rice pudding set in a clay bowl.	80.00	/media/dish-firni.jpg	t	f	f	2026-09-10 02:46:03.073202	Anwesha394 / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Phirni_at_Cool_Point,_Chandni_Chawk.jpg	t
118	25	8	JUICY BURGER	Published price for regular. Check the official menu for options and current availability.	195.00	/media/official-bfc-10916afe2bf2.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
119	25	8	JUICY BURGER WITH CHEESE	Published price. Check the official menu for options and current availability.	225.00	/media/official-bfc-56564d6ebe5a.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
120	25	8	GRILL BURGER	Published price for Regular . Check the official menu for options and current availability.	210.00	/media/official-bfc-70407aca73bd.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da2f3b3a3883d5d064bf3/delivery	f
121	25	8	GRILL BURGER WITH CHEESE	Published price. Check the official menu for options and current availability.	310.00	/media/official-bfc-9bfd3aa13421.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da2f3b3a3883d5d064bf3/delivery	f
251	53	11	Butter Chicken	Tandoori chicken finished in a tomato and cream gravy.	380.00	/media/dish-butter-chicken.jpg	t	f	f	2026-09-10 02:46:03.073202	stu_spivack / Wikimedia Commons (CC BY-SA 2.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Chicken_makhani.jpg	t
252	53	11	Seekh Kebab	Minced meat skewers grilled over charcoal.	260.00	/media/dish-seekh-kebab.jpg	t	f	f	2026-09-10 02:46:03.073202	raasiel / Wikimedia Commons (CC BY 2.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Seekh_Kebab.JPG	t
253	53	11	Butter Naan	Tandoor-baked flatbread brushed with butter.	60.00	/media/dish-naan.jpg	t	t	f	2026-09-10 02:46:03.073202	Ravi Dwivedi / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Naan_baked_in_Tandoor.jpg	t
254	54	11	Chicken Biryani	Long-grain biryani layered with marinated chicken.	340.00	/media/dish-chicken-biryani.jpg	t	f	f	2026-09-10 02:46:03.073202	Dheerajk88 / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Chicken_Hyderabadi_Biryani.JPG	t
255	54	11	Mango Lassi	Thick sweet yoghurt drink blended with mango.	130.00	/media/dish-lassi.jpg	t	t	f	2026-09-10 02:46:03.073202	Andy Li / Wikimedia Commons (CC0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Mango_Lassi_and_Butter_Milk_-_Vel_South_Indian_Kitchen_%2B_Bar.jpg	t
256	54	11	Garden Salad	Cucumber, tomato, onion and lemon.	110.00	/media/dish-salad.jpg	t	t	f	2026-09-10 02:46:03.073202	fir0002 flagstaffotos [at] gmail.com Canon 20D + Canon 17-40mm f/4 L / Wikimedia Commons (GFDL 1.2) · illustrative photo	https://commons.wikimedia.org/wiki/File:Salad_platter.jpg	t
257	55	12	Margherita (Medium)	Tomato sauce, mozzarella and basil.	550.00	/media/dish-margherita.jpg	t	t	f	2026-09-10 02:46:03.073202	Mario56 / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Margherita_Originale.JPG	t
258	55	12	Pepperoni (Medium)	Double pepperoni over mozzarella.	690.00	/media/dish-pepperoni.jpg	t	f	f	2026-09-10 02:46:03.073202	Petar Milošević / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Vegetarian_Pizza.jpg	t
259	56	12	Garlic Bread	Oven-baked bread with garlic butter.	220.00	/media/dish-garlic-bread.jpg	t	t	f	2026-09-10 02:46:03.073202	Infrogmation / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Garlic_bread_baguettes_2.jpg	t
131	28	8	FRENCH FRIES	Published price for Regular . Check the official menu for options and current availability.	115.00	/media/official-bfc-feb702ab5997.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
132	28	8	MASALA / GARLIC FRIES	Published price for Regular . Check the official menu for options and current availability.	125.00	/media/official-bfc-038b50059dfe.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
133	28	8	POTATO WEDGES	Published price. Check the official menu for options and current availability.	95.00	/media/official-bfc-df19bd9a26eb.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
260	56	12	Chicken Wings (6 pcs)	Oven-baked wings tossed in hot sauce.	320.00	/media/dish-chicken-wings.jpg	t	f	f	2026-09-10 02:46:03.073202	stef yau / Wikimedia Commons (CC BY 2.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Homemade_buffalo_wings.jpg	t
114	25	8	Garlic Burger Regular	Published price. Check the official menu for options and current availability.	220.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
134	28	8	COLESLAW	Published price for Regular . Check the official menu for options and current availability.	75.00	/media/official-bfc-5af6fca43291.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
135	28	8	Extra Cheese	Published price. Check the official menu for options and current availability.	30.00	\N	t	f	f	2026-09-10 00:00:29.719907	\N	\N	f
261	56	12	Choco Brownie	Warm fudge brownie.	180.00	/media/dish-brownie.jpg	t	t	f	2026-09-10 02:46:03.073202	JefferySAC / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Chocolate-brownie-hachatw.jpg	t
137	28	8	BBQ DIP	Published price. Check the official menu for options and current availability.	30.00	\N	t	f	f	2026-09-10 00:00:29.719907	\N	\N	f
138	28	8	DIP	Published price for Garlic. Check the official menu for options and current availability.	20.00	\N	t	f	f	2026-09-10 00:00:29.719907	\N	\N	f
139	28	8	Delivery charge	Published price. Check the official menu for options and current availability.	60.00	\N	t	f	f	2026-09-10 00:00:29.719907	\N	\N	f
262	56	12	Soft Drink (500ml)	Chilled bottle.	60.00	/media/dish-soft-drink.jpg	t	t	f	2026-09-10 02:46:03.073202	Tomascastelazo / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Coca_Cola_-_Mexican_death_sentence.jpg	t
263	57	13	Classic Beef Burger	Smashed beef patty, cheddar, pickles and house sauce.	380.00	/media/dish-burger.jpg	t	f	f	2026-09-10 02:46:03.073202	Acabashi / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Cheeseburger_with_onions_at_Hatfield_Heath_Festival_2017.jpg	t
264	57	13	Crispy Chicken Burger	Buttermilk-fried chicken thigh in a brioche bun.	340.00	/media/dish-chicken-burger.jpg	t	f	f	2026-09-10 02:46:03.073202	BrokenSphere / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:BK_Original_Chicken_Sandwich.JPG	t
265	57	13	Chicken Wrap	Grilled chicken, salad and garlic mayo in a warm tortilla.	290.00	/media/dish-wrap.jpg	t	f	f	2026-09-10 02:46:03.073202	Kembangraps / Wikimedia Commons (CC0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Garang_asem_Pj.JPG	t
266	58	13	Loaded Fries	Fries under melted cheese and jalapeños.	190.00	/media/dish-fries.jpg	t	t	f	2026-09-10 02:46:03.073202	Chris Woodrich / Wikimedia Commons (Public domain) · illustrative photo	https://commons.wikimedia.org/wiki/File:McDonald%27s_French_Fries,_Canada,_2026-04-04.jpg	t
267	58	13	Chicken Nuggets (6 pcs)	Crispy nuggets with a dip.	210.00	/media/dish-nuggets.jpg	t	f	f	2026-09-10 02:46:03.073202	Mx. Granger / Wikimedia Commons (CC0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Impossible_chicken_nuggets_2.jpg	t
268	58	13	Chocolate Milkshake	Thick shake blended with chocolate.	220.00	/media/dish-milkshake.jpg	t	t	f	2026-09-10 02:46:03.073202	Vyacheslav Argenberg / Wikimedia Commons (CC BY 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:San_Vicente,_Milkshake,_Palawan,_Philippines.jpg	t
269	59	14	Chicken Bucket (8 pcs)	Eight pieces of crispy fried chicken to share.	890.00	/media/dish-chicken-bucket.jpg	t	f	f	2026-09-10 02:46:03.073202	Biswarup Ganguly / Wikimedia Commons (CC BY 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:KFC_-_Pressure-fried_Chicken_-_Howrah_2014-03-23_9718.JPG	t
270	59	14	Fried Chicken (2 pcs)	Two pieces with a side of fries.	260.00	/media/dish-fried-chicken.jpg	t	f	f	2026-09-10 02:46:03.073202	Evan-Amos / Wikimedia Commons (CC0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Fried-Chicken-Set.jpg	t
271	59	14	Hot Wings (6 pcs)	Six wings tossed in hot sauce.	300.00	/media/dish-chicken-wings.jpg	t	f	f	2026-09-10 02:46:03.073202	stef yau / Wikimedia Commons (CC BY 2.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Homemade_buffalo_wings.jpg	t
272	59	14	Crispy Burger	Fried chicken fillet burger with slaw.	320.00	/media/dish-chicken-burger.jpg	t	f	f	2026-09-10 02:46:03.073202	BrokenSphere / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:BK_Original_Chicken_Sandwich.JPG	t
273	60	14	French Fries	Salted fries, regular size.	150.00	/media/dish-fries.jpg	t	t	f	2026-09-10 02:46:03.073202	Chris Woodrich / Wikimedia Commons (Public domain) · illustrative photo	https://commons.wikimedia.org/wiki/File:McDonald%27s_French_Fries,_Canada,_2026-04-04.jpg	t
274	60	14	Coleslaw	Creamy cabbage and carrot slaw.	90.00	/media/dish-coleslaw.jpg	t	t	f	2026-09-10 02:46:03.073202	Wikimedia Commons contributor / Wikimedia Commons (CC BY-SA 2.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Bowl%27o%27Coleslaw_modified.jpg	t
156	32	8	Special Meal-1	Published price. Check the official menu for options and current availability.	260.00	/media/official-bfc-55d34e41b591.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
157	32	8	Special Meal-2	Published price. Check the official menu for options and current availability.	290.00	/media/official-bfc-f00868bc3865.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
158	32	8	Special Meal-3	Published price. Check the official menu for options and current availability.	355.00	/media/official-bfc-fe2698a2a0fb.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
160	34	8	Pepsi n Otherrs	Published price for Regular (250 ml). Check the official menu for options and current availability.	65.00	/media/official-bfc-223bd60dbad4.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
163	34	8	Aquafina	Published price. Check the official menu for options and current availability.	20.00	/media/official-bfc-eab286b19e5a.jpeg	t	f	f	2026-09-10 00:00:29.719907	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f
275	18	7	Fried Chicken	\N	200.00	\N	t	f	f	2026-09-14 23:46:40.173846	\N	\N	f
168	37	9	Chicken Fry (1Pc) 🍗🆕	Published price. Check the official menu for options and current availability.	135.00	/media/official-chillox-53986b2d388e.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
169	37	9	Chicken Fry (2Pcs) 🍗🆕	Published price. Check the official menu for options and current availability.	260.00	/media/official-chillox-c9c58f4ed617.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
170	37	9	Chicken Fry (4Pcs) 🍗🆕	Published price. Check the official menu for options and current availability.	515.00	/media/official-chillox-d3a3d77f55d3.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
171	37	9	Chicken Fry (6Pcs) 🍗🆕	Published price. Check the official menu for options and current availability.	780.00	/media/official-chillox-0cce59f1da7a.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
172	38	9	Crispy Chicken Rice 🍗🆕	Published price. Check the official menu for options and current availability.	325.00	/media/official-chillox-e44e628e6a29.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
173	38	9	Pan Asian Mashup 🌶️	Published price. Check the official menu for options and current availability.	325.00	/media/official-chillox-352bfc82a15b.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
174	38	9	Continental Fusion	Published price. Check the official menu for options and current availability.	325.00	/media/official-chillox-b081d38324a6.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
175	39	9	Beef burger	Published price. Check the official menu for options and current availability.	235.00	/media/official-chillox-cea03b27aefb.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
176	39	9	Beef cheese burger	Published price. Check the official menu for options and current availability.	270.00	/media/official-chillox-e19f04103e6f.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
177	39	9	Smoky bbq cheese -beef	Published price. Check the official menu for options and current availability.	295.00	/media/official-chillox-159e2f7fc8f4.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
178	39	9	Beef with bacon	Published price. Check the official menu for options and current availability.	295.00	/media/official-chillox-b8ef64c7c5f1.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
179	39	9	Beef with sausage	Published price. Check the official menu for options and current availability.	320.00	/media/official-chillox-907c760d1f4f.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
180	39	9	Double Decker Beef	Published price. Check the official menu for options and current availability.	395.00	/media/official-chillox-f0f180b62b05.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
181	39	9	Beef cheese blast	Published price. Check the official menu for options and current availability.	425.00	/media/official-chillox-dcba5d691b07.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
182	39	9	Beef signature	Published price. Check the official menu for options and current availability.	495.00	/media/official-chillox-7012d1e06f65.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
183	39	9	Giganto Beef	Published price. Check the official menu for options and current availability.	595.00	/media/official-chillox-0a725730c96b.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
184	40	9	Chicken burger	Published price. Check the official menu for options and current availability.	235.00	/media/official-chillox-86bfde66d998.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
185	40	9	Chicken cheese burger	Published price. Check the official menu for options and current availability.	270.00	/media/official-chillox-f9127c743281.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
186	40	9	Smoky BBQ Cheese - Chicken	Published price. Check the official menu for options and current availability.	295.00	/media/official-chillox-3ce8076241c5.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
187	40	9	Chicken with bacon	Published price. Check the official menu for options and current availability.	295.00	/media/official-chillox-cf5539785db0.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
188	40	9	Chicken with sausage	Published price. Check the official menu for options and current availability.	320.00	/media/official-chillox-db110cc2ab5a.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
189	40	9	Double Decker Chicken	Published price. Check the official menu for options and current availability.	395.00	/media/official-chillox-2553f76ca571.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
190	40	9	Chicken cheese blast	Published price. Check the official menu for options and current availability.	425.00	/media/official-chillox-aa86293ac680.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
191	40	9	Chicken Signature	Published price. Check the official menu for options and current availability.	495.00	/media/official-chillox-19676c282815.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
192	40	9	Giganto Chicken	Published price. Check the official menu for options and current availability.	595.00	/media/official-chillox-0d652dc745e3.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
193	41	9	Pankha Wings 6 pcs	Published price. Check the official menu for options and current availability.	270.00	/media/official-chillox-791715b86e20.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
194	42	9	French Fries	Published price for Small. Check the official menu for options and current availability.	80.00	/media/official-chillox-df03905d70f1.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
195	42	9	Chicken Fingers	Published price for 5 Pcs. Check the official menu for options and current availability.	195.00	/media/official-chillox-09a6531ec816.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
196	42	9	Potato Wedges  🆕	Published price. Check the official menu for options and current availability.	175.00	/media/official-chillox-f8bb58edfe60.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
197	43	9	Naga Drums	Published price for 1 Pcs. Check the official menu for options and current availability.	130.00	/media/official-chillox-5b33ac1bbb75.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
198	44	9	Tira - Miss - U	Published price. Check the official menu for options and current availability.	220.00	/media/official-chillox-1aab801a527a.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
199	44	9	Oreo & Cheese	Published price. Check the official menu for options and current availability.	220.00	/media/official-chillox-5978c9ef92d6.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
200	44	9	Blueberry Cheese DIP	Published price. Check the official menu for options and current availability.	210.00	/media/official-chillox-6142f31b56f4.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
201	44	9	Red Velvet	Published price. Check the official menu for options and current availability.	230.00	/media/official-chillox-c08bf2d352b9.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
202	44	9	Choco Fudge	Published price. Check the official menu for options and current availability.	230.00	/media/official-chillox-a1873b5f9535.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
203	45	9	Fish Tots (6 Pcs)	Published price. Check the official menu for options and current availability.	235.00	/media/official-chillox-538c1ccc0d38.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
204	45	9	Fish Burger	Published price. Check the official menu for options and current availability.	360.00	/media/official-chillox-8ae720159a70.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f
205	46	9	CRISPY CHICKEN BURGER 🆕	Published price. Check the official menu for options and current availability.	295.00	/media/official-chillox-277d68abd3bc.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
206	46	9	CRISPY CHICKEN CHEESE BURGER 🆕	Published price. Check the official menu for options and current availability.	325.00	/media/official-chillox-d3c62faf1868.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
207	47	9	Truffle Smasher (Single Patty)	Published price. Check the official menu for options and current availability.	395.00	/media/official-chillox-54ad90739df2.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
208	47	9	Truffle Smasher (Double Patty)	Published price. Check the official menu for options and current availability.	590.00	/media/official-chillox-d94f38eda077.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
209	47	9	Shiitake Mushroom Smasher (Single Patty)	Published price. Check the official menu for options and current availability.	495.00	/media/official-chillox-22fe8daa5800.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
210	47	9	Shiitake Mushroom Smasher (Double patty)	Published price. Check the official menu for options and current availability.	690.00	/media/official-chillox-eda2a774a66b.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
211	47	9	Canadian Bacon Smasher (SIngle Patty)	Published price. Check the official menu for options and current availability.	500.00	/media/official-chillox-dc91ddfbbfb9.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
212	47	9	Canadian Bacon Smasher (Double patty)	Published price. Check the official menu for options and current availability.	695.00	/media/official-chillox-8bd76a01892b.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
213	48	9	Brownie 🆕 ⭐⭐	Published price. Check the official menu for options and current availability.	240.00	/media/official-chillox-0214ac0fdcea.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
214	48	9	Cold Coffee	Published price. Check the official menu for options and current availability.	185.00	/media/official-chillox-c18fba40013b.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
215	48	9	Oreo	Published price. Check the official menu for options and current availability.	200.00	/media/official-chillox-628e3af659db.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
216	48	9	Nutella	Published price. Check the official menu for options and current availability.	230.00	/media/official-chillox-cd8be495fb82.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
217	48	9	Ferrero Rocher	Published price. Check the official menu for options and current availability.	240.00	/media/official-chillox-33988bfba134.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ae7bc0969e2e6568e750fe/delivery	f
218	48	9	Munch	Published price. Check the official menu for options and current availability.	190.00	/media/official-chillox-cb266c223a9d.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64b8b14616acff4d893efbeb/delivery	f
219	49	9	CHICKEN MOMO (5 PCs)	Published price. Check the official menu for options and current availability.	150.00	/media/official-chillox-46b1a6a7332a.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
220	49	9	NAGA MOMO (5 PCs)	Published price. Check the official menu for options and current availability.	170.00	/media/official-chillox-7475284bb248.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
221	49	9	BBQ CHICKEN MOMO (5 PCs)	Published price. Check the official menu for options and current availability.	200.00	/media/official-chillox-27e547582208.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
223	49	9	NUTELLA CHOCOHOLIC WAFFLE	Published price. Check the official menu for options and current availability.	160.00	/media/official-chillox-96fc71678972.png	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
224	49	9	RED VELVET WAFFLE	Published price. Check the official menu for options and current availability.	160.00	/media/official-chillox-54cd28a95e97.png	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
225	49	9	OREO WAFFLE	Published price. Check the official menu for options and current availability.	170.00	/media/official-chillox-fa3c0d89f192.png	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
226	49	9	REESE'S WAFFLE	Published price. Check the official menu for options and current availability.	170.00	/media/official-chillox-1508d40c5282.png	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
227	49	9	AMERICANO Coffee	Published price. Check the official menu for options and current availability.	199.00	/media/official-chillox-933a46cefa04.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
228	49	9	CAPPUCINO Coffee	Published price. Check the official menu for options and current availability.	249.00	/media/official-chillox-0a42cc95303a.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
229	49	9	CAFE LATEE Coffee	Published price. Check the official menu for options and current availability.	249.00	/media/official-chillox-ec6f4ab65cb2.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
230	49	9	HAZELNUT LATTE Coffee	Published price. Check the official menu for options and current availability.	299.00	/media/official-chillox-b39227866e48.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
231	49	9	CARAMEL LATTE Coffee	Published price. Check the official menu for options and current availability.	299.00	/media/official-chillox-978af91d7598.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
232	49	9	MOCHA Coffee	Published price. Check the official menu for options and current availability.	320.00	/media/official-chillox-04841816db5e.jpeg	t	f	f	2026-09-10 00:00:29.719907	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/691026b786f55910fc432bd0/delivery	f
101	24	8	Chicken Pops	Published price. Check the official menu for options and current availability.	195.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
102	24	8	Naga Pops	Published price. Check the official menu for options and current availability.	205.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
103	24	8	Chicken Lollipop	Published price for 4 pcs. Check the official menu for options and current availability.	140.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
105	24	8	Chicken Mini Strips	Published price for Small. Check the official menu for options and current availability.	165.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
107	24	8	BBQ Boneless Chicken	Published price for 10pcs. Check the official menu for options and current availability.	160.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
115	25	8	Garlic Burger Large	Published price. Check the official menu for options and current availability.	290.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
116	25	8	Garlic Burger Regular With Cheese	Published price. Check the official menu for options and current availability.	250.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
1	1	1	Kacchi Biryani	Mutton marinated overnight, layered with aromatic basmati and slow-cooked on dum.	420.00	/media/biryani.jpg	t	f	f	2026-09-08 22:47:46.197133	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
2	1	1	Chicken Tehari	Short-grain chinigura rice tossed with green chilli and tender chicken.	280.00	/media/biryani.jpg	t	f	f	2026-09-08 22:47:46.197133	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
3	1	1	Morog Polao	Mildly spiced chicken pulao served with a boiled egg and salad.	320.00	/media/biryani.jpg	t	f	f	2026-09-08 22:47:46.197133	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
4	1	1	Plain Basmati Rice	Steamed long-grain basmati.	90.00	/media/biryani.jpg	t	t	f	2026-09-08 22:47:46.197133	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
5	2	1	Beef Bhuna	Slow-reduced beef curry with onion, ginger and whole garam masala.	340.00	/media/curry.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
6	2	1	Shorshe Ilish	Hilsa in mustard gravy. Seasonal.	550.00	/media/curry.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
7	2	1	Dal Makhani	Black lentils simmered with butter and cream.	180.00	/media/curry.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
8	3	1	Borhani	Spiced yoghurt drink with mint and mustard.	70.00	/media/tea.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
9	3	1	Lemon Mint	Fresh lime, mint and soda over ice.	90.00	/media/tea.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
10	4	2	Margherita	San Marzano tomato, fior di latte, basil.	650.00	/media/pizza.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1513104890138-7c749659a591	t
11	4	2	Pepperoni Classic	Double pepperoni with mozzarella on a hand-stretched base.	850.00	/media/pizza.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1513104890138-7c749659a591	t
12	4	2	BBQ Chicken	Smoked chicken, red onion, coriander and barbecue sauce.	890.00	/media/fries.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
13	4	2	Four Cheese	Mozzarella, cheddar, parmesan and a blue cheese drizzle.	920.00	/media/pizza.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1513104890138-7c749659a591	t
14	5	2	Garlic Bread	Baked with garlic butter and herbs.	220.00	/media/pizza.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1513104890138-7c749659a591	t
15	5	2	Buffalo Wings	Six wings tossed in hot sauce, blue cheese dip.	380.00	/media/fries.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
16	5	2	Caesar Salad	Romaine, parmesan, croutons, anchovy dressing.	340.00	/media/salad.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
17	6	3	Chicken Chow Mein	Wok-tossed egg noodles with julienned vegetables.	290.00	/media/noodles.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1569718212165-3a8278d5f624	t
18	6	3	Thai Basil Fried Rice	Jasmine rice with holy basil, chilli and fried egg.	310.00	/media/biryani.jpg	t	f	f	2026-09-08 22:47:46.197133	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
19	6	3	Veg Hakka Noodles	Cabbage, carrot, spring onion, light soy.	240.00	/media/noodles.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1569718212165-3a8278d5f624	t
20	7	3	Kung Pao Chicken	Diced chicken, roasted peanuts, dried red chilli.	420.00	/media/fries.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
21	7	3	Chilli Prawn	Prawns in a sweet-hot garlic glaze.	520.00	/media/curry.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
22	7	3	Tofu in Black Bean Sauce	Silken tofu, fermented black bean, peppers.	330.00	/media/salad.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
23	8	3	Thai Thick Soup	Chicken, egg and corn in a thickened broth.	190.00	/media/curry.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1603894584373-5ac82b2ae398	t
24	8	3	Hot & Sour Veg Soup	White pepper, vinegar, shiitake.	170.00	/media/salad.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
25	9	4	Yard Classic	Single beef patty, cheddar, pickles, house sauce.	380.00	/media/burger.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
26	9	4	Double Smash	Two smashed patties, American cheese, caramelised onion.	520.00	/media/burger.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
27	9	4	Crispy Chicken	Buttermilk-fried thigh, slaw, sriracha mayo.	420.00	/media/fries.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
28	9	4	Mushroom Swiss (V)	Grilled portobello, swiss cheese, garlic aioli.	390.00	/media/burger.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
29	10	4	Loaded Cheese Fries	Fries under cheese sauce, jalapeño and spring onion.	260.00	/media/fries.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
30	10	4	Peri Peri Fries	Hand-cut fries dusted with peri peri.	180.00	/media/fries.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
31	10	4	Oreo Shake	Thick vanilla shake blended with cookies.	280.00	/media/tea.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
32	11	5	Quinoa Falafel Bowl	Quinoa, baked falafel, hummus, pickled cabbage.	480.00	/media/salad.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
33	11	5	Grilled Chicken Bowl	Brown rice, grilled chicken, avocado, tahini.	540.00	/media/salad.jpg	t	f	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
34	11	5	Peanut Tofu Bowl	Soba noodles, crisp tofu, satay dressing.	460.00	/media/salad.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t
35	12	5	Green Detox	Cucumber, spinach, apple, ginger.	220.00	/media/tea.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
36	12	5	Beet Boost	Beetroot, carrot, orange, lemon.	220.00	/media/tea.jpg	t	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
37	12	5	Turmeric Latte	Oat milk, turmeric, black pepper. Currently unavailable.	260.00	/media/tea.jpg	f	t	f	2026-09-08 22:47:46.197133	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
117	25	8	Garlic Burger Large With Cheese	Published price. Check the official menu for options and current availability.	320.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
122	26	8	Rice	Published price. Check the official menu for options and current availability.	95.00	/media/biryani.jpg	t	f	f	2026-09-10 00:00:29.719907	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
123	26	8	Rice Bowl 2	Published price. Check the official menu for options and current availability.	215.00	/media/biryani.jpg	t	f	f	2026-09-10 00:00:29.719907	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
124	26	8	Rice Bowl 3	Published price. Check the official menu for options and current availability.	235.00	/media/biryani.jpg	t	f	f	2026-09-10 00:00:29.719907	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
125	26	8	Rice Bowl 1	Published price. Check the official menu for options and current availability.	255.00	/media/biryani.jpg	t	f	f	2026-09-10 00:00:29.719907	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t
126	27	8	Combo 13	Published price for Take Away. Check the official menu for options and current availability.	315.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
127	27	8	Combo 14	Published price for Take Away. Check the official menu for options and current availability.	315.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
128	27	8	Combo 15	Published price for Take Away. Check the official menu for options and current availability.	345.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
129	27	8	Combo 16	Published price for Take Away. Check the official menu for options and current availability.	345.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
130	27	8	Combo 17	Published price for Take Away. Check the official menu for options and current availability.	340.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
136	28	8	Extra Bun	Published price. Check the official menu for options and current availability.	20.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
140	29	8	Combo-1	Published price. Check the official menu for options and current availability.	395.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
141	29	8	Combo-2	Published price. Check the official menu for options and current availability.	350.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
142	29	8	Combo-3	Published price. Check the official menu for options and current availability.	520.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
143	29	8	Combo-4	Published price. Check the official menu for options and current availability.	475.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
144	30	8	Combo-5	Published price. Check the official menu for options and current availability.	440.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
145	30	8	Combo-6	Published price. Check the official menu for options and current availability.	395.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
146	30	8	Combo-7	Published price. Check the official menu for options and current availability.	460.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
147	30	8	Combo-8	Published price. Check the official menu for options and current availability.	415.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
148	30	8	Combo-11	Published price. Check the official menu for options and current availability.	455.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
149	30	8	Combo-12	Published price. Check the official menu for options and current availability.	410.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
150	30	8	Combo-9	Published price. Check the official menu for options and current availability.	445.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
151	30	8	Combo-10	Published price. Check the official menu for options and current availability.	400.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
152	31	8	NEW BURGER COMBO-1	Published price. Check the official menu for options and current availability.	440.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
153	31	8	NEW BURGER COMBO-2	Published price. Check the official menu for options and current availability.	395.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
154	31	8	NEW BURGER COMBO-3	Published price. Check the official menu for options and current availability.	360.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
155	31	8	NEW BURGER COMBO-4	Published price. Check the official menu for options and current availability.	315.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
159	33	8	Mega Feast (for 2 person)	Published price. Check the official menu for options and current availability.	970.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
161	34	8	Mango Juice	Published price. Check the official menu for options and current availability.	20.00	/media/tea.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
162	34	8	200ml Drinks	Published price. Check the official menu for options and current availability.	20.00	/media/tea.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1544787219-7f47ccb76574	t
164	35	8	Regular Wrap	Published price for Garlic. Check the official menu for options and current availability.	220.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
165	35	8	Grill Wrap	Published price. Check the official menu for options and current availability.	225.00	/media/burger.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t
166	36	8	Combo 11	Published price for Take Away. Check the official menu for options and current availability.	455.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
167	36	8	Combo 12	Published price for Take Away. Check the official menu for options and current availability.	410.00	/media/fries.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1573080496219-bb080dd4f877	t
222	49	9	ASSORTED MOMOS (8 PCs)	Published price. Check the official menu for options and current availability.	220.00	/media/noodles.jpg	t	f	f	2026-09-10 00:00:29.719907	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1569718212165-3a8278d5f624	t
\.


--
-- Data for Name: modifier_groups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.modifier_groups (id, menu_item_id, name, is_required, min_selection, max_selection, created_at) FROM stdin;
1	1	Portion	t	1	1	2026-09-08 22:47:46.197133
2	1	Sides	f	0	2	2026-09-08 22:47:46.197133
3	10	Size	t	1	1	2026-09-08 22:47:46.197133
4	10	Extra toppings	f	0	3	2026-09-08 22:47:46.197133
5	25	Doneness	t	1	1	2026-09-08 22:47:46.197133
6	25	Add-ons	f	0	4	2026-09-08 22:47:46.197133
\.


--
-- Data for Name: modifier_options; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.modifier_options (id, modifier_group_id, name, price_modifier, is_available, created_at) FROM stdin;
1	1	Half	-150.00	t	2026-09-08 22:47:46.197133
2	1	Full	0.00	t	2026-09-08 22:47:46.197133
3	2	Extra borhani	70.00	t	2026-09-08 22:47:46.197133
4	2	Boiled egg	40.00	t	2026-09-08 22:47:46.197133
5	2	Jali kabab	160.00	f	2026-09-08 22:47:46.197133
6	3	Regular (9")	0.00	t	2026-09-08 22:47:46.197133
7	3	Large (12")	250.00	t	2026-09-08 22:47:46.197133
8	3	Family (16")	520.00	t	2026-09-08 22:47:46.197133
9	4	Extra cheese	120.00	t	2026-09-08 22:47:46.197133
10	4	Mushrooms	90.00	t	2026-09-08 22:47:46.197133
11	4	Olives	80.00	t	2026-09-08 22:47:46.197133
12	4	Jalapeños	70.00	t	2026-09-08 22:47:46.197133
13	5	Medium	0.00	t	2026-09-08 22:47:46.197133
14	5	Well done	0.00	t	2026-09-08 22:47:46.197133
15	6	Extra patty	180.00	t	2026-09-08 22:47:46.197133
16	6	Bacon	140.00	t	2026-09-08 22:47:46.197133
17	6	Fried egg	60.00	t	2026-09-08 22:47:46.197133
18	6	No cheese	-30.00	t	2026-09-08 22:47:46.197133
\.


--
-- Data for Name: order_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.order_events (id, order_id, status, note, created_at) FROM stdin;
1	1	pending	Order placed	2026-09-09 21:36:15.361649-07
13	13	pending	Order placed	2026-09-10 00:17:31.097585-07
29	17	pending	Order placed	2026-09-10 00:27:03.099758-07
30	17	confirmed	\N	2026-09-10 00:46:41.6443-07
31	17	preparing	\N	2026-09-10 00:46:43.859517-07
32	17	preparing	Rider assigned; waiting for pickup	2026-09-10 00:47:09.628189-07
33	17	out_for_delivery	\N	2026-09-10 00:47:11.727564-07
34	17	delivered	\N	2026-09-10 00:47:15.460564-07
35	18	pending	Order placed	2026-09-10 00:49:04.479296-07
36	19	pending	Order placed	2026-09-10 00:52:24.55976-07
37	19	confirmed	\N	2026-09-10 00:54:41.105874-07
38	19	preparing	\N	2026-09-10 00:54:42.320897-07
39	19	preparing	Rider assigned; waiting for pickup	2026-09-10 00:55:07.172408-07
40	19	out_for_delivery	\N	2026-09-10 00:55:10.774235-07
41	19	delivered	\N	2026-09-10 00:55:11.856176-07
42	20	pending	Order placed	2026-09-10 01:13:25.193278-07
43	20	confirmed	\N	2026-09-10 01:14:19.090829-07
44	20	preparing	\N	2026-09-10 01:14:23.571662-07
45	20	preparing	Rider assigned; waiting for pickup	2026-09-10 01:14:46.926041-07
46	20	out_for_delivery	\N	2026-09-10 01:14:50.940209-07
47	20	delivered	\N	2026-09-10 01:15:28.074227-07
54	22	pending	Order placed	2026-09-10 06:25:26.436108-07
55	23	pending	Order placed	2026-09-10 23:48:57.126935-07
56	23	confirmed	\N	2026-09-10 23:50:05.706802-07
57	22	confirmed	\N	2026-09-10 23:50:06.725763-07
58	23	preparing	\N	2026-09-10 23:50:08.021689-07
59	22	preparing	\N	2026-09-10 23:50:08.721417-07
60	23	preparing	Rider assigned; waiting for pickup	2026-09-10 23:50:22.190248-07
61	23	out_for_delivery	\N	2026-09-10 23:50:34.590649-07
62	23	delivered	\N	2026-09-10 23:50:35.522611-07
63	22	preparing	Rider assigned; waiting for pickup	2026-09-10 23:50:37.806402-07
64	22	out_for_delivery	\N	2026-09-10 23:50:38.989854-07
65	22	delivered	\N	2026-09-10 23:50:39.437843-07
66	24	pending	Order placed	2026-09-11 09:44:28.794283-07
67	24	confirmed	\N	2026-09-11 09:45:51.054643-07
68	24	preparing	\N	2026-09-11 09:45:52.770168-07
69	24	preparing	Rider assigned; waiting for pickup	2026-09-11 09:46:21.956233-07
70	24	out_for_delivery	\N	2026-09-11 09:46:26.655235-07
71	24	delivered	\N	2026-09-11 09:46:28.720388-07
72	25	pending	Order placed	2026-09-12 23:02:47.067576-07
73	25	confirmed	\N	2026-09-12 23:03:24.861071-07
74	25	preparing	\N	2026-09-12 23:03:26.211565-07
75	25	preparing	Rider assigned; waiting for pickup	2026-09-12 23:03:43.978117-07
76	25	out_for_delivery	\N	2026-09-12 23:03:46.495518-07
77	25	delivered	\N	2026-09-12 23:03:56.476193-07
78	26	pending	Order placed	2026-09-14 23:48:49.695678-07
79	26	confirmed	\N	2026-09-14 23:49:08.146431-07
80	26	preparing	\N	2026-09-14 23:49:09.809993-07
81	26	preparing	Rider assigned; waiting for pickup	2026-09-14 23:50:35.762724-07
82	26	out_for_delivery	\N	2026-09-14 23:50:38.512091-07
83	26	delivered	\N	2026-09-14 23:50:42.010767-07
\.


--
-- Data for Name: order_item_modifiers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.order_item_modifiers (id, order_item_id, modifier_option_id, name, price_modifier) FROM stdin;
\.


--
-- Data for Name: order_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.order_items (id, order_id, menu_item_id, quantity, unit_price, special_instruction, item_name, image_url) FROM stdin;
1	1	27	1	420.00	\N	Crispy Chicken	\N
14	13	108	1	275.00	\N	BEST BURGER	/media/official-bfc-9e342679fbae.jpeg
15	13	160	1	65.00	\N	Pepsi n Otherrs	/media/official-bfc-223bd60dbad4.jpeg
16	13	148	1	455.00	\N	Combo-11	/media/fries.jpg
20	17	38	1	330.00	\N	Basmati Kacchi (1 person)	/media/official-Kacchi-Bhai-1d36780a3be8.avif
21	18	173	1	325.00	\N	Pan Asian Mashup 🌶️	/media/official-chillox-352bfc82a15b.jpeg
22	19	59	1	1799.00	\N	12pc + 6pc Free Bucket	/media/official-KFC-6ac0d9544dba.jpg
23	20	62	1	1299.00	\N	8pc + 4pc Free Bucket	/media/official-KFC-b23981b4a9db.jpg
25	22	54	1	404.00	\N	Spicy Zinger with Cheese	/media/official-KFC-e0fd85c522fe.jpg
26	22	69	1	1249.00	\N	10 Pc Leg  Bucket	/media/official-KFC-26935443aef1.jpg
27	22	65	1	1319.00	\N	Curry Crunch – 8 pcs	/media/official-KFC-3795382f00e4.jpg
28	22	63	1	669.00	\N	Curry Crunch – 4 pcs	/media/official-KFC-20610def6fb8.jpg
29	23	51	1	319.00	\N	Rice Box	/media/official-KFC-9cc6bccddd1e.jpg
30	24	65	1	1319.00	\N	Curry Crunch – 8 pcs	/media/official-KFC-3795382f00e4.jpg
31	25	55	1	384.00	\N	Classic Zinger with Cheese	/media/official-KFC-618c0304de87.jpg
32	26	275	1	200.00	\N	Fried Chicken	\N
\.


--
-- Data for Name: orders; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.orders (id, customer_id, rider_id, branch_id, promo_code_id, delivery_address, subtotal, discount_amount, total_amount, status, review_eligible, created_at, delivery_fee) FROM stdin;
1	10	\N	6	\N	347,Dhanmondi,Dhaka	420.00	0.00	469.00	pending	f	2026-09-09 21:36:15.361649	49.00
24	10	12	65	1	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	1319.00	263.80	1125.20	delivered	t	2026-09-11 09:44:28.794283	70.00
13	10	\N	103	1	347,Mirpur,Dhaka	795.00	159.00	686.00	pending	f	2026-09-10 00:17:31.097585	50.00
25	10	12	65	2	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	384.00	38.40	415.60	delivered	t	2026-09-12 23:02:47.067576	70.00
26	10	12	65	\N	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	200.00	0.00	270.00	delivered	t	2026-09-14 23:48:49.695678	70.00
17	10	12	9	2	347,Rampura	330.00	33.00	357.00	delivered	t	2026-09-10 00:27:03.099758	60.00
18	10	\N	125	1	347,South Goran,Road-36,Khilgaon,Dhaka	325.00	65.00	320.00	pending	f	2026-09-10 00:49:04.479296	60.00
19	10	12	65	1	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	1799.00	359.80	1509.20	delivered	t	2026-09-10 00:52:24.55976	70.00
23	10	12	65	\N	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	319.00	0.00	389.00	delivered	t	2026-09-10 23:48:57.126935	70.00
20	10	12	58	\N	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	1299.00	0.00	1369.00	delivered	t	2026-09-10 01:13:25.193278	70.00
22	10	12	65	1	347,South Goran,Road-36,Khilgaon,Dhaka, Khilgaon, Khilgaon, Dhaka, 01711137457	3641.00	728.20	2982.80	delivered	t	2026-09-10 06:25:26.436108	70.00
\.


--
-- Data for Name: payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payments (id, order_id, method, amount, status, transaction_ref, paid_at) FROM stdin;
1	1	cash_on_delivery	469.00	unpaid	\N	\N
13	13	cash_on_delivery	686.00	unpaid	\N	\N
17	17	cash_on_delivery	357.00	paid	\N	2026-09-10 00:47:15.460564
18	18	cash_on_delivery	320.00	unpaid	\N	\N
19	19	cash_on_delivery	1509.20	paid	\N	2026-09-10 00:55:11.856176
20	20	cash_on_delivery	1369.00	paid	\N	2026-09-10 01:15:28.074227
23	23	cash_on_delivery	389.00	paid	\N	2026-09-10 23:50:35.522611
22	22	cash_on_delivery	2982.80	paid	\N	2026-09-10 23:50:39.437843
24	24	cash_on_delivery	1125.20	paid	\N	2026-09-11 09:46:28.720388
25	25	cash_on_delivery	415.60	paid	\N	2026-09-12 23:03:56.476193
26	26	cash_on_delivery	270.00	paid	\N	2026-09-14 23:50:42.010767
\.


--
-- Data for Name: promo_codes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.promo_codes (id, code, discount_percent, min_order_amount, expiry_date, is_active, usage_limit, used_count) FROM stdin;
3	OLDDEAL	50	0.00	2020-01-01	t	100	0
1	WELCOME20	20	300.00	2027-12-31	t	500	5
2	FLAT10	10	0.00	2027-12-31	t	1000	2
\.


--
-- Data for Name: quality_flag_log; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.quality_flag_log (id, menu_item_id, order_id, flagged_at) FROM stdin;
1	62	20	2026-09-10 01:16:29.66074
\.


--
-- Data for Name: restaurant_branches; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.restaurant_branches (id, restaurant_id, address, area, city, phone, latitude, longitude, is_open, division, delivery_fee, min_order_amount, eta_min, eta_max) FROM stdin;
1	1	House 42, Road 27, Dhanmondi	Dhanmondi	Dhaka	029661000	23.751600	90.375000	t	\N	49.00	0.00	25	45
2	1	Plot 12, Sector 7, Uttara	Uttara	Dhaka	028912000	23.874500	90.379700	t	\N	49.00	0.00	25	45
3	2	9 Gulshan Avenue, Gulshan 1	Gulshan	Dhaka	028812000	23.780800	90.415500	t	\N	49.00	0.00	25	45
4	2	Road 11, Banani	Banani	Dhaka	028813000	23.793700	90.404300	f	\N	49.00	0.00	25	45
5	3	Level 4, Bashundhara City, Panthapath	Panthapath	Dhaka	029130000	23.750900	90.390400	t	\N	49.00	0.00	25	45
6	4	Shop 3, Road 2, Dhanmondi	Dhanmondi	Dhaka	029662000	23.739000	90.376900	t	\N	49.00	0.00	25	45
7	4	GEC Circle, Nasirabad	Nasirabad	Chattogram	031650000	22.358700	91.821300	t	\N	49.00	0.00	25	45
8	5	Road 12, Block E, Banani	Banani	Dhaka	028814000	23.794100	90.406100	t	\N	49.00	0.00	25	45
148	6	Kacchi Bhai, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	60.00	0.00	35	55
149	6	Kacchi Bhai, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	60.00	0.00	35	55
150	6	Kacchi Bhai, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	60.00	0.00	35	55
151	6	Kacchi Bhai, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	60.00	0.00	35	55
152	6	Kacchi Bhai, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	60.00	0.00	35	55
153	6	Kacchi Bhai, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	60.00	0.00	35	55
154	6	Kacchi Bhai, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	60.00	0.00	35	55
155	7	KFC, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	70.00	0.00	25	45
156	7	KFC, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	70.00	0.00	25	45
157	7	KFC, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	70.00	0.00	25	45
158	7	KFC, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	70.00	0.00	25	45
159	7	KFC, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	70.00	0.00	25	45
160	7	KFC, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	70.00	0.00	25	45
161	7	KFC, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	70.00	0.00	25	45
162	8	BFC, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	50.00	0.00	25	40
163	8	BFC, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	50.00	0.00	25	40
164	8	BFC, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	50.00	0.00	25	40
165	8	BFC, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	50.00	0.00	25	40
166	8	BFC, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	50.00	0.00	25	40
167	8	BFC, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	50.00	0.00	25	40
168	8	BFC, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	50.00	0.00	25	40
169	9	Chillox, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	60.00	0.00	20	40
170	9	Chillox, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	60.00	0.00	20	40
171	9	Chillox, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	60.00	0.00	20	40
172	9	Chillox, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	60.00	0.00	20	40
173	9	Chillox, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	60.00	0.00	20	40
174	9	Chillox, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	60.00	0.00	20	40
175	9	Chillox, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	60.00	0.00	20	40
176	10	Sultan's Dine, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	70.00	0.00	35	60
177	10	Sultan's Dine, Dhanmondi, Dhaka	Dhanmondi	Dhaka	\N	\N	\N	t	Dhaka	70.00	0.00	35	60
178	10	Sultan's Dine, Uttara, Dhaka	Uttara	Dhaka	\N	\N	\N	t	Dhaka	70.00	0.00	35	60
179	10	Sultan's Dine, Mirpur, Dhaka	Mirpur	Dhaka	\N	\N	\N	t	Dhaka	70.00	0.00	35	60
180	10	Sultan's Dine, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	70.00	0.00	35	60
181	10	Sultan's Dine, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	70.00	0.00	35	60
182	10	Sultan's Dine, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	70.00	0.00	35	60
183	10	Sultan's Dine, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	70.00	0.00	35	60
184	10	Sultan's Dine, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	70.00	0.00	35	60
185	10	Sultan's Dine, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	70.00	0.00	35	60
186	10	Sultan's Dine, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	70.00	0.00	35	60
187	11	Khana's, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	65.00	0.00	30	50
188	11	Khana's, Dhanmondi, Dhaka	Dhanmondi	Dhaka	\N	\N	\N	t	Dhaka	65.00	0.00	30	50
189	11	Khana's, Uttara, Dhaka	Uttara	Dhaka	\N	\N	\N	t	Dhaka	65.00	0.00	30	50
190	11	Khana's, Mirpur, Dhaka	Mirpur	Dhaka	\N	\N	\N	t	Dhaka	65.00	0.00	30	50
191	11	Khana's, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	65.00	0.00	30	50
192	11	Khana's, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	65.00	0.00	30	50
193	11	Khana's, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	65.00	0.00	30	50
194	11	Khana's, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	65.00	0.00	30	50
195	11	Khana's, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	65.00	0.00	30	50
196	11	Khana's, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	65.00	0.00	30	50
197	11	Khana's, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	65.00	0.00	30	50
198	12	Domino's Pizza, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	60.00	0.00	25	45
199	12	Domino's Pizza, Dhanmondi, Dhaka	Dhanmondi	Dhaka	\N	\N	\N	t	Dhaka	60.00	0.00	25	45
200	12	Domino's Pizza, Uttara, Dhaka	Uttara	Dhaka	\N	\N	\N	t	Dhaka	60.00	0.00	25	45
201	12	Domino's Pizza, Mirpur, Dhaka	Mirpur	Dhaka	\N	\N	\N	t	Dhaka	60.00	0.00	25	45
202	12	Domino's Pizza, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	60.00	0.00	25	45
203	12	Domino's Pizza, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	60.00	0.00	25	45
204	12	Domino's Pizza, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	60.00	0.00	25	45
205	12	Domino's Pizza, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	60.00	0.00	25	45
206	12	Domino's Pizza, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	60.00	0.00	25	45
207	12	Domino's Pizza, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	60.00	0.00	25	45
208	12	Domino's Pizza, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	60.00	0.00	25	45
209	13	Takeout, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	20	40
210	13	Takeout, Dhanmondi, Dhaka	Dhanmondi	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	20	40
211	13	Takeout, Uttara, Dhaka	Uttara	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	20	40
212	13	Takeout, Mirpur, Dhaka	Mirpur	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	20	40
213	13	Takeout, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	55.00	0.00	20	40
214	13	Takeout, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	55.00	0.00	20	40
215	13	Takeout, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	55.00	0.00	20	40
216	13	Takeout, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	55.00	0.00	20	40
217	13	Takeout, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	55.00	0.00	20	40
218	13	Takeout, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	55.00	0.00	20	40
219	13	Takeout, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	55.00	0.00	20	40
220	14	Fry Bucket, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	25	45
221	14	Fry Bucket, Dhanmondi, Dhaka	Dhanmondi	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	25	45
222	14	Fry Bucket, Uttara, Dhaka	Uttara	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	25	45
223	14	Fry Bucket, Mirpur, Dhaka	Mirpur	Dhaka	\N	\N	\N	t	Dhaka	55.00	0.00	25	45
224	14	Fry Bucket, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	55.00	0.00	25	45
225	14	Fry Bucket, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	55.00	0.00	25	45
226	14	Fry Bucket, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	55.00	0.00	25	45
227	14	Fry Bucket, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	55.00	0.00	25	45
228	14	Fry Bucket, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	55.00	0.00	25	45
229	14	Fry Bucket, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	55.00	0.00	25	45
230	14	Fry Bucket, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	55.00	0.00	25	45
231	1	Chuli Kitchen, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	49.00	0.00	25	45
232	1	Chuli Kitchen, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	49.00	0.00	25	45
233	1	Chuli Kitchen, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	49.00	0.00	25	45
234	1	Chuli Kitchen, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	49.00	0.00	25	45
235	1	Chuli Kitchen, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	49.00	0.00	25	45
236	1	Chuli Kitchen, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	49.00	0.00	25	45
237	1	Chuli Kitchen, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	49.00	0.00	25	45
238	1	Chuli Kitchen, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	49.00	0.00	25	45
239	2	Pizza Republic, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	49.00	0.00	25	45
240	2	Pizza Republic, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	49.00	0.00	25	45
241	2	Pizza Republic, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	49.00	0.00	25	45
242	2	Pizza Republic, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	49.00	0.00	25	45
243	2	Pizza Republic, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	49.00	0.00	25	45
244	2	Pizza Republic, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	49.00	0.00	25	45
245	2	Pizza Republic, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	49.00	0.00	25	45
246	2	Pizza Republic, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	49.00	0.00	25	45
247	3	Wok & Roll, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	49.00	0.00	25	45
248	3	Wok & Roll, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	49.00	0.00	25	45
249	3	Wok & Roll, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	49.00	0.00	25	45
250	3	Wok & Roll, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	49.00	0.00	25	45
251	3	Wok & Roll, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	49.00	0.00	25	45
252	3	Wok & Roll, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	49.00	0.00	25	45
253	3	Wok & Roll, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	49.00	0.00	25	45
254	3	Wok & Roll, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	49.00	0.00	25	45
255	4	The Burger Yard, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	49.00	0.00	25	45
256	4	The Burger Yard, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	49.00	0.00	25	45
257	4	The Burger Yard, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	49.00	0.00	25	45
258	4	The Burger Yard, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	49.00	0.00	25	45
259	4	The Burger Yard, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	49.00	0.00	25	45
260	4	The Burger Yard, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	49.00	0.00	25	45
261	4	The Burger Yard, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	49.00	0.00	25	45
262	4	The Burger Yard, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	49.00	0.00	25	45
263	5	Green Bowl, Khilgaon, Dhaka	Khilgaon	Dhaka	\N	\N	\N	t	Dhaka	49.00	0.00	25	45
264	5	Green Bowl, Agrabad, Chattogram	Agrabad	Chattogram	\N	\N	\N	t	Chattogram	49.00	0.00	25	45
265	5	Green Bowl, Shaheb Bazar, Rajshahi	Shaheb Bazar	Rajshahi	\N	\N	\N	t	Rajshahi	49.00	0.00	25	45
266	5	Green Bowl, Sonadanga, Khulna	Sonadanga	Khulna	\N	\N	\N	t	Khulna	49.00	0.00	25	45
267	5	Green Bowl, Sadar Road, Barishal	Sadar Road	Barishal	\N	\N	\N	t	Barishal	49.00	0.00	25	45
268	5	Green Bowl, Zindabazar, Sylhet	Zindabazar	Sylhet	\N	\N	\N	t	Sylhet	49.00	0.00	25	45
269	5	Green Bowl, Jahaj Company More, Rangpur	Jahaj Company More	Rangpur	\N	\N	\N	t	Rangpur	49.00	0.00	25	45
270	5	Green Bowl, Ganginar Par, Mymensingh	Ganginar Par	Mymensingh	\N	\N	\N	t	Mymensingh	49.00	0.00	25	45
9	6	Cha-106 (1st Floor), Uttar Badda, Dhaka	Badda	Dhaka	01322-909338	\N	\N	f	Dhaka	60.00	0.00	35	55
20	6	49, Satmasjid Road, Dhanmondi, Old Abacus Building, 1209 Dhaka	Dhanmondi	Dhaka	01322-909338	\N	\N	t	Dhaka	60.00	0.00	35	55
36	6	1st Floor, 589/C, Malibag Chowdhuri Para	Khilgaon	Dhaka	01322-909338	\N	\N	t	Dhaka	60.00	0.00	35	55
58	7	House- 84, Road - 7/A, Satmasjid Road, Dhanmondi , Dhaka 1205. Phone: 09613777888	Dhanmondi	Dhaka	09613777888	23.743448	90.373488	t	Dhaka	70.00	0.00	25	45
65	7	Holding-979, Plot-25-B, Khilgaon, Dhaka-1219. Phone : 09613889944	Khilgaon	Dhaka	09613889944	23.752126	90.416819	t	Dhaka	70.00	0.00	25	45
88	7	First Floor Jannat Tower Plot: 27/B, Lalbagh Road Lalbagh Dhaka 1211. Phone: 09613772277	Lalbagh	Dhaka	09613772277	23.721676	90.388092	t	Dhaka	70.00	0.00	25	45
103	8	Mirpur 1, Dhaka (area-level listing; street address not supplied by this source)	Mirpur 1	Dhaka	\N	23.802246	90.352960	t	Dhaka	50.00	0.00	25	40
104	8	Mirpur 10, Dhaka (area-level listing; street address not supplied by this source)	Mirpur 10	Dhaka	\N	23.808778	90.367897	t	Dhaka	50.00	0.00	25	40
116	8	Khilgaon, Dhaka (area-level listing; street address not supplied by this source)	Khilgaon	Dhaka	\N	23.752222	90.421591	t	Dhaka	50.00	0.00	25	40
125	9	Dhanmondi, Dhaka (area-level listing; street address not supplied by this source)	Dhannmondi	Dhaka	\N	23.740158	90.374860	t	Dhaka	60.00	0.00	20	40
128	9	Khilgaon, Dhaka (area-level listing; street address not supplied by this source)	Khilgaon	Dhaka	\N	23.752465	90.417628	t	Dhaka	60.00	0.00	20	40
133	9	Lalbagh, Dhaka (area-level listing; street address not supplied by this source)	Lalbagh	Dhaka	\N	23.720165	90.389608	t	Dhaka	60.00	0.00	20	40
\.


--
-- Data for Name: restaurant_reviews; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.restaurant_reviews (id, order_id, rating, portion_accuracy, comment, created_at) FROM stdin;
1	17	5	slightly_less	The restaurant should increase the amount of meat portion	2026-09-10 00:49:36.159978
2	19	5	full	I was very pleased with the food	2026-09-10 00:55:58.323313
3	20	3	way_less	I was dissapointed to see the chicken portion	2026-09-10 01:16:29.66074
4	24	5	slightly_less	rider ramim was so good	2026-09-11 09:51:26.182211
5	25	2	slightly_less	chicken was not well cooked	2026-09-12 23:04:34.59665
\.


--
-- Data for Name: restaurants; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.restaurants (id, owner_id, name, avg_rating, review_count, created_at, description, cuisine, image_url, image_credit, image_source_url, image_is_illustrative, is_demo, catalog_slug, source_url, verified_at, ordering_enabled, logo_url, logo_source_url, menu_source_url, menu_scope, gallery) FROM stdin;
2	4	Pizza Republic	\N	0	2026-09-08 22:47:46.197133	\N	Bangladeshi	/media/pizza.jpg	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1513104890138-7c749659a591	t	f	\N	\N	\N	t	\N	\N	\N	branch	[]
3	5	Wok & Roll	\N	0	2026-09-08 22:47:46.197133	\N	Bangladeshi	/media/noodles.jpg	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1569718212165-3a8278d5f624	t	f	\N	\N	\N	t	\N	\N	\N	branch	[]
4	6	The Burger Yard	\N	0	2026-09-08 22:47:46.197133	\N	Bangladeshi	/media/burger.jpg	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1568901346375-23c9450c58cd	t	f	\N	\N	\N	t	\N	\N	\N	branch	[]
5	3	Green Bowl	\N	0	2026-09-08 22:47:46.197133	\N	Bangladeshi	/media/salad.jpg	Unsplash contributor · illustrative sample photo	https://images.unsplash.com/photo-1546069901-ba9599a7e63c	t	f	\N	\N	\N	t	\N	\N	\N	branch	[]
6	13	Kacchi Bhai	5.00	1	2026-09-10 00:00:29.719907	Kacchi Bhai serves basmati kacchi, borhani and firni from its published brand menu, with outlets across the country.	Kacchi & Biryani	/media/dish-kacchi-biryani.jpg	Nahian / Wikimedia Commons (CC BY 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg	t	f	brand-kacchi-bhai	https://www.kacchibhai.com/branch/badda	2026-09-08 17:00:00-07	t	/media/official-Kacchi-Bhai-8c8f0a35834f.webp	https://www.kacchibhai.com/	https://www.kacchibhai.com/	brand	[{"caption": "Published on the official Konabari branch page", "image_url": "/media/official-Kacchi-Bhai-9acea1a7ac22.jpg", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/konabari", "image_is_illustrative": false}, {"caption": "Published on the official Konabari branch page", "image_url": "/media/official-Kacchi-Bhai-1c9668f87bf9.jpg", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/konabari", "image_is_illustrative": false}, {"caption": "Published on the official Konabari branch page", "image_url": "/media/official-Kacchi-Bhai-6de398a0d955.jpg", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/konabari", "image_is_illustrative": false}, {"caption": "Published on the official Konabari branch page", "image_url": "/media/official-Kacchi-Bhai-b4a57d6c2904.jpg", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/konabari", "image_is_illustrative": false}, {"caption": "Published on the official Gulshan branch page", "image_url": "/media/official-Kacchi-Bhai-c9ee8874417c.webp", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/gulshan", "image_is_illustrative": false}, {"caption": "Published on the official Gulshan branch page", "image_url": "/media/official-Kacchi-Bhai-60540495fab1.webp", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/gulshan", "image_is_illustrative": false}, {"caption": "Published on the official Gulshan branch page", "image_url": "/media/official-Kacchi-Bhai-f2d868bf6acb.avif", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/gulshan", "image_is_illustrative": false}, {"caption": "Published on the official Gulshan branch page", "image_url": "/media/official-Kacchi-Bhai-1e7f3372dd33.webp", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/gulshan", "image_is_illustrative": false}, {"caption": "Published on the official Gulshan branch page", "image_url": "/media/official-Kacchi-Bhai-f11fb3b7a395.webp", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/gulshan", "image_is_illustrative": false}, {"caption": "Published on the official Dhanmondi branch page", "image_url": "/media/official-Kacchi-Bhai-d90cd6b32c94.webp", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/dhanmondi", "image_is_illustrative": false}, {"caption": "Published on the official Dhanmondi branch page", "image_url": "/media/official-Kacchi-Bhai-82a4216bdedb.webp", "image_credit": "Kacchi-Bhai · official website", "image_source_url": "https://www.kacchibhai.com/branch/dhanmondi", "image_is_illustrative": false}]
1	3	Chuli Kitchen	\N	0	2026-09-08 22:47:46.197133	\N	Bangladeshi	/media/biryani.jpg	Mario Raj / Unsplash · illustrative sample photo	https://unsplash.com/photos/a-white-bowl-filled-with-rice-and-meat-ysmeQt1dzcw	t	f	\N	\N	\N	t	\N	\N	\N	branch	[]
9	16	Chillox	\N	0	2026-09-10 00:00:29.719907	Chillox is known for its burgers, fried chicken and rice bowls, listed here from its published branch menus.	Burgers & Rice Bowls	/media/official-chillox-53986b2d388e.jpeg	chillox · official website	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	f	f	brand-chillox	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	2026-09-08 17:00:00-07	t	/media/official-chillox-da5e6628f807.jpeg	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery	brand	[{"caption": "Chicken Fry (1Pc) 🍗🆕", "image_url": "/media/official-chillox-53986b2d388e.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Chicken Fry (2Pcs) 🍗🆕", "image_url": "/media/official-chillox-c9c58f4ed617.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Chicken Fry (4Pcs) 🍗🆕", "image_url": "/media/official-chillox-d3a3d77f55d3.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Chicken Fry (6Pcs) 🍗🆕", "image_url": "/media/official-chillox-0cce59f1da7a.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Crispy Chicken Rice 🍗🆕", "image_url": "/media/official-chillox-e44e628e6a29.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Pan Asian Mashup 🌶️", "image_url": "/media/official-chillox-352bfc82a15b.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Continental Fusion", "image_url": "/media/official-chillox-b081d38324a6.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Beef burger", "image_url": "/media/official-chillox-cea03b27aefb.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Beef cheese burger", "image_url": "/media/official-chillox-e19f04103e6f.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Smoky bbq cheese -beef", "image_url": "/media/official-chillox-159e2f7fc8f4.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Beef with bacon", "image_url": "/media/official-chillox-b8ef64c7c5f1.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}, {"caption": "Beef with sausage", "image_url": "/media/official-chillox-907c760d1f4f.jpeg", "image_credit": "chillox · official website", "image_source_url": "https://chillox.engaze.ai/64ad3a63969e2e6568e59344/64ad3b19969e2e6568e59562/delivery", "image_is_illustrative": false}]
7	14	KFC	3.75	4	2026-09-10 00:00:29.719907	KFC brings its published line-up of crispy chicken, zinger burgers, rice bowls and shareable buckets.	Fried Chicken & Burgers	/media/official-KFC-789fac7e6c02.jpg	KFC · official website	https://kfcbd.com/menu/burgers	f	f	brand-kfc	https://kfcbd.com/store-locator	2026-09-08 17:00:00-07	t	/media/official-KFC-4a7684a7d8d6.png	https://kfcbd.com/store-locator	https://kfcbd.com/menu/chicken	brand	[{"caption": "Pepsi", "image_url": "/media/official-KFC-ab20418d16a7.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/beverages", "image_is_illustrative": false}, {"caption": "Mountain Dew", "image_url": "/media/official-KFC-c89876cffa0e.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/beverages", "image_is_illustrative": false}, {"caption": "7 UP", "image_url": "/media/official-KFC-423e85f6b86c.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/beverages", "image_is_illustrative": false}, {"caption": "Aquafina Water", "image_url": "/media/official-KFC-98fd2d332fb4.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/beverages", "image_is_illustrative": false}, {"caption": "Box Master", "image_url": "/media/official-KFC-454bda6881df.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/box-master", "image_is_illustrative": false}, {"caption": "Zinger Box", "image_url": "/media/official-KFC-507f904c903d.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/box-meals", "image_is_illustrative": false}, {"caption": "Super Charger Box", "image_url": "/media/official-KFC-d5622bf4e5fd.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/box-meals", "image_is_illustrative": false}, {"caption": "Hot Wings Box", "image_url": "/media/official-KFC-33dac08da119.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/box-meals", "image_is_illustrative": false}, {"caption": "Strips Box", "image_url": "/media/official-KFC-de13e6b6735a.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/box-meals", "image_is_illustrative": false}, {"caption": "Rice Box", "image_url": "/media/official-KFC-9cc6bccddd1e.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/box-meals", "image_is_illustrative": false}, {"caption": "2 Classic Zinger Meal", "image_url": "/media/official-KFC-789fac7e6c02.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/burgers", "image_is_illustrative": false}, {"caption": "Mixed Zinger Doubles", "image_url": "/media/official-KFC-e246576179a8.jpg", "image_credit": "KFC · official website", "image_source_url": "https://kfcbd.com/menu/burgers", "image_is_illustrative": false}]
8	15	BFC	\N	0	2026-09-10 00:00:29.719907	BFC (Best Fried Chicken) lists fried chicken, wings, burgers, rice platters and sides from its published branch menus.	Fried Chicken & Fast Food	/media/official-bfc-08f2c38f0cf4.jpeg	bfc · official website	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	f	f	brand-bfc	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	2026-09-08 17:00:00-07	t	/media/official-bfc-651d7c932a73.jpeg	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery	brand	[{"caption": "FRIED CHICKEN", "image_url": "/media/official-bfc-08f2c38f0cf4.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "Naga Fried Chicken", "image_url": "/media/official-bfc-ad928749397b.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "HOT WING", "image_url": "/media/official-bfc-5f9aecd68b23.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "BBQ HOT WINGS", "image_url": "/media/official-bfc-eb5be0e1676f.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "CRISPY STRIPS", "image_url": "/media/official-bfc-ec13a22e41dd.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "NUGGETS", "image_url": "/media/official-bfc-e4e4d5f2d048.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "BEST BURGER", "image_url": "/media/official-bfc-9e342679fbae.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "BEST BURGER WITH CHEESE (Super)", "image_url": "/media/official-bfc-2935fc554b51.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "SPICY BURGER", "image_url": "/media/official-bfc-eef41ce69c59.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "SPICY BURGER WITH CHEESE", "image_url": "/media/official-bfc-c37ca7d6e7c0.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "SUPREME BURGER", "image_url": "/media/official-bfc-7509de0aa471.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}, {"caption": "SUPREME CHEESE BURGER", "image_url": "/media/official-bfc-0de1ddd6e688.jpeg", "image_credit": "bfc · official website", "image_source_url": "https://bfc.engaze.ai/613764cc195989f50819dfad/613da1f5b3a3883d5d064bb8/delivery", "image_is_illustrative": false}]
10	29	Sultan's Dine	\N	0	2026-09-10 02:46:03.073202	Sultan's Dine is known across Dhaka for its kacchi biryani, served with borhani and firni in the traditional way.	Kacchi & Biryani	/media/dish-kacchi-biryani.jpg	Nahian / Wikimedia Commons (CC BY 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg	t	t	added-sultans-dine	\N	\N	t	/media/logo-sultans-dine.png	https://commons.wikimedia.org/wiki/Commons:Licensing	\N	brand	[{"caption": "Kacchi Biryani (Full)", "image_url": "/media/dish-kacchi-biryani.jpg", "image_credit": "Nahian / Wikimedia Commons (CC BY 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg", "image_is_illustrative": true}, {"caption": "Kacchi Biryani (Half)", "image_url": "/media/dish-kacchi-biryani.jpg", "image_credit": "Nahian / Wikimedia Commons (CC BY 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg", "image_is_illustrative": true}, {"caption": "Morog Polao", "image_url": "/media/dish-morog-polao.jpg", "image_credit": "Great Hero32 / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Morog_Polao_3.jpg", "image_is_illustrative": true}, {"caption": "Beef Tehari", "image_url": "/media/dish-beef-tehari.jpg", "image_credit": "Riaz / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Tehari_(2).jpg", "image_is_illustrative": true}, {"caption": "Chicken Roast", "image_url": "/media/dish-chicken-roast.jpg", "image_credit": "safaritravelplus / Wikimedia Commons (CC0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Roast_Chicken_Hot_Plate.jpg", "image_is_illustrative": true}, {"caption": "Jali Kabab", "image_url": "/media/dish-jali-kabab.jpg", "image_credit": "Murcotipton / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:4th_October_2012_Shami_Kebab.jpg", "image_is_illustrative": true}]
11	30	Khana's	\N	0	2026-09-10 02:46:03.073202	Khana's serves North Indian and Mughlai plates — butter chicken, seekh kebab and fresh tandoori bread.	Mughlai & Indian	/media/dish-butter-chicken.jpg	stu_spivack / Wikimedia Commons (CC BY-SA 2.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Chicken_makhani.jpg	t	t	added-khanas	\N	\N	t	/media/logo-khanas.png	https://commons.wikimedia.org/wiki/Commons:Licensing	\N	brand	[{"caption": "Butter Chicken", "image_url": "/media/dish-butter-chicken.jpg", "image_credit": "stu_spivack / Wikimedia Commons (CC BY-SA 2.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Chicken_makhani.jpg", "image_is_illustrative": true}, {"caption": "Seekh Kebab", "image_url": "/media/dish-seekh-kebab.jpg", "image_credit": "raasiel / Wikimedia Commons (CC BY 2.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Seekh_Kebab.JPG", "image_is_illustrative": true}, {"caption": "Butter Naan", "image_url": "/media/dish-naan.jpg", "image_credit": "Ravi Dwivedi / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Naan_baked_in_Tandoor.jpg", "image_is_illustrative": true}, {"caption": "Chicken Biryani", "image_url": "/media/dish-chicken-biryani.jpg", "image_credit": "Dheerajk88 / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Chicken_Hyderabadi_Biryani.JPG", "image_is_illustrative": true}, {"caption": "Mango Lassi", "image_url": "/media/dish-lassi.jpg", "image_credit": "Andy Li / Wikimedia Commons (CC0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Mango_Lassi_and_Butter_Milk_-_Vel_South_Indian_Kitchen_%2B_Bar.jpg", "image_is_illustrative": true}, {"caption": "Garden Salad", "image_url": "/media/dish-salad.jpg", "image_credit": "fir0002 flagstaffotos [at] gmail.com Canon 20D + Canon 17-40mm f/4 L / Wikimedia Commons (GFDL 1.2) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Salad_platter.jpg", "image_is_illustrative": true}]
12	31	Domino's Pizza	\N	0	2026-09-10 02:46:03.073202	Domino's Pizza delivers hand-tossed pizzas, oven-baked sides and desserts.	Pizza & Sides	/media/dish-margherita.jpg	Mario56 / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Margherita_Originale.JPG	t	t	added-dominos-pizza	\N	\N	t	/media/logo-dominos.png	https://commons.wikimedia.org/wiki/File:Domino%27s_pizza_logo.svg	\N	brand	[{"caption": "Margherita (Medium)", "image_url": "/media/dish-margherita.jpg", "image_credit": "Mario56 / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Margherita_Originale.JPG", "image_is_illustrative": true}, {"caption": "Pepperoni (Medium)", "image_url": "/media/dish-pepperoni.jpg", "image_credit": "Petar Milošević / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Vegetarian_Pizza.jpg", "image_is_illustrative": true}, {"caption": "Garlic Bread", "image_url": "/media/dish-garlic-bread.jpg", "image_credit": "Infrogmation / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Garlic_bread_baguettes_2.jpg", "image_is_illustrative": true}, {"caption": "Chicken Wings (6 pcs)", "image_url": "/media/dish-chicken-wings.jpg", "image_credit": "stef yau / Wikimedia Commons (CC BY 2.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Homemade_buffalo_wings.jpg", "image_is_illustrative": true}, {"caption": "Choco Brownie", "image_url": "/media/dish-brownie.jpg", "image_credit": "JefferySAC / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Chocolate-brownie-hachatw.jpg", "image_is_illustrative": true}, {"caption": "Soft Drink (500ml)", "image_url": "/media/dish-soft-drink.jpg", "image_credit": "Tomascastelazo / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Coca_Cola_-_Mexican_death_sentence.jpg", "image_is_illustrative": true}]
13	32	Takeout	\N	0	2026-09-10 02:46:03.073202	Takeout does smash burgers, loaded fries and wraps, built for delivery.	Burgers & Fast Food	/media/dish-burger.jpg	Acabashi / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:Cheeseburger_with_onions_at_Hatfield_Heath_Festival_2017.jpg	t	t	added-takeout	\N	\N	t	/media/logo-takeout.png	https://commons.wikimedia.org/wiki/Commons:Licensing	\N	brand	[{"caption": "Classic Beef Burger", "image_url": "/media/dish-burger.jpg", "image_credit": "Acabashi / Wikimedia Commons (CC BY-SA 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Cheeseburger_with_onions_at_Hatfield_Heath_Festival_2017.jpg", "image_is_illustrative": true}, {"caption": "Crispy Chicken Burger", "image_url": "/media/dish-chicken-burger.jpg", "image_credit": "BrokenSphere / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:BK_Original_Chicken_Sandwich.JPG", "image_is_illustrative": true}, {"caption": "Chicken Wrap", "image_url": "/media/dish-wrap.jpg", "image_credit": "Kembangraps / Wikimedia Commons (CC0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Garang_asem_Pj.JPG", "image_is_illustrative": true}, {"caption": "Loaded Fries", "image_url": "/media/dish-fries.jpg", "image_credit": "Chris Woodrich / Wikimedia Commons (Public domain) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:McDonald%27s_French_Fries,_Canada,_2026-04-04.jpg", "image_is_illustrative": true}, {"caption": "Chicken Nuggets (6 pcs)", "image_url": "/media/dish-nuggets.jpg", "image_credit": "Mx. Granger / Wikimedia Commons (CC0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Impossible_chicken_nuggets_2.jpg", "image_is_illustrative": true}, {"caption": "Chocolate Milkshake", "image_url": "/media/dish-milkshake.jpg", "image_credit": "Vyacheslav Argenberg / Wikimedia Commons (CC BY 4.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:San_Vicente,_Milkshake,_Palawan,_Philippines.jpg", "image_is_illustrative": true}]
14	33	Fry Bucket	\N	0	2026-09-10 02:46:03.073202	Fry Bucket is built around shareable buckets of crispy fried chicken, wings and sides.	Fried Chicken	/media/dish-chicken-bucket.jpg	Biswarup Ganguly / Wikimedia Commons (CC BY 3.0) · illustrative photo	https://commons.wikimedia.org/wiki/File:KFC_-_Pressure-fried_Chicken_-_Howrah_2014-03-23_9718.JPG	t	t	added-fry-bucket	\N	\N	t	/media/logo-fry-bucket.png	https://commons.wikimedia.org/wiki/Commons:Licensing	\N	brand	[{"caption": "Chicken Bucket (8 pcs)", "image_url": "/media/dish-chicken-bucket.jpg", "image_credit": "Biswarup Ganguly / Wikimedia Commons (CC BY 3.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:KFC_-_Pressure-fried_Chicken_-_Howrah_2014-03-23_9718.JPG", "image_is_illustrative": true}, {"caption": "Fried Chicken (2 pcs)", "image_url": "/media/dish-fried-chicken.jpg", "image_credit": "Evan-Amos / Wikimedia Commons (CC0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Fried-Chicken-Set.jpg", "image_is_illustrative": true}, {"caption": "Hot Wings (6 pcs)", "image_url": "/media/dish-chicken-wings.jpg", "image_credit": "stef yau / Wikimedia Commons (CC BY 2.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Homemade_buffalo_wings.jpg", "image_is_illustrative": true}, {"caption": "Crispy Burger", "image_url": "/media/dish-chicken-burger.jpg", "image_credit": "BrokenSphere / Wikimedia Commons (CC BY-SA 3.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:BK_Original_Chicken_Sandwich.JPG", "image_is_illustrative": true}, {"caption": "French Fries", "image_url": "/media/dish-fries.jpg", "image_credit": "Chris Woodrich / Wikimedia Commons (Public domain) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:McDonald%27s_French_Fries,_Canada,_2026-04-04.jpg", "image_is_illustrative": true}, {"caption": "Coleslaw", "image_url": "/media/dish-coleslaw.jpg", "image_credit": "Wikimedia Commons contributor / Wikimedia Commons (CC BY-SA 2.0) · illustrative photo", "image_source_url": "https://commons.wikimedia.org/wiki/File:Bowl%27o%27Coleslaw_modified.jpg", "image_is_illustrative": true}]
\.


--
-- Data for Name: revoked_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.revoked_tokens (id, user_id, jti, expires_at, revoked_at) FROM stdin;
1	9	4a90f571a6d6e33d02e96241940c1f38	2026-09-16 00:13:30	2026-09-09 09:16:03.179921
2	10	deb3b0ef2e4cd37baa00b4a0b31ca0eb	2026-09-16 09:16:41	2026-09-09 09:17:13.567926
3	10	9d204f79691703a8b92c4e6b36f75039	2026-09-16 09:17:33	2026-09-09 10:39:17.260237
4	11	fd0ad2df7429bd95fc311de325a1a154	2026-09-16 10:40:01	2026-09-09 21:19:38.045058
5	12	b9d147528487c0b440417788b50ee154	2026-09-16 21:20:50	2026-09-09 21:20:58.319646
6	12	cc7a4db5795720ff87755bf9bb3d64f7	2026-09-16 21:35:02	2026-09-09 21:35:14.503713
7	10	8ef37bbaf77c8760faaac0e01013233b	2026-09-16 21:35:35	2026-09-09 21:36:25.601853
8	10	23b66a4eebee6071f1c0599e8d68b851	2026-09-16 21:21:03	2026-09-09 22:14:41.73887
9	12	30b70e6d57462dc2398d3784523c4479	2026-09-16 22:14:46	2026-09-09 22:14:54.721
10	10	90234ed07e17e747a461dfb808da5e1e	2026-09-16 21:56:33	2026-09-09 23:20:23.95954
11	12	c850e10557314c78f4f7e3f63c9d5b0e	2026-09-16 23:21:03	2026-09-09 23:22:39.563236
12	10	f7304b7f7d7af2738b6f5ac3ddfcf6de	2026-09-16 22:14:59	2026-09-10 00:17:42.010208
13	12	3d3d21af7569a6b9840c1f9c16f93618	2026-09-17 00:17:46	2026-09-10 00:18:18.509561
14	10	07931bd2bcabfe6b19d7371f08e6d9d6	2026-09-17 00:18:22	2026-09-10 00:27:08.243513
15	12	a41885e433f410aacd424ee979088ab3	2026-09-17 00:27:11	2026-09-10 00:27:30.043762
16	9	49e080939796a3654f971e15387f22ab	2026-09-17 00:27:37	2026-09-10 00:28:08.461874
17	28	96d8f8faa2aefd4d9d415a64702db989	2026-09-17 00:28:49	2026-09-10 00:30:07.16031
18	28	2be2e4ba22319d564fad62c83e2a8bc4	2026-09-17 00:40:46	2026-09-10 00:41:10.843514
19	10	d08a2b4fd3b7e469a5d42458feb61118	2026-09-17 00:44:05	2026-09-10 00:44:49.011453
20	13	ab3cc925cd10a3ba5b62203b165e814a	2026-09-17 00:45:59	2026-09-10 00:46:54.358405
21	12	86e973e6cf633693714fb6720344f48d	2026-09-17 00:47:04	2026-09-10 00:47:20.574653
22	10	8c0fb07a51eb48f3c95f39236faea845	2026-09-17 00:47:23	2026-09-10 00:48:16.082148
23	10	a5649f365cdbbddb8bb0c5a72718333e	2026-09-17 00:48:35	2026-09-10 00:52:28.422244
24	14	4be39bccc6f268e79cdcc2af12e46beb	2026-09-17 00:54:20	2026-09-10 00:54:46.172274
25	12	e3e948d2aaaf38ffd33a5968e67f5cd7	2026-09-17 00:54:50	2026-09-10 00:55:15.471118
26	10	518843ba1999fc874c8124e092c704d7	2026-09-17 00:55:18	2026-09-10 00:57:58.790925
27	10	c81431cf50f3394e870d5ca4a29a7d7a	2026-09-17 01:00:03	2026-09-10 01:00:22.173957
28	10	a8345ebb08b4b479891e6307f8e19d84	2026-09-17 01:00:23	2026-09-10 01:13:30.621464
29	14	ee620b7f6769abd359a48ee7ec9bfc13	2026-09-17 01:13:35	2026-09-10 01:14:30.455177
30	12	d4d345a024196d53e99af2918bbafd11	2026-09-17 01:14:35	2026-09-10 01:14:56.354956
31	10	ac7cefd1a3d0091d5a53f3a6ed21ff7f	2026-09-17 01:14:59	2026-09-10 01:15:14.721469
32	12	273f97c055ebe4badf307876352ef1e9	2026-09-17 01:15:20	2026-09-10 01:15:30.987369
33	10	b5154b2223ac40e7f9dc62f0dcb8b38a	2026-09-17 01:15:33	2026-09-10 01:30:58.521275
34	10	79caede5d167f30a94fb5dde8c687ef5	2026-09-17 01:38:30	2026-09-10 02:40:48.540089
35	10	765dae60f2e933de353c057961dfa866	2026-09-17 02:40:52	2026-09-10 02:41:02.106768
36	10	cff77581b7c9a620fe835f288f70453e	2026-09-17 02:53:05	2026-09-10 06:21:16.934049
37	10	443b1488c39e34ab89fe0ba3e8968dae	2026-09-17 06:21:54	2026-09-10 06:25:35.329566
38	12	180c110405c355f0ce866c5db2d8f7e2	2026-09-17 06:25:46	2026-09-10 06:26:20.396143
39	12	79caff5e39a4e6e6833987847127d5b1	2026-09-16 21:36:32	2026-09-10 23:48:06.485059
40	10	8e0a08d002c09a477b2e7a2cbafc4a2a	2026-09-17 23:48:18	2026-09-10 23:48:58.538434
41	14	99dd32b778d1980611cd5642b8cf4daf	2026-09-17 23:49:52	2026-09-10 23:50:15.304377
42	12	8c74fb464a6ccd7e551ed39ce1cabc04	2026-09-17 06:28:17	2026-09-11 09:43:15.192627
43	10	e5a73b27aec187b9c2eaa5fdb597540d	2026-09-18 09:43:25	2026-09-11 09:44:37.138253
44	14	d6970d62facec51e60d5aa95c7fae901	2026-09-18 09:44:51	2026-09-11 09:45:57.820734
45	12	b98024225ef7abe92927e78b3a166ca8	2026-09-18 09:46:10	2026-09-11 09:46:33.186267
46	10	b023b10c6ae1bd3972e7fd43ae9e30bc	2026-09-18 09:46:38	2026-09-11 09:47:43.114325
47	12	f7e50699dc3d840b70ea1f5a5bc9d291	2026-09-18 09:50:45	2026-09-11 09:50:48.266005
48	10	b9a7519df0836dd01a2e76df876f40b6	2026-09-18 09:50:51	2026-09-12 23:02:55.22351
49	14	a77601e10a4f6a889483e324483675d8	2026-09-19 23:03:02	2026-09-12 23:03:31.94155
50	12	61216806d08cf27c2c2b18cd2787c46c	2026-09-19 23:03:36	2026-09-12 23:04:00.124219
51	10	7c91b0028305cd2e1d1ff5bcac9c3631	2026-09-19 23:04:05	2026-09-14 21:33:17.772437
52	10	c0428a6c40b2fb813f5c087b93498f65	2026-09-21 21:33:27	2026-09-14 23:45:00.805934
53	10	c500a210a36d2fab93610150a5901f74	2026-09-21 23:45:18	2026-09-14 23:45:51.608337
54	14	a12c924cc7efaef1aec7f093246add73	2026-09-21 23:46:17	2026-09-14 23:46:52.775251
55	14	890eabb5267340cc71b02d03b61b2b0b	2026-09-21 23:46:56	2026-09-14 23:46:59.608478
56	10	f08394ce35f0d225bfbb4a0baf2bb50c	2026-09-21 23:47:08	2026-09-14 23:48:56.325737
57	14	06a9392ba6e31a71dd9c1c2cc13db8bf	2026-09-21 23:49:01	2026-09-14 23:49:29.859863
58	12	b130f62beab09c85b225b5f7811de87f	2026-09-21 23:49:36	2026-09-14 23:50:46.010694
\.


--
-- Data for Name: rider_profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rider_profiles (id, user_id, vehicle_type, status) FROM stdin;
1	7	motorcycle	online
2	8	bicycle	offline
3	11	\N	offline
4	12	bicycle	online
\.


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.schema_migrations (name, checksum, applied_at) FROM stdin;
001_modifiers.sql	efbe4176cca12cf4c67296d6aadb5883ffa211783a66e2a8972ef27b8279601d	2026-09-09 21:31:46.994372-07
002_restaurant_ratings.sql	864b1821b3b530495e58b2fb8a6c97bf93f258bf49b3aa9c5fe28c28afe1e05e	2026-09-09 21:31:46.994372-07
003_marketplace.sql	b5dcc787d7129603a6b3dfe45ba0dd638cfc80d12016ec4c09e36e05be3b9a77	2026-09-09 21:31:46.994372-07
004_operations.sql	7f4d761290e187b811ea7a69153aa260725b396e3ef28fdb88b64d6326fa9067	2026-09-09 21:31:46.994372-07
005_catalog_sources.sql	fd227d0efb5fe8fe788785edfb4c5c006e5c929ac9905aeba5fbda8794bece39	2026-09-09 23:56:08.404347-07
\.


--
-- Data for Name: support_tickets; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.support_tickets (id, user_id, order_id, subject, message, status, admin_reply, resolved_by, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, name, email, password, role, phone, is_active, created_at) FROM stdin;
9	Admin	admin@cravio.com	$2b$10$aKSByR.CT0a5zo0XliOzTefgjTV1vqDHhw1tlgNGqoc9jqTKv61XG	admin	0000000000	t	2026-09-08 22:47:58.757438
10	ATIK KHAN	atik.khan3477@gmail.com	$2b$10$WzVlGRVHiUBMp6yac5sSY.vu3nz7tlnNMHmB18/./rZkWOVDB5Ili	customer	01711137457	t	2026-09-09 09:16:41.782187
11	Ahnaf Shafi	ahnaf@gmail.com	$2b$10$AvTzgcMLH4XHhP6W1HoYyuxG/YU1ec1hTTAXJJXVO6wr1kfgkDFy2	rider	01888888888	t	2026-09-09 10:40:01.74565
12	Ramim	ramim@gmail.com	$2b$10$4Js9Wq..EMeztdpqFd2XPORfvJ.nW2lBervkoIdrWrd6Fr8S13T9G	rider	+8801711137457	t	2026-09-09 21:20:49.986465
13	Kacchi Bhai Operations	owner.kacchibhai@cravio.test	$2b$10$uqkzWSXOE1oyyXvlhUXoBOyR6T88gXNwnGlqV3twiaiNYkvw33JW.	restaurant_owner	01711000030	t	2026-09-10 00:00:29.719907
14	KFC Operations	owner.kfc@cravio.test	$2b$10$uqkzWSXOE1oyyXvlhUXoBOyR6T88gXNwnGlqV3twiaiNYkvw33JW.	restaurant_owner	01711000031	t	2026-09-10 00:00:29.719907
15	BFC Operations	owner.bfc@cravio.test	$2b$10$uqkzWSXOE1oyyXvlhUXoBOyR6T88gXNwnGlqV3twiaiNYkvw33JW.	restaurant_owner	01711000032	t	2026-09-10 00:00:29.719907
16	Chillox Operations	owner.chillox@cravio.test	$2b$10$uqkzWSXOE1oyyXvlhUXoBOyR6T88gXNwnGlqV3twiaiNYkvw33JW.	restaurant_owner	01711000033	t	2026-09-10 00:00:29.719907
28	Kacchi Vai	kacchivai@gmail.com	$2b$10$NKsjAOzGjcONQXHgrB9sjuYBCxuJnuzBvj4USmhiuCrOIAsmv1E7i	restaurant_owner	+8801886946634	t	2026-09-10 00:28:49.466798
3	Nabila Chowdhury	nabila@example.com	$2b$10$es7MdInJUTprLg0x3YRq.u6xQKzjWuCm9c7Qr3WjQJoeT.ci.SavC	restaurant_owner	01711000010	t	2026-09-08 22:47:46.197133
4	Rafiq Islam	rafiq@example.com	$2b$10$es7MdInJUTprLg0x3YRq.u6xQKzjWuCm9c7Qr3WjQJoeT.ci.SavC	restaurant_owner	01711000011	t	2026-09-08 22:47:46.197133
5	Sadia Karim	sadia@example.com	$2b$10$es7MdInJUTprLg0x3YRq.u6xQKzjWuCm9c7Qr3WjQJoeT.ci.SavC	restaurant_owner	01711000012	t	2026-09-08 22:47:46.197133
6	Imran Bhuiyan	imran@example.com	$2b$10$es7MdInJUTprLg0x3YRq.u6xQKzjWuCm9c7Qr3WjQJoeT.ci.SavC	restaurant_owner	01711000013	t	2026-09-08 22:47:46.197133
1	Ayesha Rahman	ayesha@example.com	$2b$10$M0iE.7eAZeFKH5SEvJd2auWrlFEthlpdPgj5Qe9BGQXBX0Vir8BfK	customer	01711000001	t	2026-09-08 22:47:46.197133
2	Tanvir Hossain	tanvir@example.com	$2b$10$M0iE.7eAZeFKH5SEvJd2auWrlFEthlpdPgj5Qe9BGQXBX0Vir8BfK	customer	01711000002	t	2026-09-08 22:47:46.197133
7	Jahangir Alam	jahangir@example.com	$2b$10$M0iE.7eAZeFKH5SEvJd2auWrlFEthlpdPgj5Qe9BGQXBX0Vir8BfK	rider	01711000020	t	2026-09-08 22:47:46.197133
8	Shuvo Das	shuvo@example.com	$2b$10$M0iE.7eAZeFKH5SEvJd2auWrlFEthlpdPgj5Qe9BGQXBX0Vir8BfK	rider	01711000021	t	2026-09-08 22:47:46.197133
29	Sultan's Dine Operations	sultandine@gmail.com	$2b$10$/ECh1HcibGWQTOmPzS55VOs22GDeR4CGEcT6QJvihVVPsu3FXFkuu	restaurant_owner	01711000040	t	2026-09-10 02:46:03.073202
30	Khana's Operations	khanas@gmail.com	$2b$10$/ECh1HcibGWQTOmPzS55VOs22GDeR4CGEcT6QJvihVVPsu3FXFkuu	restaurant_owner	01711000041	t	2026-09-10 02:46:03.073202
31	Domino's Pizza Operations	domino@gmail.com	$2b$10$/ECh1HcibGWQTOmPzS55VOs22GDeR4CGEcT6QJvihVVPsu3FXFkuu	restaurant_owner	01711000042	t	2026-09-10 02:46:03.073202
32	Takeout Operations	take@gmail.com	$2b$10$/ECh1HcibGWQTOmPzS55VOs22GDeR4CGEcT6QJvihVVPsu3FXFkuu	restaurant_owner	01711000043	t	2026-09-10 02:46:03.073202
33	Fry Bucket Operations	frybucket@gmail.com	$2b$10$/ECh1HcibGWQTOmPzS55VOs22GDeR4CGEcT6QJvihVVPsu3FXFkuu	restaurant_owner	01711000044	t	2026-09-10 02:46:03.073202
\.


--
-- Name: cart_item_modifiers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cart_item_modifiers_id_seq', 1, false);


--
-- Name: cart_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.cart_items_id_seq', 37, true);


--
-- Name: carts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.carts_id_seq', 37, true);


--
-- Name: customer_addresses_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.customer_addresses_id_seq', 1, true);


--
-- Name: deliveries_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.deliveries_id_seq', 11, true);


--
-- Name: menu_categories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.menu_categories_id_seq', 60, true);


--
-- Name: menu_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.menu_items_id_seq', 275, true);


--
-- Name: modifier_groups_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.modifier_groups_id_seq', 6, true);


--
-- Name: modifier_options_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.modifier_options_id_seq', 18, true);


--
-- Name: order_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.order_events_id_seq', 83, true);


--
-- Name: order_item_modifiers_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.order_item_modifiers_id_seq', 1, false);


--
-- Name: order_items_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.order_items_id_seq', 32, true);


--
-- Name: orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.orders_id_seq', 26, true);


--
-- Name: payments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payments_id_seq', 26, true);


--
-- Name: promo_codes_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.promo_codes_id_seq', 3, true);


--
-- Name: quality_flag_log_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.quality_flag_log_id_seq', 1, true);


--
-- Name: restaurant_branches_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.restaurant_branches_id_seq', 270, true);


--
-- Name: restaurant_reviews_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.restaurant_reviews_id_seq', 5, true);


--
-- Name: restaurants_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.restaurants_id_seq', 14, true);


--
-- Name: revoked_tokens_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.revoked_tokens_id_seq', 58, true);


--
-- Name: rider_profiles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.rider_profiles_id_seq', 8, true);


--
-- Name: support_tickets_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.support_tickets_id_seq', 1, false);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.users_id_seq', 38, true);


--
-- Name: cart_item_modifiers cart_item_modifiers_cart_item_id_modifier_option_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_item_modifiers
    ADD CONSTRAINT cart_item_modifiers_cart_item_id_modifier_option_id_key UNIQUE (cart_item_id, modifier_option_id);


--
-- Name: cart_item_modifiers cart_item_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_item_modifiers
    ADD CONSTRAINT cart_item_modifiers_pkey PRIMARY KEY (id);


--
-- Name: cart_items cart_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_pkey PRIMARY KEY (id);


--
-- Name: carts carts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_pkey PRIMARY KEY (id);


--
-- Name: carts carts_user_id_restaurant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_user_id_restaurant_id_key UNIQUE (user_id, restaurant_id);


--
-- Name: customer_addresses customer_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_pkey PRIMARY KEY (id);


--
-- Name: customer_favorites customer_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_favorites
    ADD CONSTRAINT customer_favorites_pkey PRIMARY KEY (user_id, restaurant_id);


--
-- Name: deliveries deliveries_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_order_id_key UNIQUE (order_id);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: menu_categories menu_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT menu_categories_pkey PRIMARY KEY (id);


--
-- Name: menu_items menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);


--
-- Name: modifier_groups modifier_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_pkey PRIMARY KEY (id);


--
-- Name: modifier_options modifier_options_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options
    ADD CONSTRAINT modifier_options_pkey PRIMARY KEY (id);


--
-- Name: order_events order_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_pkey PRIMARY KEY (id);


--
-- Name: order_item_modifiers order_item_modifiers_order_item_id_modifier_option_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_order_item_id_modifier_option_id_key UNIQUE (order_item_id, modifier_option_id);


--
-- Name: order_item_modifiers order_item_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: payments payments_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_key UNIQUE (order_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: promo_codes promo_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_code_key UNIQUE (code);


--
-- Name: promo_codes promo_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);


--
-- Name: quality_flag_log quality_flag_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_flag_log
    ADD CONSTRAINT quality_flag_log_pkey PRIMARY KEY (id);


--
-- Name: restaurant_branches restaurant_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_branches
    ADD CONSTRAINT restaurant_branches_pkey PRIMARY KEY (id);


--
-- Name: restaurant_reviews restaurant_reviews_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_reviews
    ADD CONSTRAINT restaurant_reviews_order_id_key UNIQUE (order_id);


--
-- Name: restaurant_reviews restaurant_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_reviews
    ADD CONSTRAINT restaurant_reviews_pkey PRIMARY KEY (id);


--
-- Name: restaurants restaurants_catalog_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_catalog_slug_key UNIQUE (catalog_slug);


--
-- Name: restaurants restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_pkey PRIMARY KEY (id);


--
-- Name: revoked_tokens revoked_tokens_jti_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revoked_tokens
    ADD CONSTRAINT revoked_tokens_jti_key UNIQUE (jti);


--
-- Name: revoked_tokens revoked_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revoked_tokens
    ADD CONSTRAINT revoked_tokens_pkey PRIMARY KEY (id);


--
-- Name: rider_profiles rider_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_profiles
    ADD CONSTRAINT rider_profiles_pkey PRIMARY KEY (id);


--
-- Name: rider_profiles rider_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_profiles
    ADD CONSTRAINT rider_profiles_user_id_key UNIQUE (user_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_branches_division; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branches_division ON public.restaurant_branches USING btree (division);


--
-- Name: idx_cart_item_modifiers_cart_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_item_modifiers_cart_item ON public.cart_item_modifiers USING btree (cart_item_id);


--
-- Name: idx_cart_items_cart_menu_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_items_cart_menu_item ON public.cart_items USING btree (cart_id, menu_item_id);


--
-- Name: idx_deliveries_rider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliveries_rider ON public.deliveries USING btree (rider_id, delivery_status);


--
-- Name: idx_modifier_groups_menu_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modifier_groups_menu_item ON public.modifier_groups USING btree (menu_item_id);


--
-- Name: idx_modifier_options_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_modifier_options_group ON public.modifier_options USING btree (modifier_group_id);


--
-- Name: idx_order_events_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_events_order ON public.order_events USING btree (order_id, id);


--
-- Name: idx_order_item_modifiers_order_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_item_modifiers_order_item ON public.order_item_modifiers USING btree (order_item_id);


--
-- Name: idx_orders_branch_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_branch_status_created ON public.orders USING btree (branch_id, status, created_at DESC);


--
-- Name: idx_orders_customer_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_customer_created ON public.orders USING btree (customer_id, created_at DESC);


--
-- Name: idx_restaurant_branches_restaurant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurant_branches_restaurant ON public.restaurant_branches USING btree (restaurant_id);


--
-- Name: idx_restaurants_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restaurants_owner ON public.restaurants USING btree (owner_id);


--
-- Name: idx_support_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_status_created ON public.support_tickets USING btree (status, created_at DESC);


--
-- Name: idx_support_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_user_created ON public.support_tickets USING btree (user_id, created_at DESC);


--
-- Name: orders trg_record_order_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_record_order_event AFTER INSERT OR UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.record_order_event();


--
-- Name: restaurant_reviews trg_sync_restaurant_rating; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_restaurant_rating AFTER INSERT OR DELETE OR UPDATE ON public.restaurant_reviews FOR EACH ROW EXECUTE FUNCTION public.sync_restaurant_rating();


--
-- Name: cart_item_modifiers cart_item_modifiers_cart_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_item_modifiers
    ADD CONSTRAINT cart_item_modifiers_cart_item_id_fkey FOREIGN KEY (cart_item_id) REFERENCES public.cart_items(id) ON DELETE CASCADE;


--
-- Name: cart_item_modifiers cart_item_modifiers_modifier_option_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_item_modifiers
    ADD CONSTRAINT cart_item_modifiers_modifier_option_id_fkey FOREIGN KEY (modifier_option_id) REFERENCES public.modifier_options(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_cart_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES public.carts(id) ON DELETE CASCADE;


--
-- Name: cart_items cart_items_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_items
    ADD CONSTRAINT cart_items_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: carts carts_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: carts carts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: customer_favorites customer_favorites_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_favorites
    ADD CONSTRAINT customer_favorites_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: customer_favorites customer_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_favorites
    ADD CONSTRAINT customer_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: deliveries deliveries_rider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_rider_id_fkey FOREIGN KEY (rider_id) REFERENCES public.users(id);


--
-- Name: menu_categories menu_categories_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_categories
    ADD CONSTRAINT menu_categories_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: menu_items menu_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.menu_categories(id) ON DELETE SET NULL;


--
-- Name: menu_items menu_items_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: modifier_groups modifier_groups_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_groups
    ADD CONSTRAINT modifier_groups_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: modifier_options modifier_options_modifier_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.modifier_options
    ADD CONSTRAINT modifier_options_modifier_group_id_fkey FOREIGN KEY (modifier_group_id) REFERENCES public.modifier_groups(id) ON DELETE CASCADE;


--
-- Name: order_events order_events_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_item_modifiers order_item_modifiers_modifier_option_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_modifier_option_id_fkey FOREIGN KEY (modifier_option_id) REFERENCES public.modifier_options(id);


--
-- Name: order_item_modifiers order_item_modifiers_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id);


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: orders orders_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.restaurant_branches(id);


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.users(id);


--
-- Name: orders orders_promo_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_promo_code_id_fkey FOREIGN KEY (promo_code_id) REFERENCES public.promo_codes(id);


--
-- Name: orders orders_rider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_rider_id_fkey FOREIGN KEY (rider_id) REFERENCES public.users(id);


--
-- Name: payments payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: quality_flag_log quality_flag_log_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_flag_log
    ADD CONSTRAINT quality_flag_log_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id);


--
-- Name: quality_flag_log quality_flag_log_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_flag_log
    ADD CONSTRAINT quality_flag_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: restaurant_branches restaurant_branches_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_branches
    ADD CONSTRAINT restaurant_branches_restaurant_id_fkey FOREIGN KEY (restaurant_id) REFERENCES public.restaurants(id) ON DELETE CASCADE;


--
-- Name: restaurant_reviews restaurant_reviews_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurant_reviews
    ADD CONSTRAINT restaurant_reviews_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: restaurants restaurants_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restaurants
    ADD CONSTRAINT restaurants_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: revoked_tokens revoked_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revoked_tokens
    ADD CONSTRAINT revoked_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: rider_profiles rider_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rider_profiles
    ADD CONSTRAINT rider_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: support_tickets support_tickets_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: support_tickets support_tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict frTzHE6jiEckT5AKEvykmrTJBRxFwQU1eekxTeYykPhmblHVQchNfLiGoBk5uAC


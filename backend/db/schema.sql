-- ============================================================
-- CRAVIO DATABASE SCHEMA
-- Final Version | PostgreSQL 16
-- 19 Tables
-- ============================================================


-- ============================================================
-- DATABASE STRUCTURE
-- ============================================================

DROP TABLE IF EXISTS
    cart_item_modifiers,
    cart_items,
    carts,

    order_item_modifiers,

    quality_flag_log,
    rider_reviews,
    restaurant_reviews,
    deliveries,
    payments,

    order_items,
    orders,

    promo_codes,

    modifier_options,
    modifier_groups,

    menu_items,
    menu_categories,

    restaurant_branches,
    restaurants,

    customer_addresses,
    rider_profiles,

    users,
    user_sessions

CASCADE;



-- ============================================================
-- 1. USERS
-- ============================================================

CREATE TABLE users (

    id SERIAL PRIMARY KEY,

    name VARCHAR(100) NOT NULL,

    email VARCHAR(100)
        UNIQUE
        NOT NULL,

    password VARCHAR(255)
        NOT NULL,

    role VARCHAR(20)
        NOT NULL
        CHECK (
            role IN
            (
                'customer',
                'restaurant_owner',
                'rider',
                'admin'
            )
        ),

    phone VARCHAR(20),

    is_active BOOLEAN
        NOT NULL
        DEFAULT true,

    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);




-- ============================================================
-- 2. RIDER PROFILE
-- ============================================================

CREATE TABLE rider_profiles (

    id SERIAL PRIMARY KEY,

    user_id INTEGER
        REFERENCES users(id)
        ON DELETE CASCADE
        UNIQUE,

    vehicle_type VARCHAR(20)
        CHECK (
            vehicle_type IN
            (
                'bicycle',
                'motorcycle',
                'car'
            )
        ),

    status VARCHAR(20)
        DEFAULT 'offline'
        CHECK (
            status IN
            (
                'online',
                'offline',
                'busy'
            )
        )
);



-- ============================================================
-- 3. CUSTOMER ADDRESS
-- ============================================================

CREATE TABLE customer_addresses (

    id SERIAL PRIMARY KEY,

    user_id INTEGER
        REFERENCES users(id)
        ON DELETE CASCADE,

    label VARCHAR(50)
        CHECK (
            label IN
            (
                'Home',
                'Work',
                'Other'
            )
        ),

    area VARCHAR(100)
        NOT NULL,

    full_address TEXT
        NOT NULL,

    is_default BOOLEAN
        DEFAULT false
);



-- ============================================================
-- 4. RESTAURANTS
-- ============================================================

CREATE TABLE restaurants (

    id SERIAL PRIMARY KEY,

    owner_id INTEGER
        REFERENCES users(id)
        ON DELETE CASCADE,

    name VARCHAR(100)
        NOT NULL,

    -- Both columns are derived from restaurant_reviews and are maintained
    -- by the trigger in db/functions/restaurant_rating.sql — never written
    -- by application code. Stored rather than computed on every read
    -- because ratings are read on almost every page and written only when
    -- a delivered order is reviewed.
    --
    -- avg_rating is nullable on purpose: NULL means "not yet rated", which
    -- a default of 0.0 would misreport as the worst possible score.
    avg_rating NUMERIC(3,2),

    review_count INTEGER
        NOT NULL
        DEFAULT 0,

    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);



-- ============================================================
-- 5. RESTAURANT BRANCHES
-- ============================================================

CREATE TABLE restaurant_branches (

    id SERIAL PRIMARY KEY,

    restaurant_id INTEGER
        REFERENCES restaurants(id)
        ON DELETE CASCADE,

    address TEXT
        NOT NULL,

    area VARCHAR(100)
        NOT NULL,

    city VARCHAR(100)
        NOT NULL,

    phone VARCHAR(20),

    latitude DECIMAL(9,6),

    longitude DECIMAL(9,6),

    is_open BOOLEAN
        DEFAULT true
);



-- ============================================================
-- 6. MENU CATEGORIES
-- ============================================================

CREATE TABLE menu_categories (

    id SERIAL PRIMARY KEY,

    restaurant_id INTEGER
        REFERENCES restaurants(id)
        ON DELETE CASCADE,

    name VARCHAR(50)
        NOT NULL
);



-- ============================================================
-- 7. MENU ITEMS
-- ============================================================

CREATE TABLE menu_items (

    id SERIAL PRIMARY KEY,


    category_id INTEGER
        REFERENCES menu_categories(id)
        ON DELETE SET NULL,


    restaurant_id INTEGER
        REFERENCES restaurants(id)
        ON DELETE CASCADE,


    name VARCHAR(100)
        NOT NULL,


    description TEXT,


    price DECIMAL(10,2)
        NOT NULL,


    image_url VARCHAR(255),


    is_available BOOLEAN
        DEFAULT true,


    is_veg BOOLEAN
        DEFAULT false,


    quality_flag BOOLEAN
        DEFAULT false,


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);



-- ============================================================
-- 8. MODIFIER GROUPS
-- ============================================================

CREATE TABLE modifier_groups (

    id SERIAL PRIMARY KEY,


    menu_item_id INTEGER
        REFERENCES menu_items(id)
        ON DELETE CASCADE,


    name VARCHAR(100)
        NOT NULL,


    is_required BOOLEAN
        DEFAULT false,


    min_selection INTEGER
        DEFAULT 0,


    max_selection INTEGER
        DEFAULT 1,


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);



-- ============================================================
-- 9. MODIFIER OPTIONS
-- ============================================================

CREATE TABLE modifier_options (

    id SERIAL PRIMARY KEY,


    modifier_group_id INTEGER
        REFERENCES modifier_groups(id)
        ON DELETE CASCADE,


    name VARCHAR(100)
        NOT NULL,


    price_modifier DECIMAL(10,2)
        DEFAULT 0.00,


    is_available BOOLEAN
        DEFAULT true,


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);



-- ============================================================
-- 10. PROMO CODES
-- ============================================================

CREATE TABLE promo_codes (

    id SERIAL PRIMARY KEY,


    code VARCHAR(20)
        UNIQUE
        NOT NULL,


    discount_percent INTEGER
        CHECK (
            discount_percent BETWEEN 1 AND 100
        ),


    min_order_amount DECIMAL(10,2)
        DEFAULT 0,


    expiry_date DATE
        NOT NULL,


    is_active BOOLEAN
        DEFAULT true,


    usage_limit INTEGER
        DEFAULT 100,


    used_count INTEGER
        DEFAULT 0
);


-- ============================================================
-- 11. ORDERS
-- ============================================================

CREATE TABLE orders (

    id SERIAL PRIMARY KEY,


    customer_id INTEGER
        REFERENCES users(id),


    rider_id INTEGER
        REFERENCES users(id),


    branch_id INTEGER
        REFERENCES restaurant_branches(id),


    promo_code_id INTEGER
        REFERENCES promo_codes(id),


    delivery_address TEXT
        NOT NULL,


    subtotal DECIMAL(10,2)
        NOT NULL,


    discount_amount DECIMAL(10,2)
        DEFAULT 0,


    total_amount DECIMAL(10,2)
        NOT NULL,


    status VARCHAR(30)
        DEFAULT 'pending'
        CHECK (
            status IN
            (
                'pending',
                'confirmed',
                'preparing',
                'out_for_delivery',
                'delivered',
                'cancelled'
            )
        ),


    review_eligible BOOLEAN
        DEFAULT false,


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);



-- ============================================================
-- 12. ORDER ITEMS
-- ============================================================

CREATE TABLE order_items (

    id SERIAL PRIMARY KEY,


    order_id INTEGER
        REFERENCES orders(id)
        ON DELETE CASCADE,


    menu_item_id INTEGER
        REFERENCES menu_items(id),


    quantity INTEGER
        NOT NULL
        CHECK(quantity > 0),


    unit_price DECIMAL(10,2)
        NOT NULL,


    special_instruction TEXT
);



-- ============================================================
-- 13. PAYMENTS
-- ============================================================

CREATE TABLE payments (

    id SERIAL PRIMARY KEY,


    order_id INTEGER
        REFERENCES orders(id)
        UNIQUE,


    method VARCHAR(20)
        CHECK (
            method IN
            (
                'cash_on_delivery',
                'bkash',
                'nagad'
            )
        ),


    amount DECIMAL(10,2)
        NOT NULL,


    status VARCHAR(20)
        DEFAULT 'unpaid'
        CHECK (
            status IN
            (
                'unpaid',
                'paid',
                'failed'
            )
        ),


    transaction_ref VARCHAR(100),


    paid_at TIMESTAMP
);



-- ============================================================
-- 14. DELIVERIES
-- ============================================================

CREATE TABLE deliveries (

    id SERIAL PRIMARY KEY,


    order_id INTEGER
        REFERENCES orders(id)
        UNIQUE,


    rider_id INTEGER
        REFERENCES users(id),


    delivery_status VARCHAR(30)
        DEFAULT 'assigned'
        CHECK (
            delivery_status IN
            (
                'assigned',
                'picked_up',
                'delivered'
            )
        ),


    delivery_time TIMESTAMP,


    recipient_note TEXT
);



-- ============================================================
-- 15. RESTAURANT REVIEWS
-- ============================================================

CREATE TABLE restaurant_reviews (

    id SERIAL PRIMARY KEY,


    order_id INTEGER
        REFERENCES orders(id)
        UNIQUE,


    -- customer_id INTEGER
    --     REFERENCES users(id),


    -- restaurant_id INTEGER
    --     REFERENCES restaurants(id),


    rating INTEGER
        CHECK (
            rating BETWEEN 1 AND 5
        ),


    portion_accuracy VARCHAR(20)
        CHECK (
            portion_accuracy IN
            (
                'full',
                'slightly_less',
                'way_less'
            )
        ),


    comment TEXT,


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);



-- ============================================================
-- 16. QUALITY FLAG LOG
-- ============================================================

CREATE TABLE quality_flag_log (

    id SERIAL PRIMARY KEY,


    menu_item_id INTEGER
        REFERENCES menu_items(id),


    order_id INTEGER
        REFERENCES orders(id),


    flagged_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 17. CARTS
-- ============================================================

CREATE TABLE carts (

    id SERIAL PRIMARY KEY,


    user_id INTEGER
        REFERENCES users(id)
        ON DELETE CASCADE,


    restaurant_id INTEGER
        REFERENCES restaurants(id)
        ON DELETE CASCADE,


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP,


    updated_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP,


    -- One active cart per user per restaurant
    UNIQUE(user_id, restaurant_id)
);



-- ============================================================
-- 18. CART ITEMS
-- ============================================================

CREATE TABLE cart_items (

    id SERIAL PRIMARY KEY,


    cart_id INTEGER
        REFERENCES carts(id)
        ON DELETE CASCADE,


    menu_item_id INTEGER
        REFERENCES menu_items(id)
        ON DELETE CASCADE,


    quantity INTEGER
        NOT NULL
        CHECK(quantity > 0),


    created_at TIMESTAMP
        DEFAULT CURRENT_TIMESTAMP


    -- NOTE: there is deliberately no UNIQUE(cart_id, menu_item_id) here.
    -- A cart line is the menu item PLUS its chosen modifiers, so the same
    -- dish ordered two different ways ("extra cheese" vs "no basil") must
    -- be two rows. Merging identical configurations is handled in
    -- routes/cart.js, which can compare modifier sets — something a table
    -- constraint cannot do. See db/migrations/001_modifiers.sql.
);


CREATE INDEX idx_cart_items_cart_menu_item
    ON cart_items(cart_id, menu_item_id);



-- ============================================================
-- 19. CART ITEM MODIFIERS
-- ============================================================

CREATE TABLE cart_item_modifiers (

    id SERIAL PRIMARY KEY,


    cart_item_id INTEGER
        REFERENCES cart_items(id)
        ON DELETE CASCADE,


    modifier_option_id INTEGER
        REFERENCES modifier_options(id)
        ON DELETE CASCADE,


    UNIQUE(cart_item_id, modifier_option_id)
);



-- ============================================================
-- 20. ORDER ITEM MODIFIERS
--
-- The order-side counterpart of cart_item_modifiers. The cart rows are
-- deleted at checkout, so the chosen modifiers have to be copied onto the
-- order or they are lost — the kitchen would never see "extra cheese" and
-- the total could not be explained afterwards.
--
-- name and price_modifier are snapshots, for the same reason
-- order_items.unit_price is: renaming or re-pricing an option later must
-- not rewrite what an old order said or charged.
-- ============================================================

CREATE TABLE order_item_modifiers (

    id SERIAL PRIMARY KEY,


    order_item_id INTEGER
        REFERENCES order_items(id)
        ON DELETE CASCADE,


    modifier_option_id INTEGER
        REFERENCES modifier_options(id),


    name VARCHAR(100)
        NOT NULL,


    price_modifier DECIMAL(10,2)
        NOT NULL
        DEFAULT 0.00,


    UNIQUE(order_item_id, modifier_option_id)
);



-- ============================================================
-- 21. USER SESSIONS
-- ============================================================

CREATE TABLE revoked_tokens (

    id SERIAL PRIMARY KEY, -- but this is the primary key 

    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,

    jti VARCHAR(255) NOT NULL UNIQUE, -- this is also a key for the table

    expires_at TIMESTAMP NOT NULL,

    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 21. RIDER REVIEWS
--
-- The customer's feedback about the delivery rider, kept separate from
-- restaurant_reviews because it rates a different person and is private:
-- only the admin panel reads it (GET /api/admin/rider-reviews). Keeping it
-- in its own table means no public restaurant query can ever select it by
-- accident.
--
-- See db/migrations/007_rider_reviews.sql for the same table applied to a
-- database that already exists.
-- ============================================================

CREATE TABLE rider_reviews (

    id SERIAL PRIMARY KEY,


    -- One rider review per delivery.
    order_id INTEGER
        NOT NULL
        UNIQUE
        REFERENCES orders(id)
        ON DELETE CASCADE,


    -- Stored rather than read back through orders.rider_id: the review
    -- belongs to whoever actually made this delivery.
    rider_id INTEGER
        NOT NULL
        REFERENCES users(id),


    rating INTEGER
        NOT NULL
        CHECK (
            rating BETWEEN 1 AND 5
        ),


    comment TEXT
        CHECK (
            comment IS NULL
            OR char_length(comment) BETWEEN 1 AND 1000
        ),


    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
);


CREATE INDEX idx_rider_reviews_rider_created
    ON rider_reviews(rider_id, created_at DESC);

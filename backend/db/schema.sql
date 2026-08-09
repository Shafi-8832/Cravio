-- ============================================
-- CRAVIO DATABASE SCHEMA
-- Final Version | PostgreSQL 16
-- ============================================

-- Drop everything and start fresh
DROP TABLE IF EXISTS quality_flag_log, restaurant_review, 
delivery, payment, order_items, orders, promo_codes, 
cart_items, menu_items, menu_categories, restaurant_branches, 
restaurants, customer_addresses, rider_profiles, users CASCADE;

-- 1. USERS
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN 
        ('customer', 'restaurant_owner', 'rider', 'admin')),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. RIDER_PROFILE
CREATE TABLE rider_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    vehicle_type VARCHAR(20) CHECK (vehicle_type IN 
        ('bicycle', 'motorcycle', 'car')),
    status VARCHAR(20) DEFAULT 'offline' CHECK (status IN 
        ('online', 'offline', 'busy'))
);

-- 3. CUSTOMER_ADDRESS
CREATE TABLE customer_addresses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    label VARCHAR(50) CHECK (label IN ('Home', 'Work', 'Other')),
    area VARCHAR(100) NOT NULL,
    full_address TEXT NOT NULL,
    is_default BOOLEAN DEFAULT false
);

-- 4. RESTAURANT
CREATE TABLE restaurants (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    avg_rating DECIMAL(2,1) DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. RESTAURANT_BRANCH
CREATE TABLE restaurant_branches (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    area VARCHAR(100) NOT NULL,
    city VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6),
    is_open BOOLEAN DEFAULT true
);

-- 6. MENU_CATEGORY (per restaurant)
CREATE TABLE menu_categories (
    id SERIAL PRIMARY KEY,
    restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL
);

-- 7. MENU_ITEM
CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    category_id INTEGER REFERENCES menu_categories(id) ON DELETE SET NULL,
    restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    image_url VARCHAR(255),
    is_available BOOLEAN DEFAULT true,
    is_veg BOOLEAN DEFAULT false,
    quality_flag BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. PROMO_CODES
CREATE TABLE promo_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    discount_percent INTEGER CHECK (discount_percent BETWEEN 1 AND 100),
    min_order_amount DECIMAL(10,2) DEFAULT 0,
    expiry_date DATE NOT NULL,
    is_active BOOLEAN DEFAULT true,
    usage_limit INTEGER DEFAULT 100,
    used_count INTEGER DEFAULT 0
);

-- 9. ORDERS
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES users(id),
    rider_id INTEGER REFERENCES users(id),
    branch_id INTEGER REFERENCES restaurant_branches(id),
    promo_code_id INTEGER REFERENCES promo_codes(id),
    delivery_address TEXT NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    discount_amount DECIMAL(10,2) DEFAULT 0,
    total_amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(30) DEFAULT 'pending' CHECK (status IN (
        'pending', 'confirmed', 'preparing',
        'out_for_delivery', 'delivered', 'cancelled'
    )),
    review_eligible BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. ORDER_ITEMS
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER REFERENCES menu_items(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10,2) NOT NULL,
    special_instruction TEXT
);

-- 11. PAYMENT
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) UNIQUE,
    method VARCHAR(20) CHECK (method IN 
        ('cash_on_delivery', 'bkash', 'nagad')),
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'unpaid' CHECK (status IN 
        ('unpaid', 'paid', 'failed')),
    transaction_ref VARCHAR(100),
    paid_at TIMESTAMP
);

-- 12. DELIVERY
CREATE TABLE deliveries (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) UNIQUE,
    rider_id INTEGER REFERENCES users(id),
    delivery_status VARCHAR(30) DEFAULT 'assigned' CHECK (
        delivery_status IN ('assigned', 'picked_up', 'delivered')),
    delivery_time TIMESTAMP,
    recipient_note TEXT
);

-- 13. RESTAURANT_REVIEW
CREATE TABLE restaurant_reviews (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) UNIQUE,
    customer_id INTEGER REFERENCES users(id),
    restaurant_id INTEGER REFERENCES restaurants(id),
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    portion_accuracy VARCHAR(20) CHECK (portion_accuracy IN (
        'full', 'slightly_less', 'way_less')),
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 14. QUALITY_FLAG_LOG
CREATE TABLE quality_flag_log (
    id SERIAL PRIMARY KEY,
    menu_item_id INTEGER REFERENCES menu_items(id),
    order_id INTEGER REFERENCES orders(id),
    flagged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
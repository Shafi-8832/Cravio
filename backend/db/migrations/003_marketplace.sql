-- Additive upgrade: preserves existing accounts, restaurants, carts and orders.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS cuisine VARCHAR(100) NOT NULL DEFAULT 'Bangladeshi',
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_credit TEXT,
  ADD COLUMN IF NOT EXISTS image_source_url TEXT,
  ADD COLUMN IF NOT EXISTS image_is_illustrative BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS catalog_slug TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ordering_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE restaurant_branches
  ADD COLUMN IF NOT EXISTS division VARCHAR(20)
    CHECK (division IN ('Dhaka','Chattogram','Rajshahi','Khulna','Barishal','Sylhet','Rangpur','Mymensingh')),
  ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 49 CHECK (delivery_fee >= 0),
  ADD COLUMN IF NOT EXISTS min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  ADD COLUMN IF NOT EXISTS eta_min INTEGER NOT NULL DEFAULT 25 CHECK (eta_min > 0),
  ADD COLUMN IF NOT EXISTS eta_max INTEGER NOT NULL DEFAULT 45 CHECK (eta_max >= eta_min);

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS image_credit TEXT,
  ADD COLUMN IF NOT EXISTS image_source_url TEXT,
  ADD COLUMN IF NOT EXISTS image_is_illustrative BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customer_addresses
  ADD COLUMN IF NOT EXISTS division VARCHAR(20),
  ADD COLUMN IF NOT EXISTS city VARCHAR(100),
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS latitude DECIMAL(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS longitude DECIMAL(9,6) CHECK (longitude BETWEEN -180 AND 180);

CREATE TABLE IF NOT EXISTS customer_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, restaurant_id)
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS item_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Preserve the best available history for old orders; future orders copy at checkout.
UPDATE order_items oi SET item_name = mi.name, image_url = mi.image_url
FROM menu_items mi WHERE oi.menu_item_id = mi.id AND oi.item_name IS NULL;

CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id);
CREATE INDEX IF NOT EXISTS idx_branches_division ON restaurant_branches(division);
CREATE INDEX IF NOT EXISTS idx_deliveries_rider ON deliveries(rider_id, delivery_status);

-- An audit event belongs in the same transaction as the order change. The trigger
-- also covers updates made by the delivery procedure, not only Express routes.
CREATE OR REPLACE FUNCTION record_order_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_events(order_id, status, note) VALUES (NEW.id, NEW.status, 'Order placed');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_events(order_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_record_order_event ON orders;
CREATE TRIGGER trg_record_order_event AFTER INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION record_order_event();

-- Old records have only their present status; never invent missing transition dates.
INSERT INTO order_events(order_id, status, note)
SELECT o.id, o.status, 'Existing order imported; earlier transition times unavailable'
FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id);


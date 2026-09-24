-- Feedback about the *delivery*, which is a different thing from feedback
-- about the food. It lives in its own table rather than as extra columns on
-- restaurant_reviews for two reasons: it rates a different person, and it is
-- private — only the admin panel ever reads it, so nothing public can
-- accidentally select it alongside a restaurant review.
CREATE TABLE IF NOT EXISTS rider_reviews (
  id SERIAL PRIMARY KEY,

  -- UNIQUE enforces one rider review per delivery, the same rule
  -- restaurant_reviews.order_id enforces for the meal.
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,

  -- Stored even though the order row also names a rider. The review is about
  -- the person who actually carried this delivery; if an order were ever
  -- reassigned, the review must not silently follow the new rider.
  rider_id INTEGER NOT NULL REFERENCES users(id),

  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),

  -- Same 1000-character ceiling routes/reviews.js holds the meal comment to,
  -- repeated here so it holds for every writer. NULL passes a CHECK, which is
  -- what leaves "stars but no words" legal.
  comment TEXT CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1000),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The admin panel reads this table two ways: the newest-first feed, and the
-- per-rider averages. Both start from rider_id and created_at.
CREATE INDEX IF NOT EXISTS idx_rider_reviews_rider_created
  ON rider_reviews(rider_id, created_at DESC);

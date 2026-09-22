-- A review is the customer's word and stays theirs; the owner gets a reply
-- alongside it, never an edit to it.
ALTER TABLE restaurant_reviews ADD COLUMN IF NOT EXISTS owner_reply TEXT;
ALTER TABLE restaurant_reviews ADD COLUMN IF NOT EXISTS owner_replied_at TIMESTAMPTZ;

-- The same 1000-character ceiling the customer's comment is held to in
-- routes/reviews.js, enforced here as well so it holds for every writer.
-- NULL passes a CHECK, which is what leaves "no reply yet" legal.
-- Dropped first because ADD CONSTRAINT has no IF NOT EXISTS form, and this
-- file has to stay safe to re-run.
ALTER TABLE restaurant_reviews DROP CONSTRAINT IF EXISTS chk_owner_reply_length;
ALTER TABLE restaurant_reviews ADD CONSTRAINT chk_owner_reply_length
  CHECK (owner_reply IS NULL OR char_length(owner_reply) BETWEEN 1 AND 1000);

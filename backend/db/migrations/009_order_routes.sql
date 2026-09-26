-- ============================================================
-- MIGRATION 009 — cached road routes for live tracking
--
-- Applied by `npm run db:migrate`. Idempotent: CREATE TABLE IF NOT EXISTS.
--
-- This table CACHES the road route from the external routing service
-- (OSRM, see backend/services/routing.js). A route from a branch to a
-- drop-off point never changes once the order exists, so we fetch it ONCE
-- per order and store it here, instead of calling the outside service on
-- every 5-second poll of the tracking page. That keeps us inside the free
-- demo server's rate limits and makes every later request a fast local read.
--
-- Only SUCCESSFUL OSRM routes are stored. When OSRM is down, the endpoint
-- answers with a straight-line fallback but does NOT save it, so the next
-- request tries OSRM again instead of being stuck with a fake route forever.
--
-- No trigger, function or procedure: this is plain storage, written by one
-- endpoint (GET /api/orders/:id/route) in an explicit transaction.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_routes (

  -- One route per order. The PRIMARY KEY is also what lets two viewers
  -- that miss the cache at the same moment both INSERT safely with
  -- ON CONFLICT (order_id) DO NOTHING: the second insert is simply skipped.
  order_id INTEGER PRIMARY KEY
    REFERENCES orders(id) ON DELETE CASCADE,

  -- The road path as a JSON array of [lat, lng] pairs, ALREADY flipped into
  -- Leaflet's order (OSRM sends [lng, lat]). JSONB because the route is
  -- read and sent as one whole value, never searched point by point.
  geometry JSONB NOT NULL,

  -- Length of the road route in metres, and OSRM's driving-time estimate
  -- in seconds. Stored as OSRM reported them, rounded to 0.1.
  distance_m NUMERIC(10,1) NOT NULL
    CHECK (distance_m >= 0),

  duration_s NUMERIC(10,1) NOT NULL
    CHECK (duration_s >= 0),

  -- Where the route came from. Only 'osrm' is allowed, which is the
  -- database's own guarantee that a straight-line fallback is never cached.
  source VARCHAR(20) NOT NULL DEFAULT 'osrm'
    CHECK (source IN ('osrm')),

  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

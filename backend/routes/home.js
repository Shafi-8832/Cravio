const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

const router = express.Router()

// Banners, deals, popular dishes and top restaurants are public catalogue
// data — the same kind of thing GET /api/restaurants already shows to
// guests — so a visitor sees a live home page before signing up. Only
// "Order again" reads one person's own order history, so only that route
// asks for a login (401) and the customer role (403).

// The columns every deal/dish card needs, read from the active_item_offers
// VIEW. The view already decided "is this offer running now?" and computed
// discounted_price in SQL; ::float8 turns NUMERIC (sent by pg as a string)
// into JSON numbers.
const DEAL_COLUMNS = `
  offer_id,
  item_id,
  item_name,
  image_url,
  restaurant_id,
  restaurant_name,
  original_price::float8 AS original_price,
  discount_percent,
  discounted_price::float8 AS discounted_price,
  ends_at
`


// ============================================================
// GET /api/home/banners
// Public (no login needed)
// Carousel slides: every promo code that can still be used, plus the twelve
// biggest photographed item deals running now. Two queries in total, no
// per-item loop.
// ============================================================
router.get('/banners', async (req, res) => {
  try {
    // A promo code is usable when it is switched on, not past its expiry
    // date and not used up — the same three rules place_order() checks.
    const promosResult = await pool.query(`
      SELECT
        id,
        code,
        discount_percent,
        min_order_amount::float8 AS min_order_amount,
        -- Formatted in SQL ("31 Dec 2027"): a DATE turned into a JavaScript
        -- Date can shift by a day depending on the viewer's time zone.
        to_char(expiry_date, 'FMDD Mon YYYY') AS valid_until
      FROM promo_codes
      WHERE is_active = true
        AND expiry_date >= CURRENT_DATE
        AND used_count < usage_limit
      ORDER BY discount_percent DESC, code
    `)

    // Top 12 deals: biggest discount first; if two are equal, the one ending
    // sooner first (more urgent). Unavailable dishes and restaurants that do
    // not take orders are hidden — nobody could buy them. A deal slide is
    // built around the dish photo, so dishes without one are left out here
    // (they still appear in the "Today's deals" rail).
    const dealsResult = await pool.query(`
      SELECT ${DEAL_COLUMNS}
      FROM active_item_offers
      WHERE is_available = true
        AND ordering_enabled = true
        AND image_url IS NOT NULL
        AND btrim(image_url) <> ''
      ORDER BY discount_percent DESC, ends_at ASC, offer_id
      LIMIT 12
    `)

    res.json({
      promos: promosResult.rows,
      deals: dealsResult.rows
    })

  } catch (error) {
    console.error('Home banners error:', error)
    res.status(500).json({ error: 'Server error loading offers.' })
  }
})


// ============================================================
// GET /api/home/deals?limit=12
// Public (no login needed)
// Today's deals, the ones ending soonest first (most urgent at the left).
// ============================================================
router.get('/deals', async (req, res) => {
  // limit is optional: default 12, otherwise a whole number from 1 to 50.
  const limit = req.query.limit === undefined ? 12 : Number(req.query.limit)

  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return res.status(400).json({ error: 'limit must be a whole number from 1 to 50.' })
  }

  try {
    const result = await pool.query(`
      SELECT ${DEAL_COLUMNS}
      FROM active_item_offers
      WHERE is_available = true
        AND ordering_enabled = true
      ORDER BY ends_at ASC, offer_id
      LIMIT $1
    `, [limit])

    res.json({ deals: result.rows })

  } catch (error) {
    console.error('Home deals error:', error)
    res.status(500).json({ error: 'Server error loading deals.' })
  }
})


// ============================================================
// GET /api/home/popular
// Public (no login needed)
// GRADED COMPLEX QUERY — "Popular right now": the 10 dishes ordered most
// in the last 7 days, topped up with top-rated restaurants' dishes so the
// rail is never empty.
// ============================================================
router.get('/popular', async (req, res) => {
  try {
    // ------------------------------------------------------------
    // Step 1 — recent_sales (orders JOIN order_items, GROUP BY):
    //   how many units of each dish were ordered in the last 7 days.
    //   Cancelled orders are left out: that food was never sold.
    //
    // Step 2 — candidates (menu_items JOIN restaurants, LEFT JOIN step 1):
    //   every available dish of a restaurant that takes orders, with its
    //   7-day quantity (0 when it was not ordered — that is what the LEFT
    //   JOIN + COALESCE give us). ROW_NUMBER() numbers each restaurant's
    //   dishes (best-selling, then most expensive, first).
    //
    // Step 3 — the final SELECT keeps
    //   * every dish that actually sold (ordered_qty > 0), and
    //   * as the TOP-UP, each restaurant's first 2 dishes,
    //   then sorts: sold dishes first by quantity, then the top-up dishes
    //   by their restaurant's stored avg_rating. LIMIT 10 cuts the list.
    //   So with 3 dishes sold this week, those 3 come first and the other
    //   7 slots are filled from the best-rated restaurants — in ONE query.
    //   "At most 2 per restaurant" keeps one restaurant from filling the
    //   whole rail.
    //
    // LEFT JOIN active_item_offers adds the sale price when the dish has an
    // offer running now (NULL otherwise).
    // ------------------------------------------------------------
    const result = await pool.query(`
      WITH recent_sales AS (
        SELECT
          oi.menu_item_id,
          SUM(oi.quantity)::int AS ordered_qty
        FROM orders o
        JOIN order_items oi
          ON oi.order_id = o.id
        WHERE o.created_at >= now() - INTERVAL '7 days'
          AND o.status <> 'cancelled'
        GROUP BY oi.menu_item_id
      ),
      candidates AS (
        SELECT
          mi.id AS item_id,
          mi.name AS item_name,
          mi.image_url,
          mi.price,
          r.id AS restaurant_id,
          r.name AS restaurant_name,
          r.avg_rating,
          r.review_count,
          COALESCE(rs.ordered_qty, 0) AS ordered_qty,
          ROW_NUMBER() OVER (
            PARTITION BY r.id
            ORDER BY COALESCE(rs.ordered_qty, 0) DESC, mi.price DESC, mi.id
          ) AS rank_in_restaurant
        FROM menu_items mi
        JOIN restaurants r
          ON r.id = mi.restaurant_id
        LEFT JOIN recent_sales rs
          ON rs.menu_item_id = mi.id
        WHERE mi.is_available = true
          AND r.ordering_enabled = true
      )
      SELECT
        c.item_id,
        c.item_name,
        c.image_url,
        c.restaurant_id,
        c.restaurant_name,
        c.price::float8 AS original_price,
        aio.discount_percent,
        aio.discounted_price::float8 AS discounted_price,
        aio.ends_at,
        c.ordered_qty,
        c.avg_rating::float8 AS avg_rating,
        CASE WHEN c.ordered_qty > 0 THEN 'popular' ELSE 'top_rated' END AS reason
      FROM candidates c
      LEFT JOIN active_item_offers aio
        ON aio.item_id = c.item_id
      WHERE c.ordered_qty > 0
         OR c.rank_in_restaurant <= 2
      ORDER BY
        c.ordered_qty DESC,
        c.avg_rating DESC NULLS LAST,
        c.review_count DESC,
        c.rank_in_restaurant,
        c.item_id
      LIMIT 10
    `)

    res.json({ items: result.rows })

  } catch (error) {
    console.error('Home popular error:', error)
    res.status(500).json({ error: 'Server error loading popular dishes.' })
  }
})


// ============================================================
// GET /api/home/order-again
// customer only (401 without a login, 403 for other roles)
// GRADED COMPLEX QUERY + AUTHORIZATION — restaurants this customer has
// ordered from, most recent first, with order count and last order date.
// ============================================================
router.get('/order-again', authenticateToken, requireRole('customer'), async (req, res) => {
  try {
    // $1 is req.user.id — taken from the verified login token by
    // authenticateToken, never from the URL or the body, so a customer
    // can only ever see their own history.
    //
    // orders -> restaurant_branches -> restaurants: an order points at a
    // branch, and the branch points at its restaurant. GROUP BY r.id folds
    // all orders from any branch of one restaurant into one row; COUNT and
    // MAX then give "how many orders" and "when was the last one".
    // (Grouping by the primary key lets us select the other r.* columns.)
    // Cancelled orders do not count as "ordered from".
    const result = await pool.query(`
      SELECT
        r.id AS restaurant_id,
        r.name,
        r.cuisine,
        r.image_url,
        r.logo_url,
        r.avg_rating::float8 AS avg_rating,
        r.review_count,
        COUNT(o.id)::int AS order_count,
        -- orders.created_at is a TIMESTAMP without time zone written in the
        -- server's GMT clock; AT TIME ZONE 'UTC' turns it into an exact
        -- moment so the browser shows the right local date and time.
        MAX(o.created_at) AT TIME ZONE 'UTC' AS last_order_at
      FROM orders o
      JOIN restaurant_branches rb
        ON rb.id = o.branch_id
      JOIN restaurants r
        ON r.id = rb.restaurant_id
      WHERE o.customer_id = $1
        AND o.status <> 'cancelled'
      GROUP BY r.id
      ORDER BY last_order_at DESC
      LIMIT 10
    `, [req.user.id])

    res.json({ restaurants: result.rows })

  } catch (error) {
    console.error('Home order-again error:', error)
    res.status(500).json({ error: 'Server error loading your past restaurants.' })
  }
})


// ============================================================
// GET /api/home/top-restaurants
// Public (no login needed)
// Best-rated restaurants with at least one review.
// ============================================================
router.get('/top-restaurants', async (req, res) => {
  try {
    // avg_rating / review_count are stored on the restaurant row and kept
    // correct by trg_sync_restaurant_rating, so no reviews are re-counted
    // here. review_count >= 1 hides restaurants nobody has rated yet
    // (their avg_rating would be NULL). More reviews wins a tie.
    const result = await pool.query(`
      SELECT
        id AS restaurant_id,
        name,
        cuisine,
        image_url,
        logo_url,
        avg_rating::float8 AS avg_rating,
        review_count
      FROM restaurants
      WHERE review_count >= 1
      ORDER BY avg_rating DESC, review_count DESC, name
      LIMIT 10
    `)

    res.json({ restaurants: result.rows })

  } catch (error) {
    console.error('Home top restaurants error:', error)
    res.status(500).json({ error: 'Server error loading top restaurants.' })
  }
})


module.exports = router

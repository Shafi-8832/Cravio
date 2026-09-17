const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')

const router = express.Router()

// Signed in, and a restaurant owner. Anyone else is stopped here:
// no token at all -> 401 (authenticateToken), wrong role -> 403 (requireRole).
router.use(authenticateToken, requireRole('restaurant_owner'))


// ============================================================
// DATE RANGE
// Both dates arrive as text in the query string, so both are validated
// before they go anywhere near the database. Defaults to the last 30
// days (today included, which is why it is 29 days back).
// ============================================================
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function toIsoDate(date) {
  return date.toISOString().slice(0, 10)
}

// Returns { from, to } on success, or a string describing what was wrong.
// A real date is demanded, not just the right shape: '2026-02-31' matches
// the pattern but is not a day, and Date rolls it silently into March,
// which would quietly shift the window the owner asked for.
function resolveRange(query) {
  const today = new Date()
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 29)

  const from = query.from === undefined || query.from === '' ? toIsoDate(thirtyDaysAgo) : String(query.from)
  const to = query.to === undefined || query.to === '' ? toIsoDate(today) : String(query.to)

  for (const value of [from, to]) {
    if (!DATE_PATTERN.test(value)) return 'Dates must be written as YYYY-MM-DD.'
    const parsed = new Date(value + 'T00:00:00Z')
    if (Number.isNaN(parsed.getTime()) || toIsoDate(parsed) !== value) {
      return 'That is not a real calendar date.'
    }
  }

  if (from > to) return 'The start date must not be after the end date.'

  // A year of days is the most the charts are built to draw, and it also
  // caps how many rows generate_series can be asked to produce.
  const days = (new Date(to) - new Date(from)) / 86400000
  if (days > 366) return 'Choose a range of one year or less.'

  return { from, to }
}


// ============================================================
// OWNERSHIP
// The id in the URL is a request, not a permission. This middleware
// turns it into one: the restaurant must exist (404 otherwise) and its
// owner_id must equal the id carried by the verified token (403
// otherwise). req.user.id is set by authenticateToken from the database
// row, so it cannot be supplied or edited by the caller.
//
// Every analytics query repeats `AND r.owner_id = $2` on top of this, so
// even a mistake here could not return another owner's numbers.
// ============================================================
async function requireOwnedRestaurant(req, res, next) {
  const restaurantId = parseId(req.params.restaurantId)
  if (restaurantId === null) {
    return res.status(400).json({ error: 'Invalid restaurant ID.' })
  }

  const result = await pool.query(
    'SELECT id, name, owner_id FROM restaurants WHERE id = $1',
    [restaurantId]
  )

  if (!result.rowCount) {
    return res.status(404).json({ error: 'Restaurant not found.' })
  }

  if (result.rows[0].owner_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only view analytics for your own restaurant.' })
  }

  req.restaurant = { id: result.rows[0].id, name: result.rows[0].name }

  const range = resolveRange(req.query)
  if (typeof range === 'string') return res.status(400).json({ error: range })
  req.range = range

  next()
}


// Every query below is parameterised the same way, in the same order:
//   $1 restaurant id (already proved to belong to $2)
//   $2 owner id, straight from the verified token
//   $3 range start (a date string), $4 range end
// Nothing is ever concatenated into the SQL text.
const params = req => [req.restaurant.id, req.user.id, req.range.from, req.range.to]


// ============================================================
// 1. REVENUE OVER TIME
// One row per day in the range, including days that sold nothing.
// ============================================================
// generate_series produces the calendar — one row per day — and the
// orders are LEFT JOINed onto it, so a day with no orders still appears
// with zeros instead of silently disappearing from the chart.
//
// The `owned_orders` block at the top is a CTE: a named temporary result
// used further down. It is where ownership is proved, by walking
// orders -> restaurant_branches -> restaurants and demanding both that
// the restaurant is the one asked for AND that its owner is the caller.
const REVENUE_OVER_TIME_SQL = `
  WITH owned_orders AS (
    SELECT o.id, o.total_amount, o.created_at
    FROM orders o
    JOIN restaurant_branches b ON b.id = o.branch_id
    JOIN restaurants r ON r.id = b.restaurant_id
    WHERE r.id = $1
      AND r.owner_id = $2
      AND o.status <> 'cancelled'
      AND o.created_at >= $3::date
      AND o.created_at < ($4::date + INTERVAL '1 day')
  )
  -- to_char, not a bare date: a DATE column arrives in Node as a JavaScript
  -- Date at local midnight and then serializes to UTC, which can move the
  -- label to the previous day for readers east of Greenwich. Sending the
  -- text form means the day the database grouped by is the day displayed.
  SELECT
    to_char(series.day, 'YYYY-MM-DD') AS day,
    COUNT(oo.id)::INTEGER AS order_count,
    COALESCE(SUM(oo.total_amount), 0) AS revenue
  FROM generate_series($3::date, $4::date, INTERVAL '1 day') AS series(day)
  LEFT JOIN owned_orders oo
    ON oo.created_at >= series.day
   AND oo.created_at < series.day + INTERVAL '1 day'
  GROUP BY series.day
  ORDER BY series.day
`


// ============================================================
// 2. TOP SELLING MENU ITEMS
// ============================================================
// Four joins deep: an order line knows its item and its order, the order
// knows its branch, and the branch knows the restaurant whose owner we
// check. Quantities are summed per item, so an item bought 3 at a time
// across 4 orders counts as 12. Revenue multiplies quantity by the price
// recorded on the line, not today's menu price, so an old sale is still
// valued at what it actually sold for.
const TOP_ITEMS_SQL = `
  SELECT
    mi.id,
    mi.name,
    SUM(oi.quantity)::INTEGER AS quantity_sold,
    SUM(oi.quantity * oi.unit_price) AS revenue,
    COUNT(DISTINCT o.id)::INTEGER AS order_count
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN menu_items mi ON mi.id = oi.menu_item_id
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
    AND o.status <> 'cancelled'
    AND o.created_at >= $3::date
    AND o.created_at < ($4::date + INTERVAL '1 day')
  GROUP BY mi.id, mi.name
  ORDER BY quantity_sold DESC, revenue DESC
  LIMIT 5
`


// ============================================================
// 3. HEADLINE STATS — one row, current period vs the one before it
// ============================================================
// A number on its own ("৳8,060") says nothing. A number next to the same
// number from the period before it ("৳8,060, up 24%") is what an owner
// actually reads. So this query covers BOTH windows in one pass.
//
// How the previous window is worked out: its length is the length of the
// current one, and it ends the day before the current one starts. Ask for
// 1–30 September and you are compared against 2–31 August, automatically.
// That arithmetic is done by Postgres in the `bounds` block, not in Node.
//
// The trick that keeps it to a single round trip is FILTER: the WHERE
// clause fetches the whole span (previous start → current end) once, and
// each aggregate then says which half of that span it wants. Two windows,
// one scan, one row out.
//
// Aggregates over an empty set still return one row (COUNT 0, and COALESCE
// turning the NULL sums into 0), which is what keeps a brand-new restaurant
// showing zeros rather than a blank page or NaN.
//
// COUNT(DISTINCT o.customer_id) is "how many different people", not "how
// many orders" — one regular who ordered 20 times counts once.
//
// The rating is its own bracketed sub-select because it comes from a
// different chain entirely: a review is attached to an order, so it is
// reached through restaurant_reviews -> orders -> restaurant_branches. It
// is a lifetime figure and deliberately ignores the date range.
const HEADLINE_SQL = `
  WITH bounds AS (
    SELECT
      $3::date AS current_from,
      $4::date AS current_to,
      ($4::date - $3::date + 1) AS period_days,
      -- One full period back: start earlier by the period's own length,
      -- and stop the day before the current period begins.
      ($3::date - ($4::date - $3::date + 1)) AS previous_from,
      ($3::date - 1) AS previous_to
  ),
  totals AS (
    SELECT
      -- Current period
      COUNT(o.id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER
        AS current_orders,
      COUNT(o.id) FILTER (WHERE o.created_at >= bounds.current_from AND o.status = 'cancelled')::INTEGER
        AS current_cancelled_orders,
      COALESCE(SUM(o.total_amount) FILTER (
        WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled'), 0)
        AS current_revenue,
      AVG(o.total_amount) FILTER (
        WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled')
        AS current_average_order_value,
      COUNT(DISTINCT o.customer_id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER
        AS current_customers_served,

      -- Previous period: the same three measures, same scan, other half.
      COUNT(o.id) FILTER (WHERE o.created_at < bounds.current_from)::INTEGER
        AS previous_orders,
      COALESCE(SUM(o.total_amount) FILTER (
        WHERE o.created_at < bounds.current_from AND o.status <> 'cancelled'), 0)
        AS previous_revenue,
      AVG(o.total_amount) FILTER (
        WHERE o.created_at < bounds.current_from AND o.status <> 'cancelled')
        AS previous_average_order_value,
      COUNT(DISTINCT o.customer_id) FILTER (WHERE o.created_at < bounds.current_from)::INTEGER
        AS previous_customers_served
    FROM bounds
    LEFT JOIN orders o
      ON o.created_at >= bounds.previous_from
     AND o.created_at < (bounds.current_to + INTERVAL '1 day')
     AND o.branch_id IN (
       -- The ownership proof, as a list of the branches this owner's
       -- restaurant actually has. Written as a sub-select rather than a
       -- join so the LEFT JOIN above still yields its one row of zeros
       -- when the restaurant has no orders at all.
       SELECT b.id
       FROM restaurant_branches b
       JOIN restaurants r ON r.id = b.restaurant_id
       WHERE r.id = $1 AND r.owner_id = $2
     )
    GROUP BY bounds.current_from
  )
  SELECT
    totals.*,
    bounds.period_days::INTEGER AS period_days,
    to_char(bounds.previous_from, 'YYYY-MM-DD') AS previous_from,
    to_char(bounds.previous_to, 'YYYY-MM-DD') AS previous_to,
    -- Percent change, also computed here rather than in JavaScript.
    -- NULLIF makes the divisor NULL when the previous period was zero, and
    -- anything divided by NULL is NULL — which the page reads as "no
    -- comparison possible" instead of dividing by zero or printing an
    -- infinite rise.
    ROUND(
      (totals.current_revenue - totals.previous_revenue)
      / NULLIF(totals.previous_revenue, 0) * 100, 1
    ) AS revenue_change_pct,
    ROUND(
      (totals.current_orders - totals.previous_orders)::NUMERIC
      / NULLIF(totals.previous_orders, 0) * 100, 1
    ) AS orders_change_pct,
    ROUND(
      (COALESCE(totals.current_average_order_value, 0) - COALESCE(totals.previous_average_order_value, 0))
      / NULLIF(totals.previous_average_order_value, 0) * 100, 1
    ) AS average_order_value_change_pct,
    (
      SELECT ROUND(AVG(rev.rating), 2)
      FROM restaurant_reviews rev
      JOIN orders o2 ON o2.id = rev.order_id
      JOIN restaurant_branches b2 ON b2.id = o2.branch_id
      WHERE b2.restaurant_id = $1
    ) AS average_rating,
    (
      SELECT COUNT(*)
      FROM restaurant_reviews rev
      JOIN orders o2 ON o2.id = rev.order_id
      JOIN restaurant_branches b2 ON b2.id = o2.branch_id
      WHERE b2.restaurant_id = $1
    )::INTEGER AS review_count
  FROM totals, bounds
`


// ============================================================
// 4. BUSIEST HOURS
// ============================================================
// EXTRACT(HOUR FROM ...) pulls just the hour number (0-23) out of the
// timestamp, and GROUP BY collapses every order placed in that hour on
// any day into one row — so "we are busiest at 8pm" is one query, not a
// scan of every order in the browser.
const BUSIEST_HOURS_SQL = `
  SELECT
    EXTRACT(HOUR FROM o.created_at)::INTEGER AS hour,
    COUNT(o.id)::INTEGER AS order_count,
    COALESCE(SUM(o.total_amount), 0) AS revenue
  FROM orders o
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
    AND o.status <> 'cancelled'
    AND o.created_at >= $3::date
    AND o.created_at < ($4::date + INTERVAL '1 day')
  GROUP BY hour
  ORDER BY hour
`


// ============================================================
// 5. ORDER STATUS BREAKDOWN
// ============================================================
// Cancelled orders are NOT excluded here — this is the one place the
// owner needs to see them, because "how many did we lose" is the point
// of the breakdown.
const STATUS_BREAKDOWN_SQL = `
  SELECT
    o.status,
    COUNT(o.id)::INTEGER AS order_count,
    COALESCE(SUM(o.total_amount), 0) AS order_value
  FROM orders o
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  WHERE r.id = $1
    AND r.owner_id = $2
    AND o.created_at >= $3::date
    AND o.created_at < ($4::date + INTERVAL '1 day')
  GROUP BY o.status
  ORDER BY order_count DESC
`


// ============================================================
// ENDPOINTS
// GET /api/owner/analytics/:restaurantId/<report>?from=&to=
//
// 401 no token · 403 wrong role, or not this owner's restaurant
// 404 no such restaurant · 400 bad id or bad dates · 200 otherwise
// ============================================================
function report(sql, key) {
  return async (req, res) => {
    const result = await pool.query(sql, params(req))
    res.json({
      restaurant: req.restaurant,
      range: req.range,
      [key]: result.rows
    })
  }
}

router.get('/analytics/:restaurantId/revenue', requireOwnedRestaurant, report(REVENUE_OVER_TIME_SQL, 'revenue_by_day'))
router.get('/analytics/:restaurantId/top-items', requireOwnedRestaurant, report(TOP_ITEMS_SQL, 'top_items'))
router.get('/analytics/:restaurantId/busiest-hours', requireOwnedRestaurant, report(BUSIEST_HOURS_SQL, 'busiest_hours'))
router.get('/analytics/:restaurantId/status-breakdown', requireOwnedRestaurant, report(STATUS_BREAKDOWN_SQL, 'status_breakdown'))

// Headline stats are a single row rather than a list, so this one is not
// built by report().
router.get('/analytics/:restaurantId/headline', requireOwnedRestaurant, async (req, res) => {
  const result = await pool.query(HEADLINE_SQL, params(req))
  res.json({ restaurant: req.restaurant, range: req.range, headline: result.rows[0] })
})

// Everything in one response, so the dashboard makes one request instead
// of five. Same queries, same ownership check — this is a convenience for
// the page, not a second way in.
router.get('/analytics/:restaurantId', requireOwnedRestaurant, async (req, res) => {
  const values = params(req)
  const [headline, revenue, topItems, hours, statuses] = await Promise.all([
    pool.query(HEADLINE_SQL, values),
    pool.query(REVENUE_OVER_TIME_SQL, values),
    pool.query(TOP_ITEMS_SQL, values),
    pool.query(BUSIEST_HOURS_SQL, values),
    pool.query(STATUS_BREAKDOWN_SQL, values)
  ])

  res.json({
    restaurant: req.restaurant,
    range: req.range,
    headline: headline.rows[0],
    revenue_by_day: revenue.rows,
    top_items: topItems.rows,
    busiest_hours: hours.rows,
    status_breakdown: statuses.rows
  })
})


module.exports = router

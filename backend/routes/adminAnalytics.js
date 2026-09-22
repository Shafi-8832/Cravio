const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { resolveRange } = require('../utils/dateRange')

const router = express.Router()

// The only thing protecting this data. Unlike the owner dashboard there is
// no ownership scoping to fall back on — an admin sees the whole platform —
// so the role check is the whole defence, and it is the existing middleware
// pair used everywhere else, not a new implementation:
//   authenticateToken  -> 401 when the token is missing, invalid, revoked,
//                         or the account has been suspended. It re-reads the
//                         user row from the database, so req.user.role is
//                         the database's answer and not the token's claim.
//   requireRole('admin') -> 403 for any authenticated non-admin.
router.use(authenticateToken, requireRole('admin'))


// Dates are validated before any query runs, and then passed as parameters
// ($1, $2) — never pasted into the SQL text.
function withRange(handler) {
  return async (req, res) => {
    const range = resolveRange(req.query)
    if (typeof range === 'string') return res.status(400).json({ error: range })
    req.range = range
    return handler(req, res)
  }
}

const params = req => [req.range.from, req.range.to]


// ============================================================
// 1. PLATFORM HEADLINE STATS — one row, this period vs the last
// ============================================================
// Same technique as the owner dashboard: the previous window is the same
// length as the current one and ends the day before it starts, worked out
// by Postgres in the `bounds` block. The WHERE clause fetches the whole
// span once and each aggregate's FILTER claims its half, so both periods
// come back from one scan rather than two round trips and a subtraction
// in JavaScript.
//
// Orders and users are counted in separate blocks because they are
// unrelated tables — joining them would multiply rows and invent numbers.
// The lifetime totals are plain scalar sub-selects: "how many are there
// altogether", regardless of the window.
const HEADLINE_SQL = `
  WITH bounds AS (
    SELECT
      $1::date AS current_from,
      $2::date AS current_to,
      ($2::date - $1::date + 1) AS period_days,
      ($1::date - ($2::date - $1::date + 1)) AS previous_from,
      ($1::date - 1) AS previous_to
  ),
  order_totals AS (
    SELECT
      COUNT(o.id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER AS current_orders,
      COUNT(o.id) FILTER (WHERE o.created_at < bounds.current_from)::INTEGER AS previous_orders,
      COALESCE(SUM(o.total_amount) FILTER (
        WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled'), 0) AS current_revenue,
      COALESCE(SUM(o.total_amount) FILTER (
        WHERE o.created_at < bounds.current_from AND o.status <> 'cancelled'), 0) AS previous_revenue,
      AVG(o.total_amount) FILTER (
        WHERE o.created_at >= bounds.current_from AND o.status <> 'cancelled') AS current_average_order_value,
      AVG(o.total_amount) FILTER (
        WHERE o.created_at < bounds.current_from AND o.status <> 'cancelled') AS previous_average_order_value,
      COUNT(DISTINCT o.customer_id) FILTER (WHERE o.created_at >= bounds.current_from)::INTEGER
        AS current_active_customers
    FROM bounds
    LEFT JOIN orders o
      ON o.created_at >= bounds.previous_from
     AND o.created_at < (bounds.current_to + INTERVAL '1 day')
    GROUP BY bounds.current_from
  ),
  user_totals AS (
    SELECT
      COUNT(u.id) FILTER (WHERE u.created_at >= bounds.current_from)::INTEGER AS current_signups,
      COUNT(u.id) FILTER (WHERE u.created_at < bounds.current_from)::INTEGER AS previous_signups
    FROM bounds
    LEFT JOIN users u
      ON u.created_at >= bounds.previous_from
     AND u.created_at < (bounds.current_to + INTERVAL '1 day')
    GROUP BY bounds.current_from
  )
  SELECT
    (SELECT COUNT(*) FROM users)::INTEGER AS total_users,
    (SELECT COUNT(*) FROM users WHERE is_active)::INTEGER AS active_users,
    (SELECT COUNT(*) FROM restaurants)::INTEGER AS total_restaurants,
    (SELECT COUNT(*) FROM orders)::INTEGER AS lifetime_orders,
    order_totals.*,
    user_totals.*,
    bounds.period_days::INTEGER AS period_days,
    to_char(bounds.previous_from, 'YYYY-MM-DD') AS previous_from,
    to_char(bounds.previous_to, 'YYYY-MM-DD') AS previous_to,
    -- The percent changes are computed here too. NULLIF makes the divisor
    -- NULL when the previous period was empty, and anything divided by NULL
    -- is NULL — which the page reads as "no comparison possible" rather
    -- than dividing by zero or claiming an infinite rise.
    ROUND((order_totals.current_revenue - order_totals.previous_revenue)
          / NULLIF(order_totals.previous_revenue, 0) * 100, 1) AS revenue_change_pct,
    ROUND((order_totals.current_orders - order_totals.previous_orders)::NUMERIC
          / NULLIF(order_totals.previous_orders, 0) * 100, 1) AS orders_change_pct,
    ROUND((COALESCE(order_totals.current_average_order_value, 0) - COALESCE(order_totals.previous_average_order_value, 0))
          / NULLIF(order_totals.previous_average_order_value, 0) * 100, 1) AS average_order_value_change_pct,
    ROUND((user_totals.current_signups - user_totals.previous_signups)::NUMERIC
          / NULLIF(user_totals.previous_signups, 0) * 100, 1) AS signups_change_pct
  FROM order_totals, user_totals, bounds
`


// ============================================================
// 2. ORDERS AND REVENUE OVER TIME
// ============================================================
// generate_series manufactures the calendar — one row per day — and the
// orders are LEFT JOINed onto it, so a quiet day still appears with zeros
// instead of dropping out of the chart and making the trend look shorter
// than it is.
const TREND_SQL = `
  SELECT
    to_char(series.day, 'YYYY-MM-DD') AS day,
    COUNT(o.id)::INTEGER AS order_count,
    COUNT(o.id) FILTER (WHERE o.status = 'cancelled')::INTEGER AS cancelled_count,
    COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0) AS revenue,
    COUNT(DISTINCT o.customer_id)::INTEGER AS customers
  FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS series(day)
  LEFT JOIN orders o
    ON o.created_at >= series.day
   AND o.created_at < series.day + INTERVAL '1 day'
  GROUP BY series.day
  ORDER BY series.day
`


// ============================================================
// 3. TOP RESTAURANTS BY REVENUE
// ============================================================
// An order stores the branch it was placed at, not the restaurant, so the
// money is gathered by walking orders -> restaurant_branches -> restaurants,
// and the owner's name comes from one more hop into users.
//
// The rating is a bracketed sub-select rather than a fifth join: a review
// hangs off an order, so joining reviews here as well would multiply the
// order rows and inflate the revenue. Correlated on r.id, it is computed
// per restaurant as its own little query.
const TOP_RESTAURANTS_SQL = `
  SELECT
    r.id,
    r.name,
    u.name AS owner_name,
    COUNT(o.id)::INTEGER AS order_count,
    COALESCE(SUM(o.total_amount) FILTER (WHERE o.status <> 'cancelled'), 0) AS revenue,
    COUNT(DISTINCT o.customer_id)::INTEGER AS customers,
    (
      SELECT ROUND(AVG(rev.rating), 2)
      FROM restaurant_reviews rev
      JOIN orders o2 ON o2.id = rev.order_id
      JOIN restaurant_branches b2 ON b2.id = o2.branch_id
      WHERE b2.restaurant_id = r.id
    ) AS average_rating
  FROM orders o
  JOIN restaurant_branches b ON b.id = o.branch_id
  JOIN restaurants r ON r.id = b.restaurant_id
  LEFT JOIN users u ON u.id = r.owner_id
  WHERE o.created_at >= $1::date
    AND o.created_at < ($2::date + INTERVAL '1 day')
  GROUP BY r.id, r.name, u.name
  ORDER BY revenue DESC, order_count DESC
  LIMIT 10
`


// ============================================================
// 4. RIDER PERFORMANCE
// ============================================================
// deliveries holds the rider's side of an order, orders holds when it was
// placed, users gives the rider a name, and restaurant_branches carries the
// promise that was made to the customer: eta_max, the outer end of the
// quoted delivery window.
//
// "On time" is therefore answerable from the schema as it stands: the food
// arrived no later than the order time plus that branch's eta_max minutes.
// make_interval turns the stored number of minutes into a real interval so
// it can be added to a timestamp.
//
// The average duration is an interval; EXTRACT(EPOCH ...) converts it to
// seconds and dividing by 60 gives whole minutes, because "1847 seconds" is
// not a thing to print in a table.
const RIDER_PERFORMANCE_SQL = `
  SELECT
    u.id AS rider_id,
    u.name AS rider_name,
    COUNT(d.id)::INTEGER AS deliveries_assigned,
    COUNT(d.id) FILTER (WHERE d.delivery_status = 'delivered')::INTEGER AS deliveries_completed,
    ROUND(
      EXTRACT(EPOCH FROM AVG(d.delivery_time - o.created_at)
        FILTER (WHERE d.delivery_status = 'delivered' AND d.delivery_time IS NOT NULL)
      ) / 60
    )::INTEGER AS average_delivery_minutes,
    COUNT(d.id) FILTER (
      WHERE d.delivery_status = 'delivered'
        AND d.delivery_time IS NOT NULL
        AND d.delivery_time <= o.created_at + make_interval(mins => b.eta_max)
    )::INTEGER AS on_time_deliveries,
    ROUND(
      100.0 * COUNT(d.id) FILTER (
        WHERE d.delivery_status = 'delivered'
          AND d.delivery_time IS NOT NULL
          AND d.delivery_time <= o.created_at + make_interval(mins => b.eta_max)
      ) / NULLIF(COUNT(d.id) FILTER (WHERE d.delivery_status = 'delivered'), 0),
      1
    ) AS on_time_rate_pct,
    COALESCE(SUM(o.delivery_fee) FILTER (WHERE d.delivery_status = 'delivered'), 0) AS delivery_fees
  FROM deliveries d
  JOIN orders o ON o.id = d.order_id
  JOIN users u ON u.id = d.rider_id
  JOIN restaurant_branches b ON b.id = o.branch_id
  WHERE o.created_at >= $1::date
    AND o.created_at < ($2::date + INTERVAL '1 day')
  GROUP BY u.id, u.name
  ORDER BY deliveries_completed DESC, average_delivery_minutes ASC
  LIMIT 20
`


// ============================================================
// 5a. USER GROWTH — new accounts per day
// ============================================================
// Same calendar trick as the revenue trend. The counts are split by role
// with FILTER so one row per day carries the whole composition of that
// day's signups, instead of one row per day per role.
const USER_GROWTH_SQL = `
  SELECT
    to_char(series.day, 'YYYY-MM-DD') AS day,
    COUNT(u.id)::INTEGER AS signups,
    COUNT(u.id) FILTER (WHERE u.role = 'customer')::INTEGER AS customers,
    COUNT(u.id) FILTER (WHERE u.role = 'rider')::INTEGER AS riders,
    COUNT(u.id) FILTER (WHERE u.role = 'restaurant_owner')::INTEGER AS restaurant_owners
  FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS series(day)
  LEFT JOIN users u
    ON u.created_at >= series.day
   AND u.created_at < series.day + INTERVAL '1 day'
  GROUP BY series.day
  ORDER BY series.day
`


// ============================================================
// 5b. USER COMPOSITION — how the whole platform is made up
// ============================================================
// GROUP BY role collapses the users table into one row per role. The
// share is a window function: SUM(COUNT(*)) OVER () is the grand total
// across all the grouped rows, so each row can be expressed as a
// percentage of the whole without a second query.
const USER_COMPOSITION_SQL = `
  SELECT
    u.role,
    COUNT(*)::INTEGER AS user_count,
    COUNT(*) FILTER (WHERE u.is_active)::INTEGER AS active_count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS share_pct
  FROM users u
  GROUP BY u.role
  ORDER BY user_count DESC
`


// ============================================================
// 6. ORDER STATUS BREAKDOWN
// ============================================================
// The percentage is computed in SQL, by the same window-function trick:
// COUNT(*) is this status's count, and SUM(COUNT(*)) OVER () sums those
// counts across every row the GROUP BY produced — the total number of
// orders in the range. The 100.0 (not 100) forces decimal division, or
// integer division would round every share down to a whole number.
const STATUS_BREAKDOWN_SQL = `
  SELECT
    o.status,
    COUNT(*)::INTEGER AS order_count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS percentage,
    COALESCE(SUM(o.total_amount), 0) AS order_value
  FROM orders o
  WHERE o.created_at >= $1::date
    AND o.created_at < ($2::date + INTERVAL '1 day')
  GROUP BY o.status
  ORDER BY order_count DESC
`


// ============================================================
// ENDPOINTS
// GET /api/admin/analytics/<report>?from=&to=
//
// 401 no/invalid token · 403 authenticated non-admin
// 400 malformed dates · 200 otherwise
// ============================================================
function report(sql, key) {
  return withRange(async (req, res) => {
    const result = await pool.query(sql, params(req))
    res.json({ range: req.range, [key]: result.rows })
  })
}

router.get('/trend', report(TREND_SQL, 'trend'))
router.get('/top-restaurants', report(TOP_RESTAURANTS_SQL, 'top_restaurants'))
router.get('/rider-performance', report(RIDER_PERFORMANCE_SQL, 'rider_performance'))
router.get('/status-breakdown', report(STATUS_BREAKDOWN_SQL, 'status_breakdown'))

// Headline is a single row rather than a list.
router.get('/headline', withRange(async (req, res) => {
  const result = await pool.query(HEADLINE_SQL, params(req))
  res.json({ range: req.range, headline: result.rows[0] })
}))

// Growth is two shapes at once: a day-by-day series and the standing
// composition of the platform.
router.get('/user-growth', withRange(async (req, res) => {
  const [growth, composition] = await Promise.all([
    pool.query(USER_GROWTH_SQL, params(req)),
    pool.query(USER_COMPOSITION_SQL)
  ])
  res.json({ range: req.range, user_growth: growth.rows, user_composition: composition.rows })
}))

// Everything in one response, so the dashboard makes one request instead
// of six. Same queries and the same role gate — a convenience for the
// page, not a second way in.
router.get('/', withRange(async (req, res) => {
  const values = params(req)
  const [headline, trend, restaurants, riders, growth, composition, statuses] = await Promise.all([
    pool.query(HEADLINE_SQL, values),
    pool.query(TREND_SQL, values),
    pool.query(TOP_RESTAURANTS_SQL, values),
    pool.query(RIDER_PERFORMANCE_SQL, values),
    pool.query(USER_GROWTH_SQL, values),
    pool.query(USER_COMPOSITION_SQL),
    pool.query(STATUS_BREAKDOWN_SQL, values)
  ])

  res.json({
    range: req.range,
    headline: headline.rows[0],
    trend: trend.rows,
    top_restaurants: restaurants.rows,
    rider_performance: riders.rows,
    user_growth: growth.rows,
    user_composition: composition.rows,
    status_breakdown: statuses.rows
  })
}))


module.exports = router

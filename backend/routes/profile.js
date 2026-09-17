const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

const router = express.Router()

// Everything below needs a verified session. authenticateToken re-reads the
// account from the database on every request, so req.user.id and
// req.user.role are the database's answer, not the browser's claim. No
// handler in this file ever reads a user id from a param, a query string or
// a body — that is what stops one customer opening another's profile.
router.use(authenticateToken)


// ============================================================
// The shared block every role sees: who you are.
// Selected by id from the token. Password is never selected.
// ============================================================
async function loadAccount(userId) {
  const result = await pool.query(
    `SELECT id, name, email, phone, role, created_at
     FROM users
     WHERE id = $1`,
    [userId]
  )

  return result.rows[0] || null
}


// ============================================================
// CUSTOMER
// Lifetime totals + the five most recent orders.
// ============================================================
async function buildCustomerProfile(userId) {

  // One pass over this customer's orders produces every number on the page.
  // COUNT/SUM with FILTER do the work in the database; nothing is counted in
  // JavaScript. A cancelled order still happened, so it is counted, but it
  // was never paid for, so it is excluded from the spend.
  const totals = await pool.query(
    `SELECT
       COUNT(*)::INTEGER AS total_orders,
       COUNT(*) FILTER (WHERE status = 'delivered')::INTEGER AS delivered_orders,
       COUNT(*) FILTER (WHERE status = 'cancelled')::INTEGER AS cancelled_orders,
       COALESCE(SUM(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS total_spent,
       COALESCE(AVG(total_amount) FILTER (WHERE status <> 'cancelled'), 0) AS average_order_value
     FROM orders
     WHERE customer_id = $1`,
    [userId]
  )

  // The recent list walks order -> branch -> restaurant so each row can show
  // where the food came from. A "join" here simply means: for every order,
  // also fetch the matching branch row and that branch's restaurant row.
  const recentOrders = await pool.query(
    `SELECT
       o.id,
       o.status,
       o.total_amount,
       o.created_at,
       r.name AS restaurant_name,
       b.area AS branch_area
     FROM orders o
     JOIN restaurant_branches b ON b.id = o.branch_id
     JOIN restaurants r ON r.id = b.restaurant_id
     WHERE o.customer_id = $1
     ORDER BY o.created_at DESC
     LIMIT 5`,
    [userId]
  )

  // Counted in SQL rather than by measuring the length of a fetched list.
  const saved = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM customer_addresses WHERE user_id = $1)::INTEGER AS address_count,
       (SELECT COUNT(*) FROM customer_favorites WHERE user_id = $1)::INTEGER AS favorite_count`,
    [userId]
  )

  return {
    stats: { ...totals.rows[0], ...saved.rows[0] },
    recent_orders: recentOrders.rows
  }
}


// ============================================================
// RIDER
// Vehicle and availability come from rider_profiles; the numbers come
// from this rider's own deliveries.
// ============================================================
async function buildRiderProfile(userId) {

  const riderProfile = await pool.query(
    `SELECT vehicle_type, status
     FROM rider_profiles
     WHERE user_id = $1`,
    [userId]
  )

  // deliveries holds the rider's side of an order, orders holds when it was
  // placed and what it was worth — so the two are joined to measure how long
  // a delivery took. AVG of a subtraction between two timestamps gives an
  // interval; EXTRACT(EPOCH ...) turns that into seconds, and dividing by 60
  // gives whole minutes, which is what the page wants to print.
  const totals = await pool.query(
    `SELECT
       COUNT(*)::INTEGER AS deliveries_assigned,
       COUNT(*) FILTER (WHERE d.delivery_status = 'delivered')::INTEGER AS deliveries_completed,
       ROUND(
         EXTRACT(EPOCH FROM AVG(d.delivery_time - o.created_at)
           FILTER (WHERE d.delivery_status = 'delivered' AND d.delivery_time IS NOT NULL)
         ) / 60
       )::INTEGER AS average_delivery_minutes,
       COALESCE(SUM(o.delivery_fee) FILTER (WHERE d.delivery_status = 'delivered'), 0) AS delivery_fees_earned
     FROM deliveries d
     JOIN orders o ON o.id = d.order_id
     WHERE d.rider_id = $1`,
    [userId]
  )

  const recentDeliveries = await pool.query(
    `SELECT
       d.order_id,
       d.delivery_status,
       d.delivery_time,
       o.total_amount,
       o.delivery_fee,
       o.created_at,
       r.name AS restaurant_name
     FROM deliveries d
     JOIN orders o ON o.id = d.order_id
     JOIN restaurant_branches b ON b.id = o.branch_id
     JOIN restaurants r ON r.id = b.restaurant_id
     WHERE d.rider_id = $1
     ORDER BY o.created_at DESC
     LIMIT 5`,
    [userId]
  )

  return {
    rider_profile: riderProfile.rows[0] || null,
    stats: totals.rows[0],
    recent_deliveries: recentDeliveries.rows
  }
}


// ============================================================
// RESTAURANT OWNER
// Every figure is reached by joining through restaurants.owner_id, so an
// owner can only ever be shown their own restaurants — there is no
// restaurant id coming from the client to tamper with.
// ============================================================
async function buildOwnerProfile(userId) {

  // One row per owned restaurant. The two LEFT JOINs fan the rows out (a
  // restaurant with 3 branches and 10 items produces 30 combinations), which
  // is exactly why the counts use COUNT(DISTINCT ...) — otherwise each
  // branch would be counted once per menu item. LEFT keeps a brand-new
  // restaurant with no branches and no menu visible, showing zeros.
  const restaurants = await pool.query(
    `SELECT
       r.id,
       r.name,
       r.cuisine,
       r.avg_rating,
       r.review_count,
       COUNT(DISTINCT b.id)::INTEGER AS branch_count,
       COUNT(DISTINCT mi.id)::INTEGER AS menu_item_count
     FROM restaurants r
     LEFT JOIN restaurant_branches b ON b.restaurant_id = r.id
     LEFT JOIN menu_items mi ON mi.restaurant_id = r.id
     WHERE r.owner_id = $1
     GROUP BY r.id, r.name, r.cuisine, r.avg_rating, r.review_count
     ORDER BY r.name`,
    [userId]
  )

  // Orders are counted in their own query rather than bolted onto the one
  // above: joining orders as a third branch would multiply the rows again
  // and inflate the money. The chain order -> branch -> restaurant is the
  // ownership proof; the WHERE clause is on owner_id, never on an id sent in.
  const orderTotals = await pool.query(
    `SELECT
       COUNT(o.id)::INTEGER AS orders_received,
       COUNT(o.id) FILTER (WHERE o.status = 'delivered')::INTEGER AS orders_delivered,
       COUNT(o.id) FILTER (WHERE o.status IN ('pending', 'confirmed', 'preparing', 'out_for_delivery'))::INTEGER AS orders_in_progress,
       COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'delivered'), 0) AS revenue
     FROM orders o
     JOIN restaurant_branches b ON b.id = o.branch_id
     JOIN restaurants r ON r.id = b.restaurant_id
     WHERE r.owner_id = $1`,
    [userId]
  )

  // One rating across every restaurant this owner runs. A plain AVG of the
  // per-restaurant averages would let a restaurant with 2 reviews weigh as
  // much as one with 200, so each average is weighted by its review count
  // before dividing. NULLIF turns a zero divisor into NULL — "no rating yet"
  // — instead of a division-by-zero error.
  const rating = await pool.query(
    `SELECT
       ROUND(
         SUM(r.avg_rating * r.review_count) / NULLIF(SUM(r.review_count), 0),
         2
       ) AS average_rating,
       COALESCE(SUM(r.review_count), 0)::INTEGER AS review_count,
       COUNT(*)::INTEGER AS restaurant_count
     FROM restaurants r
     WHERE r.owner_id = $1`,
    [userId]
  )

  return {
    restaurants: restaurants.rows,
    stats: { ...orderTotals.rows[0], ...rating.rows[0] }
  }
}


// ============================================================
// ADMIN
// Platform-wide totals only. The real tooling lives in /admin; this is
// just the admin's own account page.
// ============================================================
async function buildAdminProfile() {

  // GROUP BY role collapses the users table into one row per role with its
  // count — four rows out of however many thousand, computed by the database.
  const usersByRole = await pool.query(
    `SELECT role, COUNT(*)::INTEGER AS count
     FROM users
     GROUP BY role
     ORDER BY role`
  )

  // Each bracketed sub-SELECT is its own aggregate, run once and returned as
  // a column. They are kept in one statement so the page makes a single trip
  // to the database for its headline numbers.
  const totals = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM users)::INTEGER AS user_count,
       (SELECT COUNT(*) FROM restaurants)::INTEGER AS restaurant_count,
       (SELECT COUNT(*) FROM restaurant_branches)::INTEGER AS branch_count,
       (SELECT COUNT(*) FROM orders)::INTEGER AS order_count,
       (SELECT COUNT(*) FROM orders WHERE status = 'delivered')::INTEGER AS delivered_order_count,
       (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'delivered') AS delivered_revenue`
  )

  return {
    users_by_role: usersByRole.rows,
    stats: totals.rows[0]
  }
}


// The dispatch table. Keyed by the role string the database stores, so a
// role the client made up simply has no entry here.
const PROFILE_BUILDERS = {
  customer: buildCustomerProfile,
  rider: buildRiderProfile,
  restaurant_owner: buildOwnerProfile,
  admin: buildAdminProfile
}


// ============================================================
// GET /api/profile
// Any signed-in user. The role is read from the verified session, so the
// caller cannot ask for a different role's payload.
// ============================================================
router.get('/', async (req, res) => {
  const account = await loadAccount(req.user.id)
  if (!account) return res.status(404).json({ error: 'Account not found.' })

  const build = PROFILE_BUILDERS[req.user.role]
  if (!build) return res.status(403).json({ error: 'This account role has no profile view.' })

  const details = await build(req.user.id)
  res.json({ user: account, role: req.user.role, ...details })
})


// ============================================================
// The same four payloads, each behind its own role gate.
// GET /api/profile/customer | /rider | /owner | /admin
//
// The page uses GET /api/profile above; these exist so each role's data
// has an endpoint that answers 403 to anyone else — the same enforcement,
// stated explicitly rather than implied by the dispatch table.
// ============================================================
function roleScoped(role, build) {
  return [requireRole(role), async (req, res) => {
    const account = await loadAccount(req.user.id)
    if (!account) return res.status(404).json({ error: 'Account not found.' })
    res.json({ user: account, role, ...(await build(req.user.id)) })
  }]
}

router.get('/customer', ...roleScoped('customer', buildCustomerProfile))
router.get('/rider', ...roleScoped('rider', buildRiderProfile))
router.get('/owner', ...roleScoped('restaurant_owner', buildOwnerProfile))
router.get('/admin', ...roleScoped('admin', buildAdminProfile))


module.exports = router

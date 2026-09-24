const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

const router = express.Router()

const ALLOWED_ROLES = ['customer', 'restaurant_owner', 'rider', 'admin']


// ============================================================
// GET /api/admin/users?role=&page=&limit=
// admin only
// Lists every user on the platform. Password hashes are never selected,
// let alone returned.
// ============================================================
router.get(
  '/users',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    const { role } = req.query
    const page = req.query.page === undefined ? 1 : Number(req.query.page)
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)

    if (!Number.isInteger(page) || page <= 0) {
      return res.status(400).json({
        error: 'page must be a positive integer.'
      })
    }

    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      return res.status(400).json({
        error: 'limit must be an integer between 1 and 100.'
      })
    }

    if (role && !ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        error: `role must be one of: ${ALLOWED_ROLES.join(', ')}.`
      })
    }

    const values = []
    const conditions = []

    if (role) {
      values.push(role)
      conditions.push(`role = $${values.length}`)
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : ''

    const offset = (page - 1) * limit
    values.push(limit, offset)

    try {
      const result = await pool.query(`
        SELECT
          id,
          name,
          email,
          role,
          phone,
          is_active,
          created_at,
          COUNT(*) OVER()::INTEGER AS total_count
        FROM users
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${values.length - 1}
        OFFSET $${values.length}
      `, values)

      const total = result.rows[0]?.total_count || 0
      const users = result.rows.map(({ total_count, ...user }) => user)

      res.json({
        users,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      })

    } catch (error) {
      console.error('List users error:', error)

      res.status(500).json({
        error: 'Server error fetching users.'
      })
    }
  }
)


// ============================================================
// PATCH /api/admin/users/:id/status
// admin only
// Suspends or reactivates a user account. A suspended account is
// blocked at login AND on every subsequent request (see middleware/auth.js).
// ============================================================
router.patch(
  '/users/:id/status',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    const targetId = Number(req.params.id)
    const { is_active } = req.body

    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({
        error: 'Invalid user id.'
      })
    }

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({
        error: 'is_active must be true or false.'
      })
    }

    if (targetId === req.user.id) {
      return res.status(400).json({
        error: 'You cannot change your own account status.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const result = await client.query(`
        UPDATE users
        SET is_active = $1
        WHERE id = $2
        RETURNING id, name, email, role, phone, is_active, created_at
      `, [is_active, targetId])

      if (result.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'User not found.'
        })
      }

      await client.query('COMMIT')

      res.json({
        user: result.rows[0],
        message: `User account ${is_active ? 'reactivated' : 'suspended'}.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Update user status error:', error)

      res.status(500).json({
        error: 'Server error updating user status.'
      })

    } finally {
      client.release()
    }
  }
)


// ============================================================
// GET /api/admin/stats
// admin only
// Platform-wide counts. Distinct from anything a customer or restaurant
// owner can see — this is the admin's own capability, not borrowed access.
// ============================================================
router.get(
  '/stats',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    try {
      const [usersResult, restaurantsResult, ordersResult] = await Promise.all([
        pool.query(`SELECT role, COUNT(*)::INTEGER AS count FROM users GROUP BY role`),
        pool.query(`SELECT COUNT(*)::INTEGER AS count FROM restaurants`),
        pool.query(`SELECT status, COUNT(*)::INTEGER AS count FROM orders GROUP BY status`)
      ])

      res.json({
        users_by_role: usersResult.rows,
        restaurant_count: restaurantsResult.rows[0]?.count || 0,
        orders_by_status: ordersResult.rows
      })

    } catch (error) {
      console.error('Admin stats error:', error)

      res.status(500).json({
        error: 'Server error fetching stats.'
      })
    }
  }
)


// ============================================================
// GET /api/admin/rider-reviews?rider_id=&page=&limit=
// admin only
//
// The ONLY way rider feedback can be read back. Customers write it
// (POST /api/reviews/orders/:orderId/rider) and nobody else — not the rider,
// not the restaurant owner, not the public restaurant page — has an endpoint
// that returns it. Hiding it in the UI would not be enough; it is hidden
// because no other route selects the table.
//
// Returns two things at once, because the panel shows both: the newest-first
// feed of individual reviews, and a per-rider scorecard.
// ============================================================
router.get(
  '/rider-reviews',
  authenticateToken,
  requireRole('admin'),
  async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page)
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit)
    const riderId = req.query.rider_id === undefined || req.query.rider_id === ''
      ? null
      : Number(req.query.rider_id)

    if (!Number.isInteger(page) || page <= 0) {
      return res.status(400).json({
        error: 'page must be a positive integer.'
      })
    }

    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      return res.status(400).json({
        error: 'limit must be an integer between 1 and 100.'
      })
    }

    if (riderId !== null && (!Number.isInteger(riderId) || riderId <= 0)) {
      return res.status(400).json({
        error: 'rider_id must be a positive integer.'
      })
    }

    // Built as a list so the optional rider filter keeps its own placeholder
    // number — the query is still fully parameterized, only the $n positions
    // are assembled here.
    const values = []
    let riderFilter = ''

    if (riderId !== null) {
      values.push(riderId)
      riderFilter = `WHERE rr.rider_id = $${values.length}`
    }

    const offset = (page - 1) * limit
    values.push(limit, offset)

    try {
      const [reviewsResult, scorecardResult] = await Promise.all([
        // Five tables: the review, the rider, the order, the customer who
        // wrote it, and the branch -> restaurant the order was placed at.
        // COUNT(*) OVER() rides along so the total for pagination costs no
        // second round trip, the same trick GET /api/admin/users uses.
        pool.query(`
          SELECT
            rr.id,
            rr.order_id,
            rr.rating,
            rr.comment,
            rr.created_at,
            rider.id AS rider_id,
            rider.name AS rider_name,
            rider.is_active AS rider_is_active,
            customer.name AS customer_name,
            r.name AS restaurant_name,
            COUNT(*) OVER()::INTEGER AS total_count
          FROM rider_reviews rr
          JOIN users rider
            ON rider.id = rr.rider_id
          JOIN orders o
            ON o.id = rr.order_id
          JOIN users customer
            ON customer.id = o.customer_id
          JOIN restaurant_branches rb
            ON rb.id = o.branch_id
          JOIN restaurants r
            ON r.id = rb.restaurant_id
          ${riderFilter}
          ORDER BY rr.created_at DESC
          LIMIT $${values.length - 1}
          OFFSET $${values.length}
        `, values),

        // The scorecard is deliberately NOT filtered or paginated: the admin
        // needs every rider's standing to decide who to look at. Worst
        // average first, because that is the row worth acting on.
        pool.query(`
          SELECT
            rider.id AS rider_id,
            rider.name AS rider_name,
            rider.is_active,
            COUNT(rr.id)::INTEGER AS review_count,
            ROUND(AVG(rr.rating), 2) AS average_rating,
            -- One or two stars is a complaint; counting them separately shows
            -- a rider with a few bad deliveries hidden behind a fair average.
            COUNT(*) FILTER (WHERE rr.rating <= 2)::INTEGER AS low_rating_count
          FROM users rider
          JOIN rider_reviews rr
            ON rr.rider_id = rider.id
          WHERE rider.role = 'rider'
          GROUP BY rider.id, rider.name, rider.is_active
          ORDER BY average_rating ASC, review_count DESC
        `)
      ])

      const total = reviewsResult.rows[0]?.total_count || 0
      const reviews = reviewsResult.rows.map(({ total_count, ...review }) => review)

      res.json({
        reviews,
        riders: scorecardResult.rows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit)
        }
      })

    } catch (error) {
      console.error('List rider reviews error:', error)

      res.status(500).json({
        error: 'Server error fetching rider reviews.'
      })
    }
  }
)


module.exports = router

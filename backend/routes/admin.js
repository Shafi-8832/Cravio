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


module.exports = router

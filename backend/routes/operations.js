const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')
const router = express.Router()
router.use(authenticateToken)

// All ticket reads are scoped in SQL, including callers who guess another id.
router.get('/tickets', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT t.*, u.name AS user_name, u.role AS user_role
      FROM support_tickets t JOIN users u ON u.id = t.user_id
      WHERE ($1 = 'admin' OR t.user_id = $2)
      ORDER BY t.created_at DESC LIMIT 100`, [req.user.role, req.user.id])
    res.json({ tickets: result.rows })
  } catch (error) { next(error) }
})

router.post('/tickets', async (req, res, next) => {
  const { subject, message, order_id } = req.body
  if (typeof subject !== 'string' || subject.trim().length < 3 || subject.trim().length > 120 ||
      typeof message !== 'string' || message.trim().length < 10 || message.trim().length > 4000) {
    return res.status(400).json({ error: 'Subject must be 3–120 characters and message 10–4,000 characters.' })
  }
  if (order_id != null && !parseId(order_id)) return res.status(400).json({ error: 'Invalid order id.' })
  try {
    if (order_id != null) {
      const allowed = await pool.query(`SELECT o.id FROM orders o
        JOIN restaurant_branches b ON b.id = o.branch_id JOIN restaurants r ON r.id = b.restaurant_id
        WHERE o.id = $1 AND ($2 = 'admin' OR o.customer_id = $3 OR o.rider_id = $3 OR r.owner_id = $3)`,
      [Number(order_id), req.user.role, req.user.id])
      if (!allowed.rows.length) return res.status(404).json({ error: 'Order not found for your account.' })
    }
    const result = await pool.query(`INSERT INTO support_tickets(user_id, order_id, subject, message)
      VALUES ($1, $2, $3, $4) RETURNING *`, [req.user.id, order_id ?? null, subject.trim(), message.trim()])
    res.status(201).json({ ticket: result.rows[0] })
  } catch (error) { next(error) }
})

router.patch('/tickets/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id)
  const { status, admin_reply } = req.body
  if (!id || !['open', 'in_progress', 'resolved'].includes(status) ||
      typeof admin_reply !== 'string' || admin_reply.trim().length < 1 || admin_reply.length > 4000) {
    return res.status(400).json({ error: 'Choose a valid status and write a reply of 1–4,000 characters.' })
  }
  try {
    const result = await pool.query(`UPDATE support_tickets SET status = $1, admin_reply = $2,
      resolved_by = $3, updated_at = NOW() WHERE id = $4 RETURNING *`, [status, admin_reply.trim(), req.user.id, id])
    if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found.' })
    res.json({ ticket: result.rows[0] })
  } catch (error) { next(error) }
})

router.get('/promos', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT id, code, discount_percent, min_order_amount,
      expiry_date, is_active, usage_limit, used_count FROM promo_codes
      WHERE ($1 = 'admin' OR (is_active = TRUE AND expiry_date >= CURRENT_DATE AND used_count < usage_limit))
      ORDER BY expiry_date DESC LIMIT 100`, [req.user.role])
    res.json({ promos: result.rows })
  } catch (error) { next(error) }
})

router.post('/promos', requireRole('admin'), async (req, res, next) => {
  const { code, discount_percent, min_order_amount = 0, expiry_date, usage_limit = 100 } = req.body
  const date = typeof expiry_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry_date) ? new Date(`${expiry_date}T00:00:00Z`) : null
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{2,20}$/.test(code) ||
      !Number.isInteger(discount_percent) || discount_percent < 1 || discount_percent > 100 ||
      typeof min_order_amount !== 'number' || !Number.isFinite(min_order_amount) || min_order_amount < 0 || min_order_amount > 1000000 ||
      !Number.isInteger(usage_limit) || usage_limit < 1 || usage_limit > 1000000 ||
      !date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== expiry_date) {
    return res.status(400).json({ error: 'Provide a valid promo code, percentage (1–100), minimum, expiry date, and usage limit.' })
  }
  try {
    const result = await pool.query(`INSERT INTO promo_codes(code, discount_percent, min_order_amount, expiry_date, usage_limit)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [code.toUpperCase(), discount_percent, min_order_amount, expiry_date, usage_limit])
    res.status(201).json({ promo: result.rows[0] })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That promo code already exists.' })
    next(error)
  }
})

router.patch('/promos/:id', requireRole('admin'), async (req, res, next) => {
  const id = parseId(req.params.id)
  if (!id || typeof req.body.is_active !== 'boolean') return res.status(400).json({ error: 'Provide a valid id and is_active boolean.' })
  try {
    const result = await pool.query('UPDATE promo_codes SET is_active = $1 WHERE id = $2 RETURNING *', [req.body.is_active, id])
    if (!result.rows.length) return res.status(404).json({ error: 'Promo code not found.' })
    res.json({ promo: result.rows[0] })
  } catch (error) { next(error) }
})

router.get('/orders', requireRole('admin'), async (req, res, next) => {
  const page = Number(req.query.page || 1)
  if (!Number.isInteger(page) || page < 1 || page > 100000) return res.status(400).json({ error: 'Invalid page.' })
  try {
    const result = await pool.query(`SELECT o.*, r.name AS restaurant_name, u.name AS customer_name,
      b.division, p.method AS payment_method, p.status AS payment_status, COUNT(*) OVER()::INTEGER AS total_count
      FROM orders o JOIN restaurant_branches b ON b.id = o.branch_id
      JOIN restaurants r ON r.id = b.restaurant_id JOIN users u ON u.id = o.customer_id
      LEFT JOIN payments p ON p.order_id = o.id ORDER BY o.created_at DESC LIMIT 30 OFFSET $1`, [(page - 1) * 30])
    res.json({ orders: result.rows.map(({ total_count, ...order }) => order), pagination: { page, limit: 30, total: result.rows[0]?.total_count || 0 } })
  } catch (error) { next(error) }
})

// Delivery fees are gross collected fees, not rider pay. Payout agreements are separate.
router.get('/summary', requireRole('admin', 'restaurant_owner', 'rider'), async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT COUNT(*)::INTEGER AS order_count,
      COUNT(*) FILTER (WHERE o.status = 'delivered')::INTEGER AS delivered_count,
      COUNT(*) FILTER (WHERE o.status = 'cancelled')::INTEGER AS cancelled_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'delivered' AND p.status = 'paid'), 0) AS collected_total,
      COALESCE(SUM(o.delivery_fee) FILTER (WHERE o.status = 'delivered' AND p.status = 'paid'), 0) AS collected_delivery_fees
      FROM orders o JOIN restaurant_branches b ON b.id = o.branch_id
      JOIN restaurants r ON r.id = b.restaurant_id LEFT JOIN payments p ON p.order_id = o.id
      WHERE ($1 = 'admin' OR ($1 = 'restaurant_owner' AND r.owner_id = $2) OR ($1 = 'rider' AND o.rider_id = $2))`,
    [req.user.role, req.user.id])
    res.json({ summary: result.rows[0], currency: 'BDT' })
  } catch (error) { next(error) }
})

module.exports = router

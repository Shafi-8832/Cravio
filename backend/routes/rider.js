const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

const router = express.Router()

// A delivery can only move forward one step at a time. This is the rider-side
// equivalent of OWNER_STATUS_TRANSITIONS in services/orderService.js.
const DELIVERY_TRANSITIONS = {
  assigned: ['picked_up'],
  picked_up: ['delivered']
}


// ============================================================
// GET /api/rider/deliveries/available
// rider only
// Orders that are ready for pickup (status = 'preparing') and have not
// been claimed by any rider yet.
// ============================================================
router.get(
  '/deliveries/available',
  authenticateToken,
  requireRole('rider'),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          o.id AS order_id,
          o.delivery_address,
          o.total_amount,
          o.created_at,
          r.name AS restaurant_name,
          rb.address AS branch_address,
          rb.area AS branch_area,
          rb.city AS branch_city,
          rb.phone AS branch_phone
        FROM orders o
        JOIN restaurant_branches rb
          ON rb.id = o.branch_id
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        WHERE o.status = 'preparing'
          AND NOT EXISTS (
            SELECT 1 FROM deliveries d WHERE d.order_id = o.id
          )
        ORDER BY o.created_at ASC
      `)

      res.json({
        deliveries: result.rows
      })

    } catch (error) {
      console.error('List available deliveries error:', error)

      res.status(500).json({
        error: 'Server error fetching available deliveries.'
      })
    }
  }
)


// ============================================================
// GET /api/rider/deliveries/mine
// rider only
// Every delivery this rider has ever accepted — active and completed.
// Object-level scoping: WHERE d.rider_id = req.user.id, never trusts a
// rider_id supplied by the client.
// ============================================================
router.get(
  '/deliveries/mine',
  authenticateToken,
  requireRole('rider'),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          d.id AS delivery_id,
          d.delivery_status,
          d.delivery_time,
          o.id AS order_id,
          o.status AS order_status,
          o.delivery_address,
          o.total_amount,
          r.name AS restaurant_name,
          rb.address AS branch_address,
          rb.area AS branch_area,
          rb.city AS branch_city
        FROM deliveries d
        JOIN orders o
          ON o.id = d.order_id
        JOIN restaurant_branches rb
          ON rb.id = o.branch_id
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        WHERE d.rider_id = $1
        ORDER BY o.created_at DESC
      `, [req.user.id])

      res.json({
        deliveries: result.rows
      })

    } catch (error) {
      console.error('List my deliveries error:', error)

      res.status(500).json({
        error: 'Server error fetching your deliveries.'
      })
    }
  }
)


// ============================================================
// POST /api/rider/deliveries/:orderId/accept
// rider only
// Claims an unassigned order that is ready for pickup. Uses a row lock
// on the order (FOR UPDATE) so two riders racing to accept the same
// order can't both succeed.
// ============================================================
router.post(
  '/deliveries/:orderId/accept',
  authenticateToken,
  requireRole('rider'),
  async (req, res) => {
    const orderId = Number(req.params.orderId)

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        error: 'Invalid order id.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const orderResult = await client.query(`
        SELECT id, status
        FROM orders
        WHERE id = $1
        FOR UPDATE
      `, [orderId])

      if (orderResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Order not found.'
        })
      }

      if (orderResult.rows[0].status !== 'preparing') {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'Order is not ready for pickup.'
        })
      }

      const existingDelivery = await client.query(`
        SELECT id FROM deliveries WHERE order_id = $1
      `, [orderId])

      if (existingDelivery.rows.length > 0) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'This order has already been claimed by another rider.'
        })
      }

      await client.query(`
        UPDATE orders
        SET status = 'out_for_delivery', rider_id = $1
        WHERE id = $2
      `, [req.user.id, orderId])

      const deliveryResult = await client.query(`
        INSERT INTO deliveries
          (order_id, rider_id, delivery_status)
        VALUES
          ($1, $2, 'assigned')
        RETURNING *
      `, [orderId, req.user.id])

      await client.query('COMMIT')

      res.status(201).json({
        delivery: deliveryResult.rows[0],
        message: 'Delivery accepted.'
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Accept delivery error:', error)

      res.status(500).json({
        error: 'Server error accepting delivery.'
      })

    } finally {
      client.release()
    }
  }
)


// ============================================================
// PATCH /api/rider/deliveries/:orderId/status
// rider only
// Moves a delivery forward: assigned -> picked_up -> delivered.
// Ownership check: only the rider assigned to this delivery may update it.
// ============================================================
router.patch(
  '/deliveries/:orderId/status',
  authenticateToken,
  requireRole('rider'),
  async (req, res) => {
    const orderId = Number(req.params.orderId)
    const { status } = req.body

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        error: 'Invalid order id.'
      })
    }

    if (!['picked_up', 'delivered'].includes(status)) {
      return res.status(400).json({
        error: 'status must be picked_up or delivered.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const deliveryResult = await client.query(`
        SELECT id, rider_id, delivery_status
        FROM deliveries
        WHERE order_id = $1
        FOR UPDATE
      `, [orderId])

      if (deliveryResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Delivery not found.'
        })
      }

      const delivery = deliveryResult.rows[0]

      if (delivery.rider_id !== req.user.id) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You are not assigned to this delivery.'
        })
      }

      const allowedNext = DELIVERY_TRANSITIONS[delivery.delivery_status] || []

      if (!allowedNext.includes(status)) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: `Delivery status cannot change from ${delivery.delivery_status} to ${status}.`
        })
      }

      // Both uses of $1 are cast explicitly. Without the casts Postgres infers
      // the parameter's type twice and disagrees with itself — varchar from the
      // assignment to delivery_status, text from the comparison in the CASE —
      // and rejects the whole statement with 42P08 "inconsistent types deduced
      // for parameter $1".
      await client.query(`
        UPDATE deliveries
        SET
          delivery_status = $1::varchar,
          delivery_time = CASE
            WHEN $1::varchar = 'delivered' THEN CURRENT_TIMESTAMP
            ELSE delivery_time
          END
        WHERE order_id = $2
      `, [status, orderId])

      if (status === 'delivered') {
        await client.query(`
          UPDATE orders
          SET status = 'delivered', review_eligible = true
          WHERE id = $1
        `, [orderId])

        // Cash is handed to the rider at the door, so delivery IS the payment
        // event for COD — there is no separate confirmation step to wait for.
        // Online methods are left alone: those are settled by the restaurant
        // verifying the transaction reference (see routes/payments.js).
        await client.query(`
          UPDATE payments
          SET
            status = 'paid',
            paid_at = CURRENT_TIMESTAMP
          WHERE order_id = $1
            AND method = 'cash_on_delivery'
            AND status = 'unpaid'
        `, [orderId])
      }

      await client.query('COMMIT')

      res.json({
        message: `Delivery marked as ${status}.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Update delivery status error:', error)

      res.status(500).json({
        error: 'Server error updating delivery status.'
      })

    } finally {
      client.release()
    }
  }
)


module.exports = router

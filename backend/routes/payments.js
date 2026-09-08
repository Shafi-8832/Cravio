const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')

const router = express.Router()

// There is no payment gateway wired up, and pretending otherwise would be
// worse than not having one. So the two payment paths are modelled honestly:
//
//   cash_on_delivery : settled automatically when the rider marks the order
//                      delivered (see routes/rider.js) — money changes hands
//                      in person, the app only records it.
//
//   bkash / nagad    : the customer pays out-of-band and submits the
//                      transaction reference here; the restaurant checks it
//                      against their own account and marks it paid or failed.
//                      This mirrors how a lot of small operators in
//                      Bangladesh actually reconcile mobile payments.
//
// The client is never allowed to declare its own payment 'paid'. That is the
// whole reason the confirm step is restricted to the restaurant owner.


// Loads a payment together with everything needed to authorize the caller:
// who placed the order, and who owns the restaurant it belongs to.
const findPaymentForOrder = async (db, orderId) => {
  const result = await db.query(
    `
      SELECT
        p.id,
        p.order_id,
        p.method,
        p.amount,
        p.status,
        p.transaction_ref,
        p.paid_at,
        o.customer_id,
        o.status AS order_status,
        r.owner_id
      FROM payments p
      JOIN orders o
        ON o.id = p.order_id
      JOIN restaurant_branches rb
        ON rb.id = o.branch_id
      JOIN restaurants r
        ON r.id = rb.restaurant_id
      WHERE p.order_id = $1
    `,
    [orderId]
  )

  return result.rows[0] || null
}

// Strips the authorization-only columns before the row goes to the client.
const toPublicPayment = (row) => ({
  id: row.id,
  order_id: row.order_id,
  method: row.method,
  amount: row.amount,
  status: row.status,
  transaction_ref: row.transaction_ref,
  paid_at: row.paid_at
})


// ============================================================
// GET /api/payments/:orderId
// The order's customer, the restaurant owner, or an admin
// ============================================================
router.get(
  '/:orderId',
  authenticateToken,
  async (req, res) => {
    const orderId = parseId(req.params.orderId)

    if (orderId === null) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      })
    }

    try {
      const payment = await findPaymentForOrder(pool, orderId)

      if (!payment) {
        return res.status(404).json({
          error: 'Payment not found.'
        })
      }

      const isCustomer = payment.customer_id === req.user.id
      const isOwner = payment.owner_id === req.user.id

      if (req.user.role !== 'admin' && !isCustomer && !isOwner) {
        return res.status(403).json({
          error: 'You are not allowed to view this payment.'
        })
      }

      res.json({
        payment: toPublicPayment(payment)
      })

    } catch (error) {
      console.error('Get payment error:', error)

      res.status(500).json({
        error: 'Server error fetching payment.'
      })
    }
  }
)


// ============================================================
// POST /api/payments/:orderId/reference
// customer only
// Submits the bkash/nagad transaction reference for an order the
// customer has already paid for outside the app. Deliberately does NOT
// change status — only the restaurant can decide the money arrived.
// ============================================================
router.post(
  '/:orderId/reference',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    const orderId = parseId(req.params.orderId)
    const { transaction_ref } = req.body

    if (orderId === null) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      })
    }

    const reference =
      typeof transaction_ref === 'string' ? transaction_ref.trim() : ''

    if (!reference) {
      return res.status(400).json({
        error: 'transaction_ref is required.'
      })
    }

    if (reference.length > 100) {
      return res.status(400).json({
        error: 'transaction_ref cannot exceed 100 characters.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const payment = await findPaymentForOrder(client, orderId)

      if (!payment) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Payment not found.'
        })
      }

      if (payment.customer_id !== req.user.id) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only pay for your own orders.'
        })
      }

      if (payment.method === 'cash_on_delivery') {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'Cash orders are settled on delivery, not by reference.',
          code: 'METHOD_IS_CASH'
        })
      }

      // Re-submitting after the restaurant already accepted the money would
      // silently overwrite the reference they verified against.
      if (payment.status === 'paid') {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'This payment has already been confirmed.',
          code: 'ALREADY_PAID'
        })
      }

      const updated = await client.query(
        `
          UPDATE payments
          SET
            transaction_ref = $1,
            status = 'unpaid'
          WHERE order_id = $2
          RETURNING id, order_id, method, amount, status, transaction_ref, paid_at
        `,
        [reference, orderId]
      )

      await client.query('COMMIT')

      res.json({
        payment: updated.rows[0],
        message: 'Reference submitted. Awaiting confirmation from the restaurant.'
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Submit payment reference error:', error)

      res.status(500).json({
        error: 'Server error submitting payment reference.'
      })

    } finally {
      client.release()
    }
  }
)


// ============================================================
// PATCH /api/payments/:orderId/status
// restaurant_owner or admin only
// The verification step: the restaurant has checked their own bkash/nagad
// account and is recording whether the money actually arrived.
// ============================================================
router.patch(
  '/:orderId/status',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {
    const orderId = parseId(req.params.orderId)
    const { status } = req.body

    if (orderId === null) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      })
    }

    if (!['paid', 'failed'].includes(status)) {
      return res.status(400).json({
        error: 'status must be paid or failed.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const payment = await findPaymentForOrder(client, orderId)

      if (!payment) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Payment not found.'
        })
      }

      if (req.user.role !== 'admin' && payment.owner_id !== req.user.id) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only manage payments for your own restaurant.'
        })
      }

      // Confirming a payment for an order nobody is going to deliver would
      // leave the books claiming money for cancelled food.
      if (payment.order_status === 'cancelled' && status === 'paid') {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'Cannot mark a cancelled order as paid.',
          code: 'ORDER_CANCELLED'
        })
      }

      if (payment.status === status) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: `Payment is already ${status}.`,
          code: 'NO_STATUS_CHANGE'
        })
      }

      const updated = await client.query(
        `
          UPDATE payments
          SET
            status = $1::varchar,
            -- paid_at is the moment it was confirmed, and is cleared again if
            -- a mistaken confirmation is reversed to 'failed'.
            --
            -- Both uses of $1 are cast explicitly: without the casts Postgres
            -- infers varchar from the assignment and text from this comparison,
            -- then rejects the statement with 42P08 "inconsistent types deduced
            -- for parameter $1".
            paid_at = CASE WHEN $1::varchar = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE order_id = $2
          RETURNING id, order_id, method, amount, status, transaction_ref, paid_at
        `,
        [status, orderId]
      )

      await client.query('COMMIT')

      res.json({
        payment: updated.rows[0],
        message: `Payment marked as ${status}.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Update payment status error:', error)

      res.status(500).json({
        error: 'Server error updating payment status.'
      })

    } finally {
      client.release()
    }
  }
)


module.exports = router

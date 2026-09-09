const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')

const router = express.Router()

const PORTION_ACCURACY_VALUES = ['full', 'slightly_less', 'way_less']

// How many 'way_less' reports an item needs before it is flagged. One angry
// customer is not evidence of a systematic problem; a repeated pattern across
// separate orders is. Every report is still recorded in quality_flag_log
// regardless — the threshold only governs the flag on the menu item itself.
const QUALITY_FLAG_THRESHOLD = 3


// ============================================================
// POST /api/reviews/orders/:orderId
// customer only
// One review per order. orders.review_eligible is set by the rider when
// the delivery completes, so it doubles as proof the customer actually
// received the food — it is the gate for reviewing at all.
// ============================================================
router.post(
  '/orders/:orderId',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    const orderId = parseId(req.params.orderId)
    const { rating, portion_accuracy, comment } = req.body

    if (orderId === null) {
      return res.status(400).json({
        error: 'Invalid order ID.'
      })
    }

    const parsedRating = Number(rating)

    if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({
        error: 'rating must be an integer between 1 and 5.'
      })
    }

    if (
      portion_accuracy !== undefined &&
      portion_accuracy !== null &&
      !PORTION_ACCURACY_VALUES.includes(portion_accuracy)
    ) {
      return res.status(400).json({
        error: `portion_accuracy must be one of: ${PORTION_ACCURACY_VALUES.join(', ')}.`
      })
    }

    const trimmedComment =
      typeof comment === 'string' && comment.trim() ? comment.trim() : null

    if (trimmedComment && trimmedComment.length > 1000) {
      return res.status(400).json({
        error: 'comment cannot exceed 1000 characters.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // FOR UPDATE so two submissions racing on the same order can't both
      // pass the "already reviewed" check below.
      const orderResult = await client.query(
        `
          SELECT
            id,
            customer_id,
            status,
            review_eligible
          FROM orders
          WHERE id = $1
          FOR UPDATE
        `,
        [orderId]
      )

      if (orderResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Order not found.'
        })
      }

      const order = orderResult.rows[0]

      if (order.customer_id !== req.user.id) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only review your own orders.'
        })
      }

      if (!order.review_eligible || order.status !== 'delivered') {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'You can only review an order after it has been delivered.',
          code: 'NOT_REVIEW_ELIGIBLE'
        })
      }

      const existingReview = await client.query(
        'SELECT id FROM restaurant_reviews WHERE order_id = $1',
        [orderId]
      )

      if (existingReview.rows.length > 0) {
        await client.query('ROLLBACK')

        return res.status(409).json({
          error: 'This order has already been reviewed.',
          code: 'ALREADY_REVIEWED'
        })
      }

      const reviewResult = await client.query(
        `
          INSERT INTO restaurant_reviews
            (order_id, rating, portion_accuracy, comment)
          VALUES
            ($1, $2, $3, $4)
          RETURNING id, order_id, rating, portion_accuracy, comment, created_at
        `,
        [orderId, parsedRating, portion_accuracy || null, trimmedComment]
      )

      // ---------------------------------------------------------
      // Portion complaints feed the quality flag pipeline.
      // 'way_less' is a report that the kitchen shorted the portion, so
      // every item on the order gets a row in quality_flag_log, and any
      // item whose reports reach the threshold gets flagged on the menu.
      // ---------------------------------------------------------
      let flaggedItems = []

      if (portion_accuracy === 'way_less') {
        await client.query(
          `
            INSERT INTO quality_flag_log
              (menu_item_id, order_id)
            SELECT
              oi.menu_item_id,
              oi.order_id
            FROM order_items oi
            WHERE oi.order_id = $1
              AND oi.menu_item_id IS NOT NULL
          `,
          [orderId]
        )

        // Promote to a menu-level flag only once the same item has been
        // reported across enough distinct orders.
        const flagResult = await client.query(
          `
            UPDATE menu_items
            SET quality_flag = true
            WHERE id IN (
              SELECT qfl.menu_item_id
              FROM quality_flag_log qfl
              WHERE qfl.menu_item_id IN (
                SELECT menu_item_id
                FROM order_items
                WHERE order_id = $1
                  AND menu_item_id IS NOT NULL
              )
              GROUP BY qfl.menu_item_id
              HAVING COUNT(DISTINCT qfl.order_id) >= $2
            )
            AND quality_flag = false
            RETURNING id, name
          `,
          [orderId, QUALITY_FLAG_THRESHOLD]
        )

        flaggedItems = flagResult.rows
      }

      await client.query('COMMIT')

      res.status(201).json({
        review: reviewResult.rows[0],
        flagged_items: flaggedItems,
        message: 'Thanks for the review.'
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create review error:', error)

      res.status(500).json({
        error: 'Server error creating review.'
      })

    } finally {
      client.release()
    }
  }
)


// ============================================================
// GET /api/reviews/restaurants/:restaurantId
// Public
// Reviews for one restaurant, newest first, plus the rating summary.
//
// restaurant_reviews has no restaurant_id of its own — it is reached
// through order -> branch -> restaurant. That is why this is a three-join
// query rather than a simple WHERE.
// ============================================================
router.get(
  '/restaurants/:restaurantId',
  async (req, res) => {
    const restaurantId = parseId(req.params.restaurantId)

    if (restaurantId === null) {
      return res.status(400).json({
        error: 'Invalid restaurant ID.'
      })
    }

    try {
      // This doubles as the existence check and as the rating summary: the
      // summary used to be a separate aggregate over the same three-table
      // path as the list below, but avg_rating and review_count are now kept
      // on the restaurant row by trg_sync_restaurant_rating
      // (db/functions/restaurant_rating.sql).
      const restaurantResult = await pool.query(
        'SELECT id, avg_rating, review_count FROM restaurants WHERE id = $1',
        [restaurantId]
      )

      if (restaurantResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Restaurant not found.'
        })
      }

      const reviewsResult = await pool.query(
        `
          SELECT
            rev.id,
            rev.order_id,
            rev.rating,
            rev.portion_accuracy,
            rev.comment,
            rev.created_at,
            u.name AS customer_name
          FROM restaurant_reviews rev
          JOIN orders o
            ON o.id = rev.order_id
          JOIN restaurant_branches rb
            ON rb.id = o.branch_id
          JOIN users u
            ON u.id = o.customer_id
          WHERE rb.restaurant_id = $1
          ORDER BY rev.created_at DESC
        `,
        [restaurantId]
      )

      res.json({
        reviews: reviewsResult.rows,
        summary: {
          review_count: restaurantResult.rows[0].review_count,
          average_rating: restaurantResult.rows[0].avg_rating
        }
      })

    } catch (error) {
      console.error('List reviews error:', error)

      res.status(500).json({
        error: 'Server error fetching reviews.'
      })
    }
  }
)


module.exports = router

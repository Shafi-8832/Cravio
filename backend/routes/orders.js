const express = require('express')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const {
  OrderServiceError,
  placeOrder,
  listCustomerOrders,
  listRestaurantOrders,
  getOrderDetails,
  updateOrderStatus
} = require('../services/orderService')

const router = express.Router()

const sendError = (res, error, logMessage) => {
  if (error instanceof OrderServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code
    })
  }

  console.error(logMessage, error)

  return res.status(500).json({
    error: 'Internal server error.',
    code: 'INTERNAL_SERVER_ERROR'
  })
}

// ============================================================
// POST /api/orders
// Customer only - atomically converts one restaurant cart to an order
// ============================================================
router.post(
  '/',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    try {
      const order = await placeOrder(req.user.id, req.body)

      return res.status(201).json({
        message: 'Order placed successfully.',
        order
      })
    } catch (error) {
      return sendError(res, error, 'Place order error:')
    }
  }
)

// ============================================================
// GET /api/orders/my-orders?status=pending&page=1&limit=20
// Customer only - logged-in customer's paginated order history
// Keep this route above /:id so "my-orders" is not treated as an ID.
// ============================================================
router.get(
  '/my-orders',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    try {
      const result = await listCustomerOrders(req.user.id, req.query)
      return res.json(result)
    } catch (error) {
      return sendError(res, error, 'Get customer orders error:')
    }
  }
)

// ============================================================
// GET /api/orders/restaurant?status=pending&branch_id=1&page=1&limit=20
// Restaurant owner only - returns orders from restaurants they own
// ============================================================
router.get(
  '/restaurant',
  authenticateToken,
  requireRole('restaurant_owner'),
  async (req, res) => {
    try {
      const result = await listRestaurantOrders(req.user.id, req.query)
      return res.json(result)
    } catch (error) {
      return sendError(res, error, 'Get restaurant orders error:')
    }
  }
)

// ============================================================
// GET /api/orders/:id
// Customer can see their order; owner can see their restaurant's order;
// admin can see any order.
// ============================================================
router.get(
  '/:id',
  authenticateToken,
  requireRole('customer', 'restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const order = await getOrderDetails(req.params.id, req.user)
      return res.json({ order })
    } catch (error) {
      return sendError(res, error, 'Get order details error:')
    }
  }
)

// ============================================================
// PATCH /api/orders/:id/status
// Owner actions:
// pending -> confirmed (Accept) or cancelled (Reject)
// confirmed -> preparing or cancelled
// ============================================================
router.patch(
  '/:id/status',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const order = await updateOrderStatus(
        req.params.id,
        req.body.status,
        req.user
      )

      return res.json({
        message: 'Order status updated successfully.',
        order
      })
    } catch (error) {
      return sendError(res, error, 'Update order status error:')
    }
  }
)

module.exports = router

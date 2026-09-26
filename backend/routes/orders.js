const express = require('express')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const {
  OrderServiceError,
  getOrderRoute,
  getOrderTracking,
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
// GET /api/orders/:id/tracking
// Live map data for one order. Every role may call it, but the service
// then allows only the people connected to THIS order: its customer, its
// assigned rider, the owner of its restaurant, or an admin (else 403).
// The frontend polls this every 5 seconds while the order is on the road.
// ============================================================
router.get(
  '/:id/tracking',
  authenticateToken,
  requireRole('customer', 'rider', 'restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const tracking = await getOrderTracking(req.params.id, req.user)
      return res.json({ tracking })
    } catch (error) {
      return sendError(res, error, 'Order tracking error:')
    }
  }
)

// ============================================================
// GET /api/orders/:id/route
// The planned road route (branch -> drop-off) for the tracking map.
// Same people as /tracking may call it. The route is fetched from OSRM
// once and cached in order_routes; the map asks for it once on load.
// ============================================================
router.get(
  '/:id/route',
  authenticateToken,
  requireRole('customer', 'rider', 'restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const route = await getOrderRoute(req.params.id, req.user)
      return res.json({ route })
    } catch (error) {
      return sendError(res, error, 'Order route error:')
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


// ============================================================
// PATCH /api/orders/:id/cancel
// Customer only - back out of an order the restaurant has not started
// cooking yet (pending or confirmed). Separate from /status because a
// customer has exactly one legal transition, so there is nothing for the
// client to choose and no status to send.
// ============================================================
router.patch(
  '/:id/cancel',
  authenticateToken,
  requireRole('customer'),
  async (req, res) => {
    try {
      const order = await updateOrderStatus(
        req.params.id,
        'cancelled',
        req.user
      )

      return res.json({
        message: 'Order cancelled.',
        order
      })
    } catch (error) {
      return sendError(res, error, 'Cancel order error:')
    }
  }
)

module.exports = router

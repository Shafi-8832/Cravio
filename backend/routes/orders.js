const express = require('express')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const {
  OrderServiceError,
  PREP_MINUTE_OPTIONS,
  REJECTION_REASONS,
  getOrderRoute,
  getOrderTracking,
  placeOrder,
  listCustomerOrders,
  listRestaurantOrders,
  getOrderDetails,
  updateOrderStatus,
  acceptOrder,
  rejectOrder,
  markFoodReady
} = require('../services/orderService')

const router = express.Router()

const sendError = (res, error, logMessage) => {
  if (error instanceof OrderServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code
    })
  }

  // 'CRV03' is the SQLSTATE trg_enforce_order_status_transition raises when
  // a status move is not on the state machine's map
  // (db/functions/order_lifecycle.sql). The service checks the same arrows
  // first, so reaching here means a path got past the application rule —
  // still the caller's problem (409), not a server fault, and worth logging
  // because it points at a code path that skipped the service.
  if (error.code === 'CRV03') {
    console.error(logMessage, error)

    return res.status(409).json({
      error: error.message,
      code: 'INVALID_STATUS_TRANSITION'
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
// GET /api/orders/lifecycle-options
// Declared BEFORE every /:id route: Express matches in registration order,
// so lower down it would be read as an order id called "lifecycle-options".
// Any authenticated caller.
//
// The prep-time buttons and rejection reasons the owner UI renders. Served
// from the server so the frontend's list and the database's CHECK
// constraints cannot drift apart — if a value is added here, the picker
// shows it without a frontend release.
// ============================================================
router.get(
  '/lifecycle-options',
  authenticateToken,
  (req, res) => res.json({
    prep_minutes: PREP_MINUTE_OPTIONS,
    rejection_reasons: REJECTION_REASONS
  })
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
// POST /api/orders/:id/accept     body: { prep_minutes }
// Owner of this order's restaurant, or admin.
//
// Accepting commits the kitchen to a time: it sets accepted_at = now and
// ready_at = now + prep_minutes, and moves the order to 'confirmed'.
// prep_minutes must be one of 10, 15, 20, 30, 45 — a list the database
// repeats in chk_order_prep_minutes, so no caller can promise 2 minutes.
//
// POST, not PATCH, because this is not "edit a field": it records a new
// fact (the restaurant's commitment) that did not exist before.
// ============================================================
router.post(
  '/:id/accept',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const order = await acceptOrder(
        req.params.id,
        req.body.prep_minutes,
        req.user
      )

      return res.json({
        message: `Order accepted. Food due in ${order.prep_minutes} minutes.`,
        order
      })
    } catch (error) {
      return sendError(res, error, 'Accept order error:')
    }
  }
)


// ============================================================
// POST /api/orders/:id/reject     body: { reason }
// Owner of this order's restaurant, or admin.
//
// A rejection is a cancellation with the reason kept, from one of three
// values: item_unavailable, kitchen_overloaded, closing_soon. The same
// cleanup as any cancellation runs in the same transaction — the promo slot
// goes back and the unpaid payment row is marked failed.
// ============================================================
router.post(
  '/:id/reject',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const order = await rejectOrder(
        req.params.id,
        req.body.reason,
        req.user
      )

      return res.json({
        message: 'Order rejected and the customer notified.',
        order
      })
    } catch (error) {
      return sendError(res, error, 'Reject order error:')
    }
  }
)


// ============================================================
// POST /api/orders/:id/food-ready
// Owner of this order's restaurant, or admin.
//
// The write that opens the pickup gate: food_ready_at = now and status
// 'preparing' -> 'food_ready'. Until this lands, pickup_delivery() raises
// FOOD_NOT_READY and the rider's confirm-pickup call comes back 409.
// ============================================================
router.post(
  '/:id/food-ready',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {
    try {
      const order = await markFoodReady(req.params.id, req.user)

      return res.json({
        message: 'Food marked ready. A rider can now collect it.',
        order
      })
    } catch (error) {
      return sendError(res, error, 'Mark food ready error:')
    }
  }
)


// ============================================================
// PATCH /api/orders/:id/status
// Owner actions that need no extra input:
// confirmed -> preparing, and cancelled from confirmed/preparing/food_ready.
//
// Accepting (pending -> confirmed) is POST /:id/accept because it needs a
// prep time; rejecting is POST /:id/reject because it needs a reason; and
// marking the food ready is POST /:id/food-ready because it writes the
// timestamp the rider gate reads.
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

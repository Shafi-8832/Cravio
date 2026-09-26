async function runSequentially(jobs) {
  const results = []
  for (const job of jobs) results.push(await job())
  return results
}

const pool = require('../db/pool')
const { parseCoordinates } = require('../utils/validation')
const { getRoadRoute } = require('./routing')

class OrderServiceError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'OrderServiceError'
    this.status = status
    this.code = code
  }
}

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
  'cancelled'
]

const OWNER_STATUS_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled']
}

// A customer may back out only while the restaurant has not started cooking.
// Once the order is 'preparing' the food is already being made, so cancelling
// is the restaurant's call, not the customer's.
const CUSTOMER_STATUS_TRANSITIONS = {
  pending: ['cancelled'],
  confirmed: ['cancelled']
}

// all the exceptions that can be thrown by the place_order function in the database 
// are mapped to a more user-friendly error message and status code here. 
// This allows the application to provide more meaningful feedback to the user when an error occurs during the checkout process.
const CHECKOUT_ERROR_MAP = {
  RESTAURANT_NOT_ORDERABLE: [409, 'RESTAURANT_NOT_ORDERABLE', 'This restaurant is listed for reference and is not accepting orders.'],
  CART_MODIFIERS_CHANGED: [409, 'CART_MODIFIERS_CHANGED', 'Menu options changed. Remove and add the affected item again.'],
  BRANCH_MINIMUM_NOT_MET: [409, 'BRANCH_MINIMUM_NOT_MET', 'The cart does not meet this branch minimum order amount.'],
  CUSTOMER_NOT_FOUND_OR_INVALID_ROLE: [
    403,
    'CUSTOMER_REQUIRED',
    'Only a valid customer account can place an order.'
  ],
  BRANCH_NOT_FOUND: [
    404,
    'BRANCH_NOT_FOUND',
    'Restaurant branch not found.'
  ],
  BRANCH_CLOSED: [
    409,
    'BRANCH_CLOSED',
    'This restaurant branch is currently closed.'
  ],
  CART_NOT_FOUND: [
    409,
    'CART_NOT_FOUND',
    'No cart exists for this restaurant.'
  ],
  CART_EMPTY: [
    409,
    'CART_EMPTY',
    'Your cart is empty.'
  ],
  CART_CONTAINS_INVALID_ITEM: [
    409,
    'CART_CONTAINS_INVALID_ITEM',
    'The cart contains an item from a different restaurant.'
  ],
  CART_CONTAINS_UNAVAILABLE_ITEM: [
    409,
    'CART_CONTAINS_UNAVAILABLE_ITEM',
    'One or more cart items are no longer available.'
  ],
  CART_CONTAINS_UNAVAILABLE_MODIFIER: [
    409,
    'CART_CONTAINS_UNAVAILABLE_MODIFIER',
    'One or more selected options are no longer available.'
  ],
  PROMO_CODE_INVALID: [
    422,
    'PROMO_CODE_INVALID',
    'Promo code is invalid.'
  ],
  PROMO_CODE_INACTIVE: [
    422,
    'PROMO_CODE_INACTIVE',
    'Promo code is inactive.'
  ],
  PROMO_CODE_EXPIRED: [
    422,
    'PROMO_CODE_EXPIRED',
    'Promo code has expired.'
  ],
  PROMO_CODE_EXHAUSTED: [
    422,
    'PROMO_CODE_EXHAUSTED',
    'Promo code usage limit has been reached.'
  ],
  PROMO_MINIMUM_NOT_MET: [
    422,
    'PROMO_MINIMUM_NOT_MET',
    'The order does not meet the promo code minimum.'
  ],
  INVALID_PAYMENT_METHOD: [
    400,
    'INVALID_PAYMENT_METHOD',
    'Payment method must be cash_on_delivery, bkash, or nagad.'
  ],
  INVALID_DELIVERY_ADDRESS: [
    400,
    'INVALID_DELIVERY_ADDRESS',
    'A delivery address is required.'
  ]
}

// explain this function: 
// This function takes a value and a field name as input, 
// and attempts to convert the value to a positive integer. 
// If the conversion fails or the resulting integer is not positive, 
// it throws an OrderServiceError with a validation error message. 
// This is used to ensure that certain fields, such as order IDs or pagination parameters, 
// are valid positive integers before proceeding with further processing.

const toPositiveInteger = (value, fieldName) => {
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      `${fieldName} must be a positive integer.`
    )
  }

  return parsed
}

const normalizePagination = (pageValue, limitValue) => {
  const page = pageValue === undefined ? 1 : Number(pageValue)
  const limit = limitValue === undefined ? 20 : Number(limitValue)

  if (!Number.isInteger(page) || page <= 0) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      'page must be a positive integer.'
    )
  }

  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      'limit must be an integer between 1 and 100.'
    )
  }

  return {
    page,
    limit,
    offset: (page - 1) * limit
  }
}

const validateStatusFilter = (status) => {
  if (status && !ORDER_STATUSES.includes(status)) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      `status must be one of: ${ORDER_STATUSES.join(', ')}.`
    )
  }
}

const mapCheckoutError = (error) => {
  for (const [databaseMessage, details] of Object.entries(CHECKOUT_ERROR_MAP)) {
    if (error.message?.includes(databaseMessage)) {
      return new OrderServiceError(...details)
    }
  }

  return error
}

// place_order() increments promo_codes.used_count at checkout. If the order
// is later cancelled that consumption was never actually realised, so give
// the slot back — otherwise every cancellation permanently shrinks how many
// times a promo can still be used.
//
// GREATEST(..., 0) guards against a negative count if a row is ever
// decremented twice; the caller only calls this on a real pending ->
// cancelled transition, but the floor makes the column safe regardless.
const refundPromoUsage = async (client, promoCodeId) => {
  if (!promoCodeId) {
    return
  }

  await client.query(
    `
      UPDATE promo_codes
      SET used_count = GREATEST(used_count - 1, 0)
      WHERE id = $1
    `,
    [promoCodeId]
  )
}

const getOrderDetailsWithDb = async (db, orderId, actor) => {
  const conditions = ['o.id = $1']
  const values = [orderId]

  if (actor.role === 'customer') {
    values.push(actor.id)
    conditions.push(`o.customer_id = $${values.length}`)
  } else if (actor.role === 'restaurant_owner') {
    values.push(actor.id)
    conditions.push(`r.owner_id = $${values.length}`)
  } else if (actor.role !== 'admin') {
    throw new OrderServiceError(
      403,
      'ACCESS_DENIED',
      'You are not allowed to view this order.'
    )
  }

  const orderResult = await db.query(
    `
      SELECT
        o.id,
        o.status,
        o.delivery_address,
        o.subtotal,
        o.discount_amount,
        o.delivery_fee,
        o.total_amount,
        o.review_eligible,
        -- Whether the rider has already been rated for this order, so the
        -- receipt can hide the rider form after a reload instead of offering
        -- a submission the API would reject with ALREADY_REVIEWED.
        -- Only the boolean is exposed here; the rating and comment themselves
        -- are readable exclusively through GET /api/admin/rider-reviews.
        EXISTS (
          SELECT 1
          FROM rider_reviews rr
          WHERE rr.order_id = o.id
        ) AS rider_reviewed,
        o.created_at,
        o.promo_code_id,
        pc.code AS promo_code,
        c.id AS customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone,
        r.id AS restaurant_id,
        r.name AS restaurant_name,
        rb.id AS branch_id,
        rb.address AS branch_address,
        rb.area AS branch_area,
        rb.city AS branch_city,
        rb.phone AS branch_phone
      FROM orders o
      JOIN users c
        ON c.id = o.customer_id
      JOIN restaurant_branches rb
        ON rb.id = o.branch_id
      JOIN restaurants r
        ON r.id = rb.restaurant_id
      LEFT JOIN promo_codes pc
        ON pc.id = o.promo_code_id
      WHERE ${conditions.join(' AND ')}
    `,
    values
  )

  if (orderResult.rows.length === 0) {
    throw new OrderServiceError(
      404,
      'ORDER_NOT_FOUND',
      'Order not found.'
    )
  }

  const [itemsResult, paymentResult, deliveryResult, timelineResult] = await runSequentially([
    () => db.query(
      `
        SELECT
          oi.id,
          oi.menu_item_id,
          COALESCE(oi.item_name, mi.name) AS name,
          oi.image_url,
          oi.quantity,
          oi.unit_price,
          line.modifier_total,
          -- unit_price is the base menu price; the chosen modifiers are added
          -- before multiplying by quantity, matching how place_order()
          -- computed the subtotal in the first place.
          ROUND((oi.unit_price + line.modifier_total) * oi.quantity, 2) AS line_total,
          oi.special_instruction,
          line.modifiers
        FROM order_items oi
        LEFT JOIN menu_items mi
          ON mi.id = oi.menu_item_id
        CROSS JOIN LATERAL (
          SELECT
            COALESCE(SUM(oim.price_modifier), 0.00) AS modifier_total,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'modifier_option_id', oim.modifier_option_id,
                  'name', oim.name,
                  'price_modifier', oim.price_modifier
                )
                ORDER BY oim.id
              ) FILTER (WHERE oim.id IS NOT NULL),
              '[]'
            ) AS modifiers
          FROM order_item_modifiers oim
          WHERE oim.order_item_id = oi.id
        ) AS line
        WHERE oi.order_id = $1
        ORDER BY oi.id
      `,
      [orderId]
    ),
    () => db.query(
      `
        SELECT
          id,
          method,
          amount,
          status,
          transaction_ref,
          paid_at
        FROM payments
        WHERE order_id = $1
      `,
      [orderId]
    ),
    () => db.query(
      `
        SELECT
          d.id,
          d.rider_id,
          u.name AS rider_name,
          u.phone AS rider_phone,
          d.delivery_status,
          d.delivery_time,
          d.recipient_note
        FROM deliveries d
        LEFT JOIN users u
          ON u.id = d.rider_id
        WHERE d.order_id = $1
      `,
      [orderId]
    ),
    () => db.query('SELECT status, note, created_at FROM order_events WHERE order_id = $1 ORDER BY id', [orderId])
  ])

  const row = orderResult.rows[0]

  return {
    id: row.id,
    status: row.status,
    delivery_address: row.delivery_address,
    subtotal: row.subtotal,
    discount_amount: row.discount_amount,
    delivery_fee: row.delivery_fee,
    total_amount: row.total_amount,
    review_eligible: row.review_eligible,
    rider_reviewed: row.rider_reviewed,
    created_at: row.created_at,
    promo: row.promo_code_id
      ? {
          id: row.promo_code_id,
          code: row.promo_code
        }
      : null,
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      phone: row.customer_phone
    },
    restaurant: {
      id: row.restaurant_id,
      name: row.restaurant_name,
      branch: {
        id: row.branch_id,
        address: row.branch_address,
        area: row.branch_area,
        city: row.branch_city,
        phone: row.branch_phone
      }
    },
    items: itemsResult.rows,
    timeline: timelineResult.rows,
    payment: paymentResult.rows[0] || null,
    delivery: deliveryResult.rows[0] || null
  }
}

const placeOrder = async (customerId, payload, database = pool) => {
  const branchId = toPositiveInteger(payload.branch_id, 'branch_id')
  const deliveryAddress =
    typeof payload.delivery_address === 'string'
      ? payload.delivery_address.trim()
      : ''
  const paymentMethod = payload.payment_method
  const promoCode =
    typeof payload.promo_code === 'string' && payload.promo_code.trim()
      ? payload.promo_code.trim()
      : null

  if (!deliveryAddress) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      'delivery_address is required.'
    )
  }

  if (deliveryAddress.length > 500) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      'delivery_address cannot exceed 500 characters.'
    )
  }

  if (!['cash_on_delivery', 'bkash', 'nagad'].includes(paymentMethod)) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      'payment_method must be cash_on_delivery, bkash, or nagad.'
    )
  }

  if (paymentMethod !== 'cash_on_delivery' && process.env.ALLOW_MANUAL_PAYMENTS !== 'true') {
    throw new OrderServiceError(409, 'PAYMENT_METHOD_DISABLED', 'Mobile payments are not enabled. Choose cash on delivery.')
  }

  // The map pin is optional: checkout without one keeps working exactly as
  // before. But if either coordinate is sent, both must be valid.
  const isBlank = (value) => value === undefined || value === null || value === ''
  let deliveryPoint = null

  if (!isBlank(payload.delivery_latitude) || !isBlank(payload.delivery_longitude)) {
    deliveryPoint = parseCoordinates(payload.delivery_latitude, payload.delivery_longitude)

    if (deliveryPoint.error) {
      throw new OrderServiceError(400, 'VALIDATION_ERROR', `Delivery pin: ${deliveryPoint.error}`)
    }
  }

  const client = await database.connect()

  try {
    await client.query('BEGIN')

    const result = await client.query(
      `
        SELECT *
        FROM place_order($1, $2, $3, $4, $5)
      `,
      [
        customerId,
        branchId,
        deliveryAddress,
        paymentMethod,
        promoCode
      ]
    )

    // Snapshot the drop-off pin onto the new order, inside the SAME
    // transaction as place_order(): if anything later fails, the order and
    // its pin roll back together. Done here rather than by changing
    // place_order()'s parameter list, which would leave the old 5-argument
    // version behind as an ambiguous overload.
    if (deliveryPoint) {
      await client.query(
        `
          UPDATE orders
          SET delivery_latitude = $1,
              delivery_longitude = $2
          WHERE id = $3
        `,
        [deliveryPoint.latitude, deliveryPoint.longitude, result.rows[0].order_id]
      )
    }

    const order = await getOrderDetailsWithDb(
      client,
      result.rows[0].order_id,
      {
        id: customerId,
        role: 'customer'
      }
    )

    await client.query('COMMIT')
    return order
  } catch (error) {
    await client.query('ROLLBACK')
    throw mapCheckoutError(error)
  } finally {
    client.release()
  }
}

const listCustomerOrders = async (
  customerId,
  filters = {},
  database = pool
) => {
  const { status } = filters
  const pagination = normalizePagination(filters.page, filters.limit)
  validateStatusFilter(status)

  const values = [customerId]
  const conditions = ['o.customer_id = $1']

  if (status) {
    values.push(status)
    conditions.push(`o.status = $${values.length}`)
  }

  values.push(pagination.limit, pagination.offset)

  const result = await database.query(
    `
      SELECT
        o.id,
        o.status,
        o.subtotal,
        o.discount_amount,
        o.delivery_fee,
        o.total_amount,
        o.delivery_address,
        o.created_at,
        r.id AS restaurant_id,
        r.name AS restaurant_name,
        rb.id AS branch_id,
        rb.area AS branch_area,
        rb.city AS branch_city,
        p.method AS payment_method,
        p.status AS payment_status,
        COALESCE(item_summary.item_count, 0)::INTEGER AS item_count,
        COUNT(*) OVER()::INTEGER AS total_count
      FROM orders o
      JOIN restaurant_branches rb
        ON rb.id = o.branch_id
      JOIN restaurants r
        ON r.id = rb.restaurant_id
      LEFT JOIN payments p
        ON p.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT SUM(oi.quantity) AS item_count
        FROM order_items oi
        WHERE oi.order_id = o.id
      ) item_summary ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `,
    values
  )

  const total = result.rows[0]?.total_count || 0
  const orders = result.rows.map(({ total_count: _totalCount, ...order }) => order)

  return {
    orders,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      total_pages: Math.ceil(total / pagination.limit)
    }
  }
}

const listRestaurantOrders = async (
  ownerId,
  filters = {},
  database = pool
) => {
  const { status } = filters
  const pagination = normalizePagination(filters.page, filters.limit)
  validateStatusFilter(status)

  const values = [ownerId]
  const conditions = ['r.owner_id = $1']

  if (status) {
    values.push(status)
    conditions.push(`o.status = $${values.length}`)
  }

  if (filters.branch_id !== undefined) {
    const branchId = toPositiveInteger(filters.branch_id, 'branch_id')
    values.push(branchId)
    conditions.push(`o.branch_id = $${values.length}`)
  }

  values.push(pagination.limit, pagination.offset)

  const result = await database.query(
    `
      SELECT
        o.id,
        o.status,
        o.total_amount,
        o.delivery_address,
        o.created_at,
        c.id AS customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone,
        r.id AS restaurant_id,
        r.name AS restaurant_name,
        rb.id AS branch_id,
        rb.area AS branch_area,
        rb.city AS branch_city,
        COALESCE(items.items, '[]'::json) AS items,
        COUNT(*) OVER()::INTEGER AS total_count
      FROM orders o
      JOIN users c
        ON c.id = o.customer_id
      JOIN restaurant_branches rb
        ON rb.id = o.branch_id
      JOIN restaurants r
        ON r.id = rb.restaurant_id
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'id', oi.id,
            'menu_item_id', oi.menu_item_id,
            'name', COALESCE(oi.item_name, mi.name),
            'image_url', oi.image_url,
            'quantity', oi.quantity,
            'unit_price', oi.unit_price
          )
          ORDER BY oi.id
        ) AS items
        FROM order_items oi
        LEFT JOIN menu_items mi
          ON mi.id = oi.menu_item_id
        WHERE oi.order_id = o.id
      ) items ON true
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `,
    values
  )

  const total = result.rows[0]?.total_count || 0
  const orders = result.rows.map(({ total_count: _totalCount, ...order }) => order)

  return {
    orders,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      total_pages: Math.ceil(total / pagination.limit)
    }
  }
}

const getOrderDetails = async (orderIdValue, actor, database = pool) => {
  const orderId = toPositiveInteger(orderIdValue, 'order id')
  return getOrderDetailsWithDb(database, orderId, actor)
}

const updateOrderStatus = async (
  orderIdValue,
  newStatus,
  actor,
  database = pool
) => {
  const orderId = toPositiveInteger(orderIdValue, 'order id')

  // A customer only ever cancels; owners and admins drive the order forward.
  const isCustomer = actor.role === 'customer'

  const allowedTargets = isCustomer
    ? ['cancelled']
    : ['confirmed', 'preparing', 'cancelled']

  if (!allowedTargets.includes(newStatus)) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      isCustomer
        ? 'Customers can only cancel an order.'
        : 'Restaurant owners can set status to confirmed, preparing, or cancelled.'
    )
  }

  const client = await database.connect()

  try {
    await client.query('BEGIN')

    const orderResult = await client.query(
      `
        SELECT
          o.id,
          o.status,
          o.customer_id,
          o.promo_code_id,
          r.owner_id
        FROM orders o
        JOIN restaurant_branches rb
          ON rb.id = o.branch_id
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        WHERE o.id = $1
        FOR UPDATE OF o
      `,
      [orderId]
    )

    if (orderResult.rows.length === 0) {
      throw new OrderServiceError(
        404,
        'ORDER_NOT_FOUND',
        'Order not found.'
      )
    }

    const currentOrder = orderResult.rows[0]

    // Object-level authorization: a customer must own the order, an owner must
    // own the restaurant it was placed with. Admin bypasses both.
    if (actor.role !== 'admin') {
      const isOwnResource = isCustomer
        ? currentOrder.customer_id === actor.id
        : currentOrder.owner_id === actor.id

      if (!isOwnResource) {
        throw new OrderServiceError(
          403,
          'ACCESS_DENIED',
          isCustomer
            ? 'You can only cancel your own orders.'
            : 'You can only manage orders from your own restaurant.'
        )
      }
    }

    const transitions = isCustomer
      ? CUSTOMER_STATUS_TRANSITIONS
      : OWNER_STATUS_TRANSITIONS

    const permittedStatuses = transitions[currentOrder.status] || []

    if (!permittedStatuses.includes(newStatus)) {
      throw new OrderServiceError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Order status cannot change from ${currentOrder.status} to ${newStatus}.`
      )
    }

    if (newStatus === 'confirmed') {
      const payment = await client.query('SELECT method,status FROM payments WHERE order_id=$1 FOR UPDATE', [orderId])
      if (payment.rows[0]?.method !== 'cash_on_delivery' && payment.rows[0]?.status !== 'paid') {
        throw new OrderServiceError(409, 'PAYMENT_NOT_VERIFIED', 'Verify the mobile payment reference before confirming the order.')
      }
    }

    if (newStatus === 'cancelled') {
      const payment = await client.query('SELECT status FROM payments WHERE order_id = $1 FOR UPDATE', [orderId])
      if (payment.rows[0]?.status === 'paid') {
        throw new OrderServiceError(409, 'REFUND_REQUIRED', 'Payment is already received. Contact support to arrange a refund before cancellation.')
      }
    }

    await client.query(
      `
        UPDATE orders
        SET status = $1
        WHERE id = $2
      `,
      [newStatus, orderId]
    )

    if (newStatus === 'cancelled') {
      // Same transaction as the status change, so the promo slot and the
      // cancellation either both land or neither does.
      await refundPromoUsage(client, currentOrder.promo_code_id)

      // A cancelled order will never be paid for. Leaving the payment row
      // 'unpaid' would make it indistinguishable from one still awaiting
      // settlement in any payments report.
      await client.query(
        `
          UPDATE payments
          SET status = 'failed'
          WHERE order_id = $1
            AND status = 'unpaid'
        `,
        [orderId]
      )
    }

    const order = await getOrderDetailsWithDb(client, orderId, actor)

    await client.query('COMMIT')
    return order
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

// ============================================================
// LIVE TRACKING
// ============================================================

// The only status in which a rider is carrying the food towards the
// customer. Set when the rider marks the order picked up (routes/rider.js).
const TRACKABLE_STATUS = 'out_for_delivery'

// Loads one order together with the people connected to it, and throws
// unless the caller is one of them. Shared by /tracking and /route so both
// endpoints enforce exactly the same rule.
//   - no such order                 -> 404
//   - caller not connected to it    -> 403
// The pickup and drop-off coordinates come along because /route needs them.
const loadOrderForViewer = async (database, orderId, actor) => {
  // Fetched first so a missing order (404) and somebody else's order (403)
  // get different answers.
  const accessResult = await database.query(
    `
      SELECT
        o.status, o.customer_id, o.rider_id, r.owner_id,
        rb.latitude::float8 AS restaurant_latitude,
        rb.longitude::float8 AS restaurant_longitude,
        o.delivery_latitude::float8 AS delivery_latitude,
        o.delivery_longitude::float8 AS delivery_longitude
      FROM orders o
      JOIN restaurant_branches rb ON rb.id = o.branch_id
      JOIN restaurants r ON r.id = rb.restaurant_id
      WHERE o.id = $1
    `,
    [orderId]
  )

  if (accessResult.rows.length === 0) {
    throw new OrderServiceError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  }

  const order = accessResult.rows[0]

  // Object-level check: four kinds of people may watch this order, each
  // matched on the id from the verified token against the id stored on
  // the order (or on its restaurant).
  const allowed =
    actor.role === 'admin' ||
    (actor.role === 'customer' && order.customer_id === actor.id) ||
    (actor.role === 'rider' && order.rider_id === actor.id) ||
    (actor.role === 'restaurant_owner' && order.owner_id === actor.id)

  if (!allowed) {
    throw new OrderServiceError(403, 'ACCESS_DENIED', 'You are not allowed to track this order.')
  }

  return order
}

const getOrderTracking = async (orderIdValue, actor, database = pool) => {
  const orderId = toPositiveInteger(orderIdValue, 'order id')

  // Step 1 — 404 / 403 checks (see loadOrderForViewer above).
  const access = await loadOrderForViewer(database, orderId, actor)

  // Not on the road (yet, or any more). A delivered order in particular
  // must NOT reveal where the rider is now — that would let a past
  // customer keep following a rider around the city.
  if (access.status !== TRACKABLE_STATUS) {
    return { tracking_active: false, status: access.status }
  }

  // ------------------------------------------------------------
  // Step 2 — GRADED COMPLEX QUERY: the live tracking snapshot.
  // Joins orders, restaurant_branches, restaurants, users (the rider's
  // name) and rider_current_location in one statement, and does ALL the
  // maths in SQL:
  //   - distance_remaining_km: our distance_km() function, rider -> drop-off
  //   - eta_minutes: distance at an assumed 20 km/h, in minutes, rounded UP
  //   - seconds_since_update / is_stale: how old the last GPS fix is
  //
  // LEFT JOIN on the rider and the location, because a rider who has not
  // sent a position yet has no rider_current_location row; an inner join
  // would make the whole order disappear. Their columns come back NULL
  // instead, and distance_km() (STRICT) returns NULL for them too — as it
  // does for an older order with no drop-off pin.
  //
  // The inner SELECT computes the distance once; the outer one reuses it
  // for the ETA, since a SELECT cannot use its own column alias.
  // is_stale is TRUE when the last fix is older than 60 seconds OR when
  // there has never been one: either way the map cannot trust the marker.
  // ::float8 makes pg send JSON numbers instead of NUMERIC strings.
  // ------------------------------------------------------------
  const trackingResult = await database.query(
    `
      SELECT
        live.*,
        -- ETA assumption: an average of 20 km/h in Dhaka traffic, over the
        -- straight-line distance. km / (km per hour) = hours; * 60 = minutes;
        -- CEIL rounds up so we never promise "0 minutes" too early.
        CEIL(live.distance_remaining_km / 20.0 * 60)::int AS eta_minutes
      FROM (
        SELECT
          o.id AS order_id,
          o.status,
          r.name AS restaurant_name,
          rb.area AS branch_area,
          rb.latitude::float8 AS restaurant_latitude,
          rb.longitude::float8 AS restaurant_longitude,
          o.delivery_latitude::float8 AS delivery_latitude,
          o.delivery_longitude::float8 AS delivery_longitude,
          rider.name AS rider_name,
          loc.latitude::float8 AS rider_latitude,
          loc.longitude::float8 AS rider_longitude,
          loc.updated_at AS rider_updated_at,
          distance_km(loc.latitude, loc.longitude,
                      o.delivery_latitude, o.delivery_longitude)::float8 AS distance_remaining_km,
          FLOOR(EXTRACT(EPOCH FROM now() - loc.updated_at))::int AS seconds_since_update,
          COALESCE(now() - loc.updated_at > interval '60 seconds', true) AS is_stale
        FROM orders o
        JOIN restaurant_branches rb ON rb.id = o.branch_id
        JOIN restaurants r ON r.id = rb.restaurant_id
        LEFT JOIN users rider ON rider.id = o.rider_id
        LEFT JOIN rider_current_location loc ON loc.rider_id = o.rider_id
        WHERE o.id = $1
      ) AS live
    `,
    [orderId]
  )

  // Step 3 — the breadcrumb trail, oldest point first so the Polyline is
  // drawn in the order the rider drove it. The inner query keeps only the
  // NEWEST 200 points (so a long ride cannot send an unbounded list); the
  // outer query flips them back into time order.
  const trailResult = await database.query(
    `
      SELECT latest.latitude, latest.longitude
      FROM (
        SELECT log_id, recorded_at, latitude::float8 AS latitude, longitude::float8 AS longitude
        FROM delivery_location_log
        WHERE order_id = $1
        ORDER BY recorded_at DESC, log_id DESC
        LIMIT 200
      ) AS latest
      ORDER BY latest.recorded_at, latest.log_id
    `,
    [orderId]
  )

  return {
    tracking_active: true,
    ...trackingResult.rows[0],
    trail: trailResult.rows
  }
}

// The planned ROAD route from the order's branch to its drop-off pin.
// Called once when a tracking map opens (not on every 5-second poll).
//
//   cache hit  -> read the stored route from order_routes, no outside call
//   cache miss -> ask OSRM, store the answer, return it
//   OSRM down  -> straight-line fallback, NOT stored, so the next call retries
const getOrderRoute = async (orderIdValue, actor, database = pool) => {
  const orderId = toPositiveInteger(orderIdValue, 'order id')

  // Same 404 / 403 rule as the tracking endpoint.
  const order = await loadOrderForViewer(database, orderId, actor)

  if (order.restaurant_latitude === null || order.delivery_latitude === null) {
    return { routed: false, reason: 'missing_coordinates' }
  }

  // Cache hit? ::float8 so the numbers reach the browser as JSON numbers.
  const cached = await database.query(
    `
      SELECT geometry, distance_m::float8 AS distance_m, duration_s::float8 AS duration_s
      FROM order_routes
      WHERE order_id = $1
    `,
    [orderId]
  )

  if (cached.rows.length > 0) {
    return { routed: true, cached: true, ...cached.rows[0] }
  }

  // Cache miss: ask the routing engine. The HTTP call happens BEFORE the
  // transaction opens, so no database connection is held while we wait
  // up to 5 seconds for an outside server.
  const route = await getRoadRoute(
    order.restaurant_latitude, order.restaurant_longitude,
    order.delivery_latitude, order.delivery_longitude
  )

  if (!route) {
    return {
      routed: false,
      reason: 'routing_unavailable',
      geometry: [
        [order.restaurant_latitude, order.restaurant_longitude],
        [order.delivery_latitude, order.delivery_longitude]
      ]
    }
  }

  const client = await database.connect()

  try {
    await client.query('BEGIN')

    // Two viewers can miss the cache at the same moment and both reach
    // here. ON CONFLICT (order_id) DO NOTHING makes the second INSERT a
    // harmless no-op instead of a primary-key error.
    // JSON.stringify: pg would otherwise send a JS array as a PostgreSQL
    // ARRAY, not as JSON.
    await client.query(
      `
        INSERT INTO order_routes (order_id, geometry, distance_m, duration_s, source)
        VALUES ($1, $2::jsonb, ROUND($3::numeric, 1), ROUND($4::numeric, 1), 'osrm')
        ON CONFLICT (order_id) DO NOTHING
      `,
      [orderId, JSON.stringify(route.geometry), route.distance_m, route.duration_s]
    )

    // Read back whichever row won, ours or the other viewer's, so every
    // caller gets the one stored route.
    const stored = await client.query(
      `
        SELECT geometry, distance_m::float8 AS distance_m, duration_s::float8 AS duration_s
        FROM order_routes
        WHERE order_id = $1
      `,
      [orderId]
    )

    await client.query('COMMIT')

    return { routed: true, cached: false, ...stored.rows[0] }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

module.exports = {
  ORDER_STATUSES,
  OrderServiceError,
  getOrderRoute,
  getOrderTracking,
  placeOrder,
  listCustomerOrders,
  listRestaurantOrders,
  getOrderDetails,
  updateOrderStatus
}

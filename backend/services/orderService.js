const pool = require('../db/pool')

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

// all the exceptions that can be thrown by the place_order function in the database 
// are mapped to a more user-friendly error message and status code here. 
// This allows the application to provide more meaningful feedback to the user when an error occurs during the checkout process.
const CHECKOUT_ERROR_MAP = {
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
        o.total_amount,
        o.review_eligible,
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

  const [itemsResult, paymentResult, deliveryResult] = await Promise.all([
    db.query(
      `
        SELECT
          oi.id,
          oi.menu_item_id,
          mi.name,
          oi.quantity,
          oi.unit_price,
          ROUND(oi.quantity * oi.unit_price, 2) AS line_total,
          oi.special_instruction
        FROM order_items oi
        LEFT JOIN menu_items mi
          ON mi.id = oi.menu_item_id
        WHERE oi.order_id = $1
        ORDER BY oi.id
      `,
      [orderId]
    ),
    db.query(
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
    db.query(
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
    )
  ])

  const row = orderResult.rows[0]

  return {
    id: row.id,
    status: row.status,
    delivery_address: row.delivery_address,
    subtotal: row.subtotal,
    discount_amount: row.discount_amount,
    total_amount: row.total_amount,
    review_eligible: row.review_eligible,
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
            'name', mi.name,
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

  if (!['confirmed', 'preparing', 'cancelled'].includes(newStatus)) {
    throw new OrderServiceError(
      400,
      'VALIDATION_ERROR',
      'Restaurant owners can set status to confirmed, preparing, or cancelled.'
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

    if (actor.role !== 'admin' && currentOrder.owner_id !== actor.id) {
      throw new OrderServiceError(
        403,
        'ACCESS_DENIED',
        'You can only manage orders from your own restaurant.'
      )
    }

    const permittedStatuses = OWNER_STATUS_TRANSITIONS[currentOrder.status] || []

    if (!permittedStatuses.includes(newStatus)) {
      throw new OrderServiceError(
        409,
        'INVALID_STATUS_TRANSITION',
        `Order status cannot change from ${currentOrder.status} to ${newStatus}.`
      )
    }

    await client.query(
      `
        UPDATE orders
        SET status = $1
        WHERE id = $2
      `,
      [newStatus, orderId]
    )

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

module.exports = {
  ORDER_STATUSES,
  OrderServiceError,
  placeOrder,
  listCustomerOrders,
  listRestaurantOrders,
  getOrderDetails,
  updateOrderStatus
}

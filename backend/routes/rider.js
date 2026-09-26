const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId, parseCoordinates } = require('../utils/validation')
const router = express.Router()
router.use(authenticateToken, requireRole('rider'))

// The rider chooses availability; busy is controlled by delivery transactions.
router.get('/profile', async (req, res) => {
  const result = await pool.query('SELECT user_id,vehicle_type,status FROM rider_profiles WHERE user_id=$1', [req.user.id])
  res.json({ profile: result.rows[0] || null })
})
router.patch('/profile', async (req, res) => {
  const { status, vehicle_type } = req.body
  if ((status !== undefined && !['online','offline'].includes(status)) ||
      (vehicle_type !== undefined && !['bicycle','motorcycle','car'].includes(vehicle_type)) ||
      (status === undefined && vehicle_type === undefined)) {
    return res.status(400).json({ error: 'Choose online/offline and a valid vehicle.' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(`UPDATE rider_profiles SET status=COALESCE($1,status),
      vehicle_type=COALESCE($2,vehicle_type) WHERE user_id=$3 AND status<>'busy' RETURNING *`,
    [status || null, vehicle_type || null, req.user.id])
    if (!result.rowCount) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Complete your current delivery before changing availability.' })
    }
    await client.query('COMMIT')
    res.json({ profile: result.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

// Available jobs show pickup details; customer address is only disclosed after acceptance.
router.get('/deliveries/available', async (req, res) => {
  const result = await pool.query(`SELECT o.id AS order_id,o.total_amount,o.delivery_fee,o.created_at,
      r.name AS restaurant_name,rb.address AS branch_address,rb.area AS branch_area,
      rb.city AS branch_city,rb.division,rb.phone AS branch_phone
    FROM orders o JOIN restaurant_branches rb ON rb.id=o.branch_id
    JOIN restaurants r ON r.id=rb.restaurant_id JOIN payments p ON p.order_id=o.id
    WHERE o.status='preparing' AND (p.method='cash_on_delivery' OR p.status='paid')
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id=o.id)
      AND ($1::text='' OR rb.division=$1)
    ORDER BY o.created_at LIMIT 100`, [typeof req.query.division === 'string' ? req.query.division : ''])
  res.json({ deliveries: result.rows })
})
router.get('/deliveries/mine', async (req, res) => {
  const result = await pool.query(`SELECT d.id AS delivery_id,d.delivery_status,d.delivery_time,
      o.id AS order_id,o.status AS order_status,o.delivery_address,o.total_amount,o.delivery_fee,
      r.name AS restaurant_name,rb.address AS branch_address,rb.area AS branch_area,rb.city AS branch_city,
      rb.phone AS branch_phone,u.name AS customer_name,u.phone AS customer_phone,p.method AS payment_method,
      rb.latitude::float8 AS branch_latitude,rb.longitude::float8 AS branch_longitude,
      o.delivery_latitude::float8 AS delivery_latitude,o.delivery_longitude::float8 AS delivery_longitude
    FROM deliveries d JOIN orders o ON o.id=d.order_id
    JOIN restaurant_branches rb ON rb.id=o.branch_id JOIN restaurants r ON r.id=rb.restaurant_id
    JOIN users u ON u.id=o.customer_id JOIN payments p ON p.order_id=o.id
    WHERE d.rider_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id])
  res.json({ deliveries: result.rows })
})

// PUT /api/rider/location   body: { latitude, longitude, accuracy_m? }
// Rider only (router.use above). The rider id is ALWAYS req.user.id from the
// verified token — never from the body — so a rider can only move themselves.
// PUT because the call replaces "where I am now" and repeating it is harmless.
router.put('/location', async (req, res) => {
  const point = parseCoordinates(req.body.latitude, req.body.longitude)
  if (point.error) return res.status(400).json({ error: point.error })

  let accuracy = null
  if (req.body.accuracy_m !== undefined && req.body.accuracy_m !== null) {
    accuracy = Number(req.body.accuracy_m)
    // 999999.99 is the largest value NUMERIC(8,2) can hold.
    if (typeof req.body.accuracy_m === 'boolean' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 999999.99) {
      return res.status(400).json({ error: 'accuracy_m must be a non-negative number of metres.' })
    }
  }

  const client = await pool.connect()
  try {
    // Explicit transaction even though this is one statement: the upsert
    // fires trg_log_rider_location, which writes delivery_location_log.
    // Both tables must commit or roll back together.
    await client.query('BEGIN')
    // Upsert: the first position INSERTs the rider's row; every later one
    // hits the PRIMARY KEY conflict and UPDATEs that same row instead.
    // EXCLUDED is the row we tried to insert.
    await client.query(`INSERT INTO rider_current_location (rider_id, latitude, longitude, accuracy_m, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (rider_id) DO UPDATE
      SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          accuracy_m = EXCLUDED.accuracy_m, updated_at = now()`,
    [req.user.id, point.latitude, point.longitude, accuracy])
    await client.query('COMMIT')
    res.status(204).end()
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

router.post('/deliveries/:orderId/accept', async (req, res) => {
  const orderId = parseId(req.params.orderId)
  if (!orderId) return res.status(400).json({ error: 'Invalid order ID.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize both competing riders and one rider claiming two jobs at once.
    const profile = await client.query('SELECT status FROM rider_profiles WHERE user_id=$1 FOR UPDATE', [req.user.id])
    if (profile.rows[0]?.status !== 'online') {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Go online and complete any current delivery first.', code: 'RIDER_OFFLINE_OR_BUSY' })
    }
    const order = await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId])
    if (!order.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Order not found.' })
    }
    const current = await client.query(`SELECT id FROM deliveries WHERE order_id=$1
      OR (rider_id=$2 AND delivery_status<>'delivered')`, [orderId, req.user.id])
    const payment = await client.query('SELECT method,status FROM payments WHERE order_id=$1 FOR UPDATE', [orderId])
    if (order.rows[0].status !== 'preparing' || current.rowCount || !payment.rowCount ||
      (payment.rows[0].method !== 'cash_on_delivery' && payment.rows[0].status !== 'paid')) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'This order cannot be claimed or you already have an active delivery.' })
    }
    const result = await client.query(`INSERT INTO deliveries(order_id,rider_id,delivery_status)
      VALUES ($1,$2,'assigned') RETURNING *`, [orderId, req.user.id])
    await client.query('UPDATE orders SET rider_id=$1 WHERE id=$2', [req.user.id, orderId])
    await client.query("UPDATE rider_profiles SET status='busy' WHERE user_id=$1", [req.user.id])
    await client.query("INSERT INTO order_events(order_id,status,note) VALUES ($1,'preparing','Rider assigned; waiting for pickup')", [orderId])
    await client.query('COMMIT')
    res.status(201).json({ delivery: result.rows[0], message: 'Delivery accepted.' })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
})

router.patch('/deliveries/:orderId/status', async (req, res) => {
  const orderId = parseId(req.params.orderId)
  const { status } = req.body
  if (!orderId || !['picked_up','delivered'].includes(status)) return res.status(400).json({ error: 'Use a valid order ID and picked_up or delivered status.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT user_id FROM rider_profiles WHERE user_id=$1 FOR UPDATE', [req.user.id])
    const order = await client.query('SELECT status FROM orders WHERE id=$1 FOR UPDATE', [orderId])
    const found = await client.query('SELECT * FROM deliveries WHERE order_id=$1 FOR UPDATE', [orderId])
    const delivery = found.rows[0]
    if (!delivery || delivery.rider_id !== req.user.id) {
      await client.query('ROLLBACK')
      return res.status(delivery ? 403 : 404).json({ error: 'Delivery not found or not assigned to you.' })
    }
    const valid = status === 'picked_up' ? delivery.delivery_status === 'assigned' && order.rows[0]?.status === 'preparing'
      : delivery.delivery_status === 'picked_up' && order.rows[0]?.status === 'out_for_delivery'
    if (!valid) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Delivery must progress from assigned to picked_up to delivered.' })
    }
    if (status === 'delivered') {
      await client.query('CALL complete_delivery($1,$2)', [orderId, req.user.id])
    } else {
      await client.query("UPDATE deliveries SET delivery_status='picked_up' WHERE order_id=$1", [orderId])
      await client.query("UPDATE orders SET status='out_for_delivery' WHERE id=$1", [orderId])
    }
    await client.query('COMMIT')
    res.json({ message: `Delivery marked as ${status}.` })
  } catch (error) {
    await client.query('ROLLBACK')
    if (['PAYMENT_NOT_VERIFIED','INVALID_DELIVERY_TRANSITION','DELIVERY_NOT_ASSIGNED'].includes(error.message)) {
      return res.status(409).json({ error: error.message.replaceAll('_',' ').toLowerCase(), code: error.message })
    }
    throw error
  } finally { client.release() }
})
module.exports = router

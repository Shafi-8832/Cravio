// Regression checks for the map + live rider tracking feature: input
// validation, role and ownership checks, the logging trigger and the SQL maths.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const pool = require('../db/pool')
const base = process.env.TEST_BASE_URL
let passed = 0
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); passed++; console.log('PASS ' + name) }
async function call(method, route, token, body) {
  const response = await fetch(base + '/api' + route, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}
async function login(email, password = 'password123') {
  const response = await call('POST', '/auth/login', null, { email, password })
  assert.ok(response.body.token, JSON.stringify(response.body))
  return response.body.token
}
async function main() {
  if (!base || !/_(test|review)$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Use npm run test:backend with a separate database.')
  const nonce = Date.now()
  const adminPassword = crypto.randomBytes(18).toString('hex')
  await pool.query('INSERT INTO users(name,email,password,role) VALUES ($1,$2,$3,$4)',
    ['Tracking admin', `track-admin-${nonce}@example.com`, await bcrypt.hash(adminPassword, 10), 'admin'])
  const admin = await login(`track-admin-${nonce}@example.com`, adminPassword)
  const customer = await login('ayesha@example.com')
  const other = await login('tanvir@example.com')
  const owner = await login('nabila@example.com')
  const otherOwner = await login('rafiq@example.com')
  const rider = await login('jahangir@example.com')

  // SQL function: Dhanmondi -> Gulshan is about 6 km; NULL in, NULL out.
  const maths = await pool.query('SELECT distance_km(23.7465,90.3760,23.7925,90.4078)::float8 AS d, distance_km(NULL,1,2,3) AS n')
  check('distance_km is about 6 km across Dhaka', Math.round(maths.rows[0].d), 6)
  check('distance_km returns NULL for NULL input', maths.rows[0].n, null)

  // Rider location: authentication, role, validation.
  const dhanmondi = { latitude: 23.7465, longitude: 90.3760 }
  check('rider location needs a session (401)', (await call('PUT', '/rider/location', null, dhanmondi)).status, 401)
  check('customer cannot send rider location (403)', (await call('PUT', '/rider/location', customer, dhanmondi)).status, 403)
  check('latitude 999 rejected (400)', (await call('PUT', '/rider/location', rider, { latitude: 999, longitude: 90 })).status, 400)
  check('latitude "abc" rejected (400)', (await call('PUT', '/rider/location', rider, { latitude: 'abc', longitude: 90 })).status, 400)
  check('negative accuracy rejected (400)', (await call('PUT', '/rider/location', rider, { ...dhanmondi, accuracy_m: -1 })).status, 400)
  check('idle rider location saved (204)', (await call('PUT', '/rider/location', rider, { ...dhanmondi, accuracy_m: 12 })).status, 204)

  // A fresh restaurant + branch owned by the seeded owner.
  const restaurant = await call('POST', '/restaurants', owner, { name: 'Tracking kitchen ' + nonce })
  const rid = restaurant.body.restaurant.id
  const branch = (await call('POST', '/restaurants/' + rid + '/branches', owner, { address: 'Road 27', area: 'Dhanmondi', city: 'Dhaka', division: 'Dhaka' })).body.branch
  check('owner sets own branch pin (200)', (await call('PATCH', `/restaurants/branches/${branch.id}/location`, owner, dhanmondi)).status, 200)
  check('other owner cannot move this pin (403)', (await call('PATCH', `/restaurants/branches/${branch.id}/location`, otherOwner, dhanmondi)).status, 403)
  check('customer cannot move a pin (403)', (await call('PATCH', `/restaurants/branches/${branch.id}/location`, customer, dhanmondi)).status, 403)
  check('missing branch is 404', (await call('PATCH', '/restaurants/branches/99999999/location', admin, dhanmondi)).status, 404)
  check('admin may move any pin (200)', (await call('PATCH', `/restaurants/branches/${branch.id}/location`, admin, dhanmondi)).status, 200)

  // Nearby: sorted by distance, radius validated.
  const nearby = await call('GET', '/restaurants/nearby?lat=23.7470&lng=90.3765&radius_km=2', customer)
  check('nearby finds the new branch', nearby.body.branches.some(b => b.branch_id === branch.id), true)
  const distances = nearby.body.branches.map(b => b.distance_km)
  check('nearby sorted closest first', distances, [...distances].sort((a, b) => a - b))
  check('nearby radius above 25 rejected', (await call('GET', '/restaurants/nearby?lat=23.7&lng=90.4&radius_km=30', customer)).status, 400)
  check('nearby needs a session', (await call('GET', '/restaurants/nearby?lat=23.7&lng=90.4')).status, 401)

  // Order with a delivery pin in Gulshan.
  const category = await call('POST', '/menu/restaurants/' + rid + '/categories', owner, { name: 'Mains' })
  const dish = await call('POST', '/menu/categories/' + category.body.category.id + '/items', owner, { name: 'Tracking biryani', price: 250 })
  await call('POST', '/cart/' + rid + '/items', customer, { menu_item_id: dish.body.item.id, quantity: 1 })
  const orderBody = { branch_id: branch.id, delivery_address: 'House 1, Gulshan Avenue', payment_method: 'cash_on_delivery' }
  check('half a delivery pin rejected', (await call('POST', '/orders', customer, { ...orderBody, delivery_latitude: 23.79 })).status, 400)
  const placed = await call('POST', '/orders', customer, { ...orderBody, delivery_latitude: 23.7925, delivery_longitude: 90.4078 })
  check('order with pin placed', placed.status, 201)
  const orderId = placed.body.order.id
  const stored = await pool.query('SELECT delivery_latitude::float8 AS lat FROM orders WHERE id=$1', [orderId])
  check('delivery pin snapshot stored', stored.rows[0].lat, 23.7925)

  // Planned road route: same access rule as /tracking, cached once per order.
  check('route needs a session (401)', (await call('GET', `/orders/${orderId}/route`)).status, 401)
  check('stranger customer cannot see route (403)', (await call('GET', `/orders/${orderId}/route`, other)).status, 403)
  check('route of missing order is 404', (await call('GET', '/orders/99999999/route', customer)).status, 404)
  const firstRoute = (await call('GET', `/orders/${orderId}/route`, customer)).body.route
  const cachedRows = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM order_routes WHERE order_id=$1', [orderId])).rows[0].n
  if (firstRoute.routed) {
    // Needs internet access to the OSRM demo server.
    check('first route request is a cache miss', firstRoute.cached, false)
    check('route follows roads (many points)', firstRoute.geometry.length > 2, true)
    check('route is [lat, lng] inside Dhaka, not flipped', firstRoute.geometry.every(([lat, lng]) => lat > 23.6 && lat < 24 && lng > 90.2 && lng < 90.6), true)
    const again = (await call('GET', `/orders/${orderId}/route`, owner)).body.route
    check('second route request is a cache hit', again.cached, true)
    check('cached route is identical', again.geometry, firstRoute.geometry)
    check('exactly one cached route row', await cachedRows(), 1)
  } else {
    console.log('NOTE OSRM unreachable; checking the fallback instead')
    check('fallback is a straight line', firstRoute.geometry.length, 2)
    check('fallback is not cached', await cachedRows(), 0)
  }
  await call('POST', '/cart/' + rid + '/items', customer, { menu_item_id: dish.body.item.id, quantity: 1 })
  const noPin = await call('POST', '/orders', customer, orderBody)
  check('order without a pin has no route', (await call('GET', `/orders/${noPin.body.order.id}/route`, customer)).body.route, { routed: false, reason: 'missing_coordinates' })

  // Tracking access before pickup.
  check('stranger customer cannot track (403)', (await call('GET', `/orders/${orderId}/tracking`, other)).status, 403)
  check('other owner cannot track (403)', (await call('GET', `/orders/${orderId}/tracking`, otherOwner)).status, 403)
  check('missing order is 404', (await call('GET', '/orders/99999999/tracking', customer)).status, 404)
  check('pending order not trackable yet', (await call('GET', `/orders/${orderId}/tracking`, customer)).body.tracking.tracking_active, false)

  await call('PATCH', '/orders/' + orderId + '/status', owner, { status: 'confirmed' })
  await call('PATCH', '/orders/' + orderId + '/status', owner, { status: 'preparing' })
  await call('PATCH', '/rider/profile', rider, { status: 'online' })
  check('rider accepts', (await call('POST', `/rider/deliveries/${orderId}/accept`, rider)).status, 201)
  // Moving before pickup is not part of the customer's trail.
  await call('PUT', '/rider/location', rider, dhanmondi)
  check('pickup succeeds', (await call('PATCH', `/rider/deliveries/${orderId}/status`, rider, { status: 'picked_up' })).status, 200)
  check('no trail before pickup', (await pool.query('SELECT COUNT(*)::int AS n FROM delivery_location_log WHERE order_id=$1', [orderId])).rows[0].n, 0)

  // Two positions on the road -> the trigger writes two trail rows.
  await call('PUT', '/rider/location', rider, { latitude: 23.7600, longitude: 90.3900 })
  await call('PUT', '/rider/location', rider, { latitude: 23.7800, longitude: 90.4000 })
  const live = (await call('GET', `/orders/${orderId}/tracking`, customer)).body.tracking
  check('tracking active while out for delivery', live.tracking_active, true)
  check('trigger logged both positions', live.trail.length, 2)
  check('trail in time order', live.trail.map(p => p.latitude), [23.76, 23.78])
  check('rider position returned', [live.rider_latitude, live.rider_longitude], [23.78, 90.4])
  check('distance computed in SQL', live.distance_remaining_km > 0.5 && live.distance_remaining_km < 3, true)
  check('ETA at 20 km/h rounded up', live.eta_minutes, Math.ceil(live.distance_remaining_km / 20 * 60))
  check('fresh signal is not stale', live.is_stale, false)
  check('assigned rider may track', (await call('GET', `/orders/${orderId}/tracking`, rider)).status, 200)
  check('restaurant owner may track', (await call('GET', `/orders/${orderId}/tracking`, owner)).status, 200)

  // Stale signal: age the rider's last fix by two minutes.
  await pool.query("UPDATE rider_current_location SET updated_at = now() - interval '2 minutes' WHERE rider_id = (SELECT rider_id FROM orders WHERE id=$1)", [orderId])
  check('old signal is stale', (await call('GET', `/orders/${orderId}/tracking`, customer)).body.tracking.is_stale, true)

  // Admin live board.
  check('customer cannot open live board (403)', (await call('GET', '/admin/deliveries/live', customer)).status, 403)
  check('rider cannot open live board (403)', (await call('GET', '/admin/deliveries/live', rider)).status, 403)
  const board = await call('GET', '/admin/deliveries/live', admin)
  check('admin sees the delivery', board.body.deliveries.some(d => d.order_id === orderId), true)
  check('summary counts the stale rider', board.body.stale_riders >= 1, true)
  check('summary count matches list', board.body.active_deliveries, board.body.deliveries.length)

  // After delivery: no live location is revealed.
  check('delivery completes', (await call('PATCH', `/rider/deliveries/${orderId}/status`, rider, { status: 'delivered' })).status, 200)
  const done = (await call('GET', `/orders/${orderId}/tracking`, customer)).body.tracking
  check('delivered order stops tracking', done, { tracking_active: false, status: 'delivered' })
  await call('PUT', '/rider/location', rider, dhanmondi)
  check('no logging after delivery', (await pool.query('SELECT COUNT(*)::int AS n FROM delivery_location_log WHERE order_id=$1', [orderId])).rows[0].n, 2)

  console.log('Tracking: ' + passed + ' assertions passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())

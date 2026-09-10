// Regression checks for authorization, catalog coverage and competing requests.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
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
async function main() {
  if (!base || !/_(test|review)$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Use npm run test:backend with a separate database.')
  const nonce = Date.now()
  const customerResult = await call('POST', '/auth/signup', null, { name: 'Marketplace test', email: 'market-' + nonce + '@example.com', password: 'testPassword123', role: 'customer', phone: '01700000123' })
  check('customer signup', customerResult.status, 201)
  const customer = customerResult.body.token
  const customerId = customerResult.body.user.id
  const login = async email => {
    const response = await call('POST', '/auth/login', null, { email, password: 'password123' })
    assert.ok(response.body.token, JSON.stringify(response.body)); return response.body.token
  }
  const other = await login('tanvir@example.com')
  const owner = await login('nabila@example.com')
  const rider1 = await login('jahangir@example.com')
  const rider2 = await login('shuvo@example.com')
  const list = await call('GET', '/restaurants')
  check('all eight demo divisions exist', new Set(list.body.restaurants.filter(r => r.catalog_slug?.startsWith('demo-')).flatMap(r => r.branches.map(b => b.division))).size, 8)
  const invalid = await call('GET', '/restaurants?page=-1')
  check('invalid catalog pagination rejected', invalid.status, 400)
  const favoritesRestaurant = list.body.restaurants.find(r => r.catalog_slug === 'demo-dhaka-dum-house')
  check('restaurant photo is local media', favoritesRestaurant.image_url.startsWith('/media/'), true)
  const photoResponse = await fetch(base + favoritesRestaurant.image_url)
  check('photograph served', photoResponse.status, 200)
  check('photo is actual jpeg', photoResponse.headers.get('content-type').includes('image/jpeg'), true)
  const address = { label: 'Home', full_address: 'Test house, road 3', area: 'Dhanmondi', city: 'Dhaka', division: 'Dhaka', phone: '01700000123', is_default: true }
  const addressResults = await Promise.all([call('POST', '/account/addresses', customer, address), call('POST', '/account/addresses', customer, { ...address, label: 'Work' })])
  check('parallel addresses both saved', addressResults.map(r => r.status), [201, 201])
  const addresses = await call('GET', '/account/addresses', customer)
  check('only one default after concurrent writes', addresses.body.addresses.filter(a => a.is_default).length, 1)
  check('foreign address edit blocked', (await call('PATCH', '/account/addresses/' + addressResults[0].body.address.id, other, address)).status, 404)
  check('invalid coordinate pair rejected', (await call('POST', '/account/addresses', customer, { ...address, latitude: 23 })).status, 400)
  check('save favourite', (await call('PUT', '/account/favorites/' + favoritesRestaurant.id, customer)).status, 200)
  check('favourite write is idempotent', (await call('PUT', '/account/favorites/' + favoritesRestaurant.id, customer)).status, 200)
  check('one favourite returned', (await call('GET', '/account/favorites', customer)).body.restaurants.length, 1)
  check('customer cannot modify restaurant', (await call('PATCH', '/restaurants/' + favoritesRestaurant.id, customer, { name: 'Stolen' })).status, 403)
  check('database role overrides JWT role', (await call('GET', '/admin/users', jwt.sign({ id: customerId, role: 'admin', jti: 'role-check-' + nonce }, process.env.JWT_SECRET, { expiresIn: '1h' }))).status, 403)
  check('expired JWT returns 401', (await call('GET', '/account/profile', jwt.sign({ id: customerId, jti: 'expired-' + nonce, exp: 1 }, process.env.JWT_SECRET))).status, 401)
  const created = await call('POST', '/restaurants', owner, { name: 'Concurrency kitchen ' + nonce })
  check('owner creates restaurant', created.status, 201)
  const rid = created.body.restaurant.id
  const branchResponse = await call('POST', '/restaurants/' + rid + '/branches', owner, { address: 'Test pickup', area: 'Dhanmondi', city: 'Dhaka', division: 'Dhaka', delivery_fee: 65, min_order_amount: 100, eta_min: 20, eta_max: 35 })
  check('owner creates division branch', branchResponse.status, 201)
  const branch = branchResponse.body.branch
  const category = await call('POST', '/menu/restaurants/' + rid + '/categories', owner, { name: 'Mains' })
  check('owner creates category', category.status, 201)
  const dish = await call('POST', '/menu/categories/' + category.body.category.id + '/items', owner, { name: 'Test biryani', price: 250, image_url: '/media/biryani.jpg' })
  check('owner creates photographed dish', dish.status, 201)
  const itemId = dish.body.item.id
  const adds = await Promise.all([1, 2].map(() => call('POST', '/cart/' + rid + '/items', customer, { menu_item_id: itemId, quantity: 1 })))
  check('simultaneous cart additions succeed', adds.map(r => r.status), [201, 201])
  const cart = (await call('GET', '/cart/' + rid, customer)).body.cart
  check('identical concurrent additions merge', cart.length, 1)
  check('both additions counted', cart[0].quantity, 2)
  const placements = await Promise.all([1, 2].map(() => call('POST', '/orders', customer, { branch_id: branch.id, delivery_address: 'Test address with phone 01700000123', payment_method: 'cash_on_delivery' })))
  check('only one concurrent checkout commits', placements.map(r => r.status).sort(), [201, 409])
  const order = placements.find(r => r.status === 201).body.order
  check('server includes branch fee', Number(order.total_amount), 565)
  await call('PATCH', '/menu/items/' + itemId, owner, { name: 'Renamed dish', price: 999 })
  const receipt = await call('GET', '/orders/' + order.id, customer)
  check('order preserves dish name snapshot', receipt.body.order.items[0].name, 'Test biryani')
  check('order preserves price snapshot', Number(receipt.body.order.items[0].unit_price), 250)
  check('foreign customer cannot view receipt', (await call('GET', '/orders/' + order.id, other)).status, 404)
  await call('PATCH', '/orders/' + order.id + '/status', owner, { status: 'confirmed' })
  await call('PATCH', '/orders/' + order.id + '/status', owner, { status: 'preparing' })
  await call('PATCH', '/rider/profile', rider1, { status: 'online' })
  await call('PATCH', '/rider/profile', rider2, { status: 'online' })
  const available = await call('GET', '/rider/deliveries/available', rider1)
  check('unassigned jobs do not leak customer address', 'delivery_address' in available.body.deliveries.find(d => d.order_id === order.id), false)
  const claims = await Promise.all([rider1, rider2].map(token => call('POST', '/rider/deliveries/' + order.id + '/accept', token)))
  check('only one rider claims order', claims.map(r => r.status).sort(), [201, 409])
  const winner = claims[0].status === 201 ? rider1 : rider2
  const loser = winner === rider1 ? rider2 : rider1
  check('busy rider cannot go offline', (await call('PATCH', '/rider/profile', winner, { status: 'offline' })).status, 409)
  check('foreign rider cannot deliver order', (await call('PATCH', '/rider/deliveries/' + order.id + '/status', loser, { status: 'picked_up' })).status, 403)
  check('cannot skip pickup', (await call('PATCH', '/rider/deliveries/' + order.id + '/status', winner, { status: 'delivered' })).status, 409)
  check('pickup succeeds', (await call('PATCH', '/rider/deliveries/' + order.id + '/status', winner, { status: 'picked_up' })).status, 200)
  check('delivery procedure succeeds', (await call('PATCH', '/rider/deliveries/' + order.id + '/status', winner, { status: 'delivered' })).status, 200)
  const delivered = (await call('GET', '/orders/' + order.id, customer)).body.order
  check('COD atomically settled', delivered.payment.status, 'paid')
  check('timeline covers lifecycle', delivered.timeline.map(e => e.status).includes('delivered'), true)
  check('rider automatically available', (await call('GET', '/rider/profile', winner)).body.profile.status, 'online')
  check('logout revoked on server', (await call('POST', '/auth/logout', customer)).status, 200)
  check('logged-out JWT cannot be reused', (await call('GET', '/account/profile', customer)).status, 401)
  console.log('Marketplace: ' + passed + ' assertions passed.')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())

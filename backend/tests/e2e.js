// ============================================================
// END-TO-END API SUITE
//
//   1. npm run dev          (in another terminal)
//   2. npm run seed         (once, if you haven't)
//   3. npm test
//
// Drives the real server over HTTP against the seeded database — no mocks.
// It only ever adds data, except for the small reset below.
//
// Requires the seeded accounts from scripts/seed.js.
// ============================================================

require('dotenv').config({ quiet: true })
if (!/_(test|review)$/.test(new URL(process.env.DATABASE_URL).pathname.slice(1))) throw new Error('Tests require a separate database ending _test or _review')
const pool = require('../db/pool')

const B = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 8000}`
let pass = 0, fail = 0

// The quality-flag test asserts that an item is flagged on the THIRD distinct
// way_less report, which means it has to start from zero reports. Everything
// else in this suite is additive and safe to re-run, so this clears just that
// one item's own artifacts — no users, restaurants, menus or orders.
const resetQualityFlagFixture = async () => {
  await pool.query(`
    DELETE FROM quality_flag_log
    WHERE menu_item_id IN (
      SELECT mi.id
      FROM menu_items mi
      JOIN restaurants r ON r.id = mi.restaurant_id
      WHERE r.name = 'Pizza Republic'
        AND mi.name = 'Pepperoni Classic'
    )
  `)

  await pool.query(`
    UPDATE menu_items mi
    SET quality_flag = false
    FROM restaurants r
    WHERE r.id = mi.restaurant_id
      AND r.name = 'Pizza Republic'
      AND mi.name = 'Pepperoni Classic'
  `)
}

const call = async (m, p, tok, body) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}

const login = async (email) => {
  const r = await call('POST', '/api/auth/login', null, { email, password: 'password123' })
  if (!r.body?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`)
  return r.body.token
}

const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  <- ' + detail : ''}`) }
}

const section = (t) => console.log(`\n=== ${t} ===`)

;(async () => {
  // Fail with a clear message rather than a connection stack trace.
  try {
    await fetch(B)
  } catch {
    console.error(`\nNo server responding at ${B}. Start it with: npm run dev\n`)
    process.exit(1)
  }

  await resetQualityFlagFixture()

  const cust = await login('ayesha@example.com')
  const cust2 = await login('tanvir@example.com')
  const ownerPizza = await login('rafiq@example.com')
  const rider = await login('jahangir@example.com')

  // ---------------------------------------------------------
  section('menu exposes modifiers')
  const list = await call('GET', '/api/restaurants')
  const pizza = list.body.restaurants.find(r => r.name === 'Pizza Republic')
  check('restaurant list carries average_rating field', 'average_rating' in pizza)

  const menu = await call('GET', `/api/menu/restaurants/${pizza.id}`)
  const allItems = menu.body.categories.flatMap(c => c.items)
  const margherita = allItems.find(i => i.name === 'Margherita')
  check('Margherita has modifier_groups', Array.isArray(margherita.modifier_groups) && margherita.modifier_groups.length === 2)

  const sizeGroup = margherita.modifier_groups.find(g => g.name === 'Size')
  const toppings = margherita.modifier_groups.find(g => g.name === 'Extra toppings')
  check('Size group is required with max 1', sizeGroup.is_required === true && sizeGroup.max_selection === 1)
  check('Size group has 3 options', sizeGroup.options.length === 3)

  const large = sizeGroup.options.find(o => o.name === 'Large (12")')
  const regular = sizeGroup.options.find(o => o.name === 'Regular (9")')
  const extraCheese = toppings.options.find(o => o.name === 'Extra cheese')
  const mushrooms = toppings.options.find(o => o.name === 'Mushrooms')

  // ---------------------------------------------------------
  section('modifier validation on cart add')
  const addUrl = `/api/cart/${pizza.id}/items`

  const noSize = await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1 })
  check('required group omitted -> 400 MODIFIER_MIN_NOT_MET', noSize.status === 400 && noSize.body.code === 'MODIFIER_MIN_NOT_MET', JSON.stringify(noSize.body))

  const twoSizes = await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1, modifier_option_ids: [large.id, regular.id] })
  check('two sizes -> 400 MODIFIER_MAX_EXCEEDED', twoSizes.status === 400 && twoSizes.body.code === 'MODIFIER_MAX_EXCEEDED', JSON.stringify(twoSizes.body))

  // an option from a different restaurant's dish
  const burgerMenu = await call('GET', `/api/menu/restaurants/${list.body.restaurants.find(r => r.name === 'The Burger Yard').id}`)
  const yardClassic = burgerMenu.body.categories.flatMap(c => c.items).find(i => i.name === 'Yard Classic')
  const foreignOption = yardClassic.modifier_groups[0].options[0]
  const foreign = await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1, modifier_option_ids: [large.id, foreignOption.id] })
  check('foreign modifier -> 400 MODIFIER_ITEM_MISMATCH', foreign.status === 400 && foreign.body.code === 'MODIFIER_ITEM_MISMATCH', JSON.stringify(foreign.body))

  const badShape = await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1, modifier_option_ids: 'nope' })
  check('non-array modifier_option_ids -> 400', badShape.status === 400)

  // unavailable option (Chuli Kitchen kacchi "Jali kabab")
  const chuli = list.body.restaurants.find(r => r.name === 'Chuli Kitchen')
  const chuliMenu = await call('GET', `/api/menu/restaurants/${chuli.id}`)
  const kacchi = chuliMenu.body.categories.flatMap(c => c.items).find(i => i.name === 'Kacchi Biryani')
  const portionFull = kacchi.modifier_groups.find(g => g.name === 'Portion').options.find(o => o.name === 'Full')
  const jali = kacchi.modifier_groups.find(g => g.name === 'Sides').options.find(o => o.name === 'Jali kabab')
  check('Jali kabab seeded unavailable', jali.is_available === false)
  const unavail = await call('POST', `/api/cart/${chuli.id}/items`, cust, { menu_item_id: kacchi.id, quantity: 1, modifier_option_ids: [portionFull.id, jali.id] })
  check('unavailable option -> 409 MODIFIER_OPTION_UNAVAILABLE', unavail.status === 409 && unavail.body.code === 'MODIFIER_OPTION_UNAVAILABLE', JSON.stringify(unavail.body))

  // ---------------------------------------------------------
  section('cart lines split and merge by modifier set')
  const okLarge = await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1, modifier_option_ids: [large.id, extraCheese.id] })
  check('valid add with modifiers -> 201', okLarge.status === 201, JSON.stringify(okLarge.body))

  // same dish, different modifiers -> separate line
  await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1, modifier_option_ids: [regular.id] })
  // same dish, SAME modifiers but reversed order -> must merge into line 1
  await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 2, modifier_option_ids: [extraCheese.id, large.id] })

  const cart = await call('GET', `/api/cart/${pizza.id}`, cust)
  check('cart_exists flag present', cart.body.cart_exists === true)
  check('two distinct lines for same dish', cart.body.cart.length === 2, `got ${cart.body.cart.length}`)

  const bigLine = cart.body.cart.find(l => l.modifiers.length === 2)
  const smallLine = cart.body.cart.find(l => l.modifiers.length === 1)
  check('reordered identical modifier set merged (qty 3)', bigLine.quantity === 3, `qty=${bigLine?.quantity}`)
  check('separate line kept qty 1', smallLine.quantity === 1)

  // 650 base + 250 large + 120 cheese = 1020 ; x3 = 3060
  check('line unit_price includes modifiers', Number(bigLine.unit_price) === 1020, `got ${bigLine.unit_price}`)
  check('line_total = unit_price x qty', Number(bigLine.line_total) === 3060, `got ${bigLine.line_total}`)
  // small line: 650 + 0 = 650
  const expectedSubtotal = 3060 + 650
  check('cart subtotal sums lines', Number(cart.body.subtotal) === expectedSubtotal, `got ${cart.body.subtotal} want ${expectedSubtotal}`)

  // ---------------------------------------------------------
  section('checkout prices modifiers server-side')
  const pizzaDetail = await call('GET', `/api/restaurants/${pizza.id}`)
  const openBranch = pizzaDetail.body.restaurant.branches.find(b => b.is_open)
  const closedBranch = pizzaDetail.body.restaurant.branches.find(b => !b.is_open)

  const closedTry = await call('POST', '/api/orders', cust, { branch_id: closedBranch.id, delivery_address: 'Test address 1', payment_method: 'cash_on_delivery' })
  check('closed branch -> 409 BRANCH_CLOSED', closedTry.status === 409 && closedTry.body.code === 'BRANCH_CLOSED', JSON.stringify(closedTry.body))

  const order = await call('POST', '/api/orders', cust, { branch_id: openBranch.id, delivery_address: 'House 1, Road 1, Dhanmondi', payment_method: 'cash_on_delivery', promo_code: 'WELCOME20' })
  check('order placed -> 201', order.status === 201, JSON.stringify(order.body))

  const o = order.body.order
  check('order subtotal matches cart subtotal', Number(o.subtotal) === expectedSubtotal, `got ${o.subtotal}`)
  check('WELCOME20 applied 20%', Number(o.discount_amount) === Number((expectedSubtotal * 0.2).toFixed(2)), `got ${o.discount_amount}`)
  check('total = subtotal - discount + delivery fee', Number(o.total_amount) === expectedSubtotal - Number(o.discount_amount) + Number(openBranch.delivery_fee))

  const orderedBig = o.items.find(i => i.modifiers.length === 2)
  check('order item carries modifier snapshot', orderedBig && orderedBig.modifiers.length === 2, JSON.stringify(orderedBig?.modifiers))
  check('order item line_total includes modifiers', Number(orderedBig.line_total) === 3060, `got ${orderedBig.line_total}`)
  check('order item unit_price stayed base price', Number(orderedBig.unit_price) === 650, `got ${orderedBig.unit_price}`)
  check('payment row starts unpaid', o.payment.status === 'unpaid')

  const cartAfter = await call('GET', `/api/cart/${pizza.id}`, cust)
  check('cart emptied after checkout', cartAfter.body.cart.length === 0)

  // ---------------------------------------------------------
  section('order lifecycle + COD settles on delivery')
  check('owner pending->confirmed', (await call('PATCH', `/api/orders/${o.id}/status`, ownerPizza, { status: 'confirmed' })).status === 200)
  check('owner confirmed->preparing', (await call('PATCH', `/api/orders/${o.id}/status`, ownerPizza, { status: 'preparing' })).status === 200)

  const accept = await call('POST', `/api/rider/deliveries/${o.id}/accept`, rider)
  check('rider accepts delivery -> 201', accept.status === 201, JSON.stringify(accept.body))
  check('rider picked_up', (await call('PATCH', `/api/rider/deliveries/${o.id}/status`, rider, { status: 'picked_up' })).status === 200)
  check('rider delivered', (await call('PATCH', `/api/rider/deliveries/${o.id}/status`, rider, { status: 'delivered' })).status === 200)

  const payAfter = await call('GET', `/api/payments/${o.id}`, cust)
  check('COD auto-marked paid on delivery', payAfter.body.payment.status === 'paid', JSON.stringify(payAfter.body))
  check('paid_at stamped', payAfter.body.payment.paid_at !== null)

  const otherPay = await call('GET', `/api/payments/${o.id}`, cust2)
  check('other customer cannot read payment -> 403', otherPay.status === 403)

  // ---------------------------------------------------------
  section('reviews + quality flag')
  const badRating = await call('POST', `/api/reviews/orders/${o.id}`, cust, { rating: 9 })
  check('rating out of range -> 400', badRating.status === 400)

  const review = await call('POST', `/api/reviews/orders/${o.id}`, cust, { rating: 4, portion_accuracy: 'full', comment: 'Good pizza.' })
  check('review created -> 201', review.status === 201, JSON.stringify(review.body))

  const dupe = await call('POST', `/api/reviews/orders/${o.id}`, cust, { rating: 5 })
  check('second review same order -> 409 ALREADY_REVIEWED', dupe.status === 409 && dupe.body.code === 'ALREADY_REVIEWED')

  const foreignReview = await call('POST', `/api/reviews/orders/${o.id}`, cust2, { rating: 1 })
  check('reviewing someone else order -> 403', foreignReview.status === 403)

  const reviews = await call('GET', `/api/reviews/restaurants/${pizza.id}`)
  check('reviews listed publicly', reviews.body.reviews.length >= 1)
  check('summary average present', Number(reviews.body.summary.average_rating) > 0)

  const listAfter = await call('GET', '/api/restaurants')
  const pizzaAfter = listAfter.body.restaurants.find(r => r.name === 'Pizza Republic')
  check('restaurant list average_rating now populated', Number(pizzaAfter.average_rating) > 0, `got ${pizzaAfter.average_rating}`)

  // ---------------------------------------------------------
  section('customer cancel refunds promo + fails payment')
  const promoBefore = await call('GET', '/api/restaurants') // touch
  await call('POST', addUrl, cust, { menu_item_id: margherita.id, quantity: 1, modifier_option_ids: [regular.id] })
  const order2 = await call('POST', '/api/orders', cust, { branch_id: openBranch.id, delivery_address: 'Somewhere 2', payment_method: 'bkash', promo_code: 'FLAT10' })
  check('second order placed', order2.status === 201, JSON.stringify(order2.body))
  const o2 = order2.body.order

  const testReference = 'BK' + Date.now() + 'A'
  const ref = await call('POST', `/api/payments/${o2.id}/reference`, cust, { transaction_ref: testReference })
  check('bkash reference accepted', ref.status === 200 && ref.body.payment.transaction_ref === testReference, JSON.stringify(ref.body))
  check('reference does not self-mark paid', ref.body.payment.status === 'unpaid')

  const selfPaid = await call('PATCH', `/api/payments/${o2.id}/status`, cust, { status: 'paid' })
  check('customer cannot mark own payment paid -> 403', selfPaid.status === 403)

  const cancel = await call('PATCH', `/api/orders/${o2.id}/cancel`, cust)
  check('customer cancels pending order -> 200', cancel.status === 200, JSON.stringify(cancel.body))
  check('order now cancelled', cancel.body.order.status === 'cancelled')

  const payCancelled = await call('GET', `/api/payments/${o2.id}`, cust)
  check('payment marked failed on cancel', payCancelled.body.payment.status === 'failed', JSON.stringify(payCancelled.body))

  const payAnyway = await call('PATCH', `/api/payments/${o2.id}/status`, ownerPizza, { status: 'paid' })
  check('cannot mark cancelled order paid -> 409', payAnyway.status === 409 && payAnyway.body.code === 'ORDER_CANCELLED')

  const cancelAgain = await call('PATCH', `/api/orders/${o2.id}/cancel`, cust)
  check('cancelling twice -> 409', cancelAgain.status === 409)

  const cancelDelivered = await call('PATCH', `/api/orders/${o.id}/cancel`, cust)
  check('cannot cancel delivered order -> 409', cancelDelivered.status === 409)

  // ---------------------------------------------------------
  // Full lifecycle helper: cart -> order -> owner -> rider -> delivered.
  const placeAndDeliver = async (token, restaurantId, itemId, modifierIds, branchId, method = 'cash_on_delivery') => {
    await call('POST', `/api/cart/${restaurantId}/items`, token, {
      menu_item_id: itemId, quantity: 1, modifier_option_ids: modifierIds
    })
    const placed = await call('POST', '/api/orders', token, {
      branch_id: branchId, delivery_address: 'Lifecycle test address', payment_method: method
    })
    if (placed.status !== 201) throw new Error('placeAndDeliver: order failed ' + JSON.stringify(placed.body))
    const id = placed.body.order.id
    if (method !== 'cash_on_delivery') {
      await call('POST', `/api/payments/${id}/reference`, token, { transaction_ref: `BK-LIFECYCLE-${id}` })
      await call('PATCH', `/api/payments/${id}/status`, ownerPizza, { status: 'paid' })
    }
    await call('PATCH', `/api/orders/${id}/status`, ownerPizza, { status: 'confirmed' })
    await call('PATCH', `/api/orders/${id}/status`, ownerPizza, { status: 'preparing' })
    await call('POST', `/api/rider/deliveries/${id}/accept`, rider)
    await call('PATCH', `/api/rider/deliveries/${id}/status`, rider, { status: 'picked_up' })
    await call('PATCH', `/api/rider/deliveries/${id}/status`, rider, { status: 'delivered' })
    return id
  }

  section('owner confirms an online payment')
  const bkashId = await placeAndDeliver(cust, pizza.id, margherita.id, [regular.id], openBranch.id, 'bkash')
  const settled = await call('GET', `/api/payments/${bkashId}`, cust)
  check('owner verified mobile payment before dispatch', settled.body.payment.status === 'paid')
  check('paid_at set on confirm', settled.body.payment.paid_at !== null)
  const reverse = await call('PATCH', `/api/payments/${bkashId}/status`, ownerPizza, { status: 'failed' })
  check('settled payment cannot silently reverse -> 409', reverse.status === 409 && reverse.body.code === 'ALREADY_PAID')
  const replaceRef = await call('POST', `/api/payments/${bkashId}/reference`, cust, { transaction_ref: 'REPLACEMENT' })
  check('settled payment reference cannot be overwritten', replaceRef.status === 409)

  // ---------------------------------------------------------
  section('quality flag pipeline (3x way_less)')
  const beforeMenu = await call('GET', `/api/menu/restaurants/${pizza.id}`)
  const pepBefore = beforeMenu.body.categories.flatMap(c => c.items).find(i => i.name === 'Pepperoni Classic')
  check('Pepperoni starts unflagged', pepBefore.quality_flag === false)

  let flaggedAt = null
  for (let i = 1; i <= 3; i++) {
    const id = await placeAndDeliver(cust, pizza.id, pepBefore.id, [], openBranch.id)
    const rev = await call('POST', `/api/reviews/orders/${id}`, cust, { rating: 2, portion_accuracy: 'way_less' })
    if (rev.status !== 201) { check(`way_less review #${i}`, false, JSON.stringify(rev.body)); break }
    if (rev.body.flagged_items.length > 0) flaggedAt = i
  }
  check('flag raised only on the 3rd report', flaggedAt === 3, `flagged at report #${flaggedAt}`)

  const afterMenu = await call('GET', `/api/menu/restaurants/${pizza.id}`)
  const pepAfter = afterMenu.body.categories.flatMap(c => c.items).find(i => i.name === 'Pepperoni Classic')
  check('menu now reports quality_flag', pepAfter.quality_flag === true)

  console.log(`\n---------------------------------------`)
  console.log(`${pass} passed, ${fail} failed`)

  await pool.end()
  process.exit(fail > 0 ? 1 : 0)
})().catch(async e => {
  console.error('HARNESS ERROR:', e)
  await pool.end().catch(() => {})
  process.exit(1)
})

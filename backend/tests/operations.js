// Run through `npm run test:backend`: the harness selects a separate test DB.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')
const pool = require('../db/pool')
const base = process.env.TEST_BASE_URL
let passed = 0
async function call(method, route, token, body) {
  const response = await fetch(`${base}/api/operations${route}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  passed++
  console.log(`PASS ${name}`)
}
async function login(email, password = 'password123') {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const body = await response.json()
  assert.ok(body.token, JSON.stringify(body))
  return body.token
}
async function main() {
  if (!base || !/_(test|review)$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Use the isolated test harness.')
  const adminPassword = crypto.randomBytes(18).toString('hex')
  const adminEmail = `ops-${Date.now()}@example.com`
  await pool.query('INSERT INTO users(name,email,password,role) VALUES ($1,$2,$3,$4)',
    ['Operations test', adminEmail, await bcrypt.hash(adminPassword, 10), 'admin'])
  const admin = await login(adminEmail, adminPassword)
  const customer = await login('ayesha@example.com')
  const other = await login('tanvir@example.com')
  check('support requires authentication', (await call('GET', '/tickets')).status, 401)
  check('short support message rejected', (await call('POST', '/tickets', customer, { subject: 'Hello', message: 'x' })).status, 400)
  const ticket = await call('POST', '/tickets', customer, { subject: 'Delivery assistance', message: 'Please help check my delivery details.' })
  check('customer creates support request', ticket.status, 201)
  check('other customer cannot see ticket', (await call('GET', '/tickets', other)).body.tickets.some(row => row.id === ticket.body.ticket.id), false)
  check('customer cannot resolve tickets', (await call('PATCH', `/tickets/${ticket.body.ticket.id}`, customer, { status: 'resolved', admin_reply: 'Self resolved' })).status, 403)
  const resolved = await call('PATCH', `/tickets/${ticket.body.ticket.id}`, admin, { status: 'resolved', admin_reply: 'Your request has been reviewed.' })
  check('admin resolves support request', resolved.status, 200)
  check('reply stored', resolved.body.ticket.status, 'resolved')
  check('customer cannot list platform orders', (await call('GET', '/orders', customer)).status, 403)
  check('admin sees platform orders', (await call('GET', '/orders', admin)).status, 200)
  check('summary restricted to business roles', (await call('GET', '/summary', customer)).status, 403)
  check('admin summary calculated', (await call('GET', '/summary', admin)).status, 200)
  check('customer cannot create promo', (await call('POST', '/promos', customer, {})).status, 403)
  check('invalid calendar date rejected', (await call('POST', '/promos', admin, { code: 'BADDATE', discount_percent: 10, expiry_date: '2027-02-31' })).status, 400)
  const promo = await call('POST', '/promos', admin, { code: `T${Date.now()}`, discount_percent: 15,
    min_order_amount: 100, expiry_date: '2030-12-31', usage_limit: 10 })
  check('admin creates promo', promo.status, 201)
  check('promo activation changes', (await call('PATCH', `/promos/${promo.body.promo.id}`, admin, { is_active: false })).status, 200)
  check('inactive promo hidden from customer', (await call('GET', '/promos', customer)).body.promos.some(row => row.id === promo.body.promo.id), false)
  console.log(`Operations: ${passed} assertions passed.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())

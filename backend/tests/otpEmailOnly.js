// Regression checks for PHONE_OTP_REQUIRED=false (email-only verification).
// Run through `npm run test:backend`. This file starts its own second API
// server with the switch turned off, so the main suite keeps testing the
// strict default (email + phone).
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const pool = require('../db/pool')
const { latestCode, uniquePhone, startApiServer } = require('./otpHelpers')

const port = Number(process.env.PORT || 8011) + 1
const base = `http://127.0.0.1:${port}`
let passed = 0

function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  passed++
  console.log('PASS ' + name)
}

async function call(method, route, token, body) {
  const response = await fetch(base + '/api' + route, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

async function main() {
  if (!/_(test|review)$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Use npm run test:backend with a separate database.')
  // SMS_PROVIDER is removed on purpose: with phone OTP off, the server must
  // start without any SMS configuration.
  const server = await startApiServer(port, { PHONE_OTP_REQUIRED: 'false' }, ['SMS_PROVIDER'])

  try {
    const account = { name: 'Email only', email: `email-only-${Date.now()}@example.com`, password: 'testPassword123', role: 'customer', phone: uniquePhone() }
    const signup = await call('POST', '/auth/signup', null, account)
    check('signup returns 201', signup.status, 201)
    check('only email is required', signup.body.channels, ['email'])
    check('only the email code is sent', signup.body.delivery, { email: 'sent' })

    const rows = await pool.query(
      `SELECT o.channel FROM otp_verifications o JOIN users u ON u.id = o.user_id WHERE u.email = $1`, [account.email])
    check('no phone OTP row is created', rows.rows.map(row => row.channel), ['email'])

    const early = await call('POST', '/auth/login', null, { email: account.email, password: account.password })
    check('login before email verification refused', [early.status, early.body.code, early.body.channels], [403, 'ACCOUNT_NOT_VERIFIED', ['email']])

    const verify = await call('POST', '/auth/verify-otp', null, { email: account.email, email_otp: latestCode('email', account.email) })
    check('email code alone verifies the account', [verify.status, verify.body.account_verified], [200, true])

    const user = await pool.query('SELECT email_verified_at, phone_verified_at FROM users WHERE email = $1', [account.email])
    check('phone stays unverified', [user.rows[0].email_verified_at !== null, user.rows[0].phone_verified_at], [true, null])

    const login = await call('POST', '/auth/login', null, { email: account.email, password: account.password })
    check('login works with email verified', login.status, 200)
    const profile = await call('GET', '/account/profile', login.body.token)
    check('protected route reachable', profile.status, 200)

    const phoneResend = await call('POST', '/auth/resend-otp', null, { email: account.email, channel: 'phone' })
    check('phone resend sends nothing', phoneResend.body.delivery, {})

    console.log(`Email-only verification checks passed: ${passed}`)
  } finally {
    server.kill('SIGTERM')
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())

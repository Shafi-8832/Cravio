// Regression checks for EMAIL_OTP_REQUIRED=false + PHONE_OTP_REQUIRED=false
// (no signup verification). Run through `npm run test:backend`. Starts its
// own API server with both switches off and no provider configured.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const pool = require('../db/pool')
const { uniquePhone, startApiServer } = require('./otpHelpers')

const port = Number(process.env.PORT || 8011) + 2
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
  const server = await startApiServer(port,
    { EMAIL_OTP_REQUIRED: 'false', PHONE_OTP_REQUIRED: 'false' }, ['EMAIL_PROVIDER', 'SMS_PROVIDER'])

  try {
    const account = { name: 'No OTP', email: `no-otp-${Date.now()}@example.com`, password: 'testPassword123', role: 'rider', phone: uniquePhone() }
    const signup = await call('POST', '/auth/signup', null, account)
    check('signup returns 201', signup.status, 201)
    check('no channels required', signup.body.channels, [])
    check('nothing is sent', signup.body.delivery, {})
    check('signup still issues no token', signup.body.token, undefined)

    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM otp_verifications o JOIN users u ON u.id = o.user_id WHERE u.email = $1', [account.email])
    check('no OTP rows created', rows.rows[0].n, 0)

    const login = await call('POST', '/auth/login', null, { email: account.email, password: account.password })
    check('login works straight after signup', [login.status, login.body.user?.role], [200, 'rider'])
    const profile = await call('GET', '/account/profile', login.body.token)
    check('protected route reachable', profile.status, 200)
    const wrongRole = await call('GET', '/admin/users', login.body.token)
    check('role checks still enforced', wrongRole.status, 403)

    console.log(`No-verification checks passed: ${passed}`)
  } finally {
    server.kill('SIGTERM')
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())

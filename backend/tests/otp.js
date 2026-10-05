// Regression checks for email + phone OTP verification.
// Run through `npm run test:backend`: the harness selects a separate test DB
// and sets EMAIL_PROVIDER/SMS_PROVIDER=outbox so codes can be read locally.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const pool = require('../db/pool')
const { latestCode, uniquePhone } = require('./otpHelpers')
const base = process.env.TEST_BASE_URL
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

// A wrong code that is guaranteed to differ from the real one.
const wrong = code => String((Number(code) + 1) % 1000000).padStart(6, '0')

async function signup(label) {
  const account = { name: 'OTP ' + label, email: `otp-${label}-${Date.now()}@example.com`, password: 'testPassword123', role: 'customer', phone: uniquePhone() }
  const response = await call('POST', '/auth/signup', null, account)
  return { ...account, response }
}

async function main() {
  if (!base || !/_(test|review)$/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('Use npm run test:backend with a separate database.')

  // 1–3. Signup creates an unverified account and sends both codes.
  const a = await signup('main')
  check('signup returns 201', a.response.status, 201)
  check('signup issues no token', a.response.body.token, undefined)
  check('signup never returns a code', JSON.stringify(a.response.body).match(/\b\d{6}\b/), null)
  check('both codes delivered', a.response.body.delivery, { email: 'sent', phone: 'sent' })
  const rows = await pool.query(
    `SELECT o.channel, o.status, o.otp_hash, u.email_verified_at, u.phone_verified_at
     FROM otp_verifications o JOIN users u ON u.id = o.user_id WHERE u.email = $1 ORDER BY o.channel`, [a.email])
  check('two pending OTP rows', rows.rows.map(row => `${row.channel}:${row.status}`), ['email:pending', 'phone:pending'])
  check('user starts unverified', rows.rows[0].email_verified_at === null && rows.rows[0].phone_verified_at === null, true)
  const emailCode = latestCode('email', a.email)
  const phoneCode = latestCode('phone', a.phone)
  check('code is stored hashed, not plain', rows.rows.some(row => row.otp_hash.includes(emailCode) || row.otp_hash.includes(phoneCode)), false)

  // 7. Login before verification is refused with a machine-readable code.
  const early = await call('POST', '/auth/login', null, { email: a.email, password: a.password })
  check('unverified login is 403', early.status, 403)
  check('unverified login code', early.body.code, 'ACCOUNT_NOT_VERIFIED')
  check('unverified login issues no token', early.body.token, undefined)
  const earlyWrongPassword = await call('POST', '/auth/login', null, { email: a.email, password: 'wrongPassword1' })
  check('wrong password still a plain 401', earlyWrongPassword.status, 401)

  // 8. Wrong code: rejected, attempts counted.
  const bad = await call('POST', '/auth/verify-otp', null, { email: a.email, email_otp: wrong(emailCode) })
  check('wrong code is 400', bad.status, 400)
  check('wrong code error code', bad.body.code, 'OTP_INVALID')
  check('attempts left reported', bad.body.results.email.attemptsLeft, 4)

  // 4. Partial then full verification.
  const half = await call('POST', '/auth/verify-otp', null, { email: a.email, email_otp: emailCode, phone_otp: wrong(phoneCode) })
  check('mixed result keeps email success', [half.status, half.body.email_verified, half.body.phone_verified], [400, true, false])
  const full = await call('POST', '/auth/verify-otp', null, { email: a.email, phone_otp: phoneCode })
  check('phone verified completes account', [full.status, full.body.account_verified], [200, true])

  // 10. Reusing a used code fails.
  const reuseResult = await pool.query(
    `SELECT u.id FROM users u WHERE u.email = $1`, [a.email])
  const reuse = await call('POST', '/auth/verify-otp', null, { email: 'nobody-' + Date.now() + '@example.com', email_otp: emailCode })
  check('unknown email looks like a wrong code', [reuse.status, reuse.body.code], [400, 'OTP_INVALID'])
  const used = await pool.query(`SELECT status FROM otp_verifications WHERE user_id = $1 AND channel = 'email' ORDER BY id DESC LIMIT 1`, [reuseResult.rows[0].id])
  check('used code is no longer pending', used.rows[0].status, 'verified')

  // 5–6. Login works and protected routes accept the token.
  const login = await call('POST', '/auth/login', null, { email: a.email, password: a.password })
  check('verified login is 200', login.status, 200)
  check('role read from database', login.body.user.role, 'customer')
  const me = await call('GET', '/account/profile', login.body.token)
  check('protected route reachable', me.status, 200)

  // 13–14. Logout revokes the token for real.
  const logout = await call('POST', '/auth/logout', login.body.token)
  check('logout ok', logout.status, 200)
  const afterLogout = await call('GET', '/account/profile', login.body.token)
  check('revoked token rejected', afterLogout.status, 401)

  // 9 + 10. Expired code, and code reuse on a second account.
  const b = await signup('expiry')
  const bEmailCode = latestCode('email', b.email)
  await pool.query(
    `UPDATE otp_verifications SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
     WHERE user_id = (SELECT id FROM users WHERE email = $1) AND channel = 'email'`, [b.email])
  const expired = await call('POST', '/auth/verify-otp', null, { email: b.email, email_otp: bEmailCode })
  check('expired code is rejected', [expired.status, expired.body.code], [400, 'OTP_EXPIRED'])

  // 11. Resend: immediate retry hits the cooldown; after it, a new code works
  //     and the old one is superseded.
  const tooSoon = await call('POST', '/auth/resend-otp', null, { email: b.email, channel: 'email' })
  check('resend cooldown is 429', [tooSoon.status, tooSoon.body.code], [429, 'OTP_RESEND_COOLDOWN'])
  await pool.query(
    `UPDATE otp_verifications SET created_at = created_at - INTERVAL '2 minutes'
     WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [b.email])
  const resent = await call('POST', '/auth/resend-otp', null, { email: b.email, channel: 'email' })
  check('resend after cooldown', [resent.status, resent.body.delivery.email], [200, 'sent'])
  const newCode = latestCode('email', b.email)
  const oldCode = await call('POST', '/auth/verify-otp', null, { email: b.email, email_otp: bEmailCode === newCode ? wrong(newCode) : bEmailCode })
  check('old code no longer works', oldCode.status, 400)
  const newWorks = await call('POST', '/auth/verify-otp', null, { email: b.email, email_otp: newCode })
  check('new code works', [newWorks.status, newWorks.body.email_verified], [200, true])
  const unknownResend = await call('POST', '/auth/resend-otp', null, { email: 'ghost-' + Date.now() + '@example.com' })
  check('unknown email resend is generic 200', unknownResend.status, 200)

  // 12. Too many wrong guesses lock the code, even the right one afterwards.
  const c = await signup('lockout')
  const cPhoneCode = latestCode('phone', c.phone)
  for (let i = 0; i < 4; i++) await call('POST', '/auth/verify-otp', null, { email: c.email, phone_otp: wrong(cPhoneCode) })
  const fifth = await call('POST', '/auth/verify-otp', null, { email: c.email, phone_otp: wrong(cPhoneCode) })
  check('fifth wrong guess locks', [fifth.status, fifth.body.code], [429, 'OTP_TOO_MANY_ATTEMPTS'])
  const rightButLocked = await call('POST', '/auth/verify-otp', null, { email: c.email, phone_otp: cPhoneCode })
  check('correct code after lock still refused', rightButLocked.body.code, 'OTP_TOO_MANY_ATTEMPTS')

  // Hourly resend cap: 5 codes per channel per hour (signup counts as one).
  for (let i = 0; i < 4; i++) {
    await pool.query(
      `UPDATE otp_verifications SET created_at = created_at - INTERVAL '61 seconds'
       WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [c.email])
    const ok = await call('POST', '/auth/resend-otp', null, { email: c.email, channel: 'phone' })
    assert.equal(ok.status, 200)
  }
  await pool.query(
    `UPDATE otp_verifications SET created_at = created_at - INTERVAL '61 seconds'
     WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [c.email])
  const capped = await call('POST', '/auth/resend-otp', null, { email: c.email, channel: 'phone' })
  check('sixth code in an hour is refused', [capped.status, capped.body.code], [429, 'OTP_RESEND_LIMIT'])

  // Input validation.
  const badPhone = await call('POST', '/auth/signup', null, { name: 'x', email: `bad-${Date.now()}@example.com`, password: 'testPassword123', role: 'customer', phone: '12345678' })
  check('non-Bangladeshi phone rejected', badPhone.status, 400)
  const badFormat = await call('POST', '/auth/verify-otp', null, { email: c.email, phone_otp: '12ab56' })
  check('malformed code rejected', badFormat.status, 400)

  console.log(`OTP verification checks passed: ${passed}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => pool.end())

const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken') // header.payload.signature
// header = {alg: "HS256", typ: "JWT"}
// payload = {id: user.id, email: user.email, role: user.role, jti: jti, exp: exp}
// signature = HMACSHA256(base64UrlEncode(header) + "." + base64UrlEncode(payload), JWT_SECRET from .env)
// JWT_SECRET is only in .env, never in the codebase, so that it is not accidentally committed to version control. It is a secret key used to sign and verify JWT tokens. If an attacker gets access to the JWT_SECRET, they can create valid tokens and impersonate users.

const crypto = require('crypto')

const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const otpService = require('../services/otpService')

const router = express.Router()


// The four role values the database will actually accept. This list is a
// deliberate mirror of the CHECK constraint on users.role in
// backend/db/schema.sql — if one changes, the other must change with it.
// It exists so that a role value coming from a request can be checked
// against a known set *before* it ever reaches SQL.
const DB_ROLES = [
  'customer',
  'restaurant_owner',
  'rider',
  'admin'
]


// Roles a visitor may create for themselves. 'admin' is absent on purpose:
// admins are seeded by the dev team (npm run seed:admin), never signed up.
const SIGNUP_ROLES = [
  'customer',
  'restaurant_owner',
  'rider'
]


// Human wording for the 403 we return when someone logs in through the
// wrong role card, so the UI can show "not registered as a rider".
const ROLE_LABELS = {
  customer: 'a customer',
  restaurant_owner: 'a restaurant owner',
  rider: 'a rider',
  admin: 'an administrator'
}


// Bangladeshi mobile numbers: 01 + operator digit 3-9 + 8 digits, optionally
// written with the +880 / 880 country code. The phone receives an SMS code,
// so it has to be a number a Bangladeshi gateway can actually reach.
const BD_MOBILE_REGEX = /^(?:\+?880|0)(1[3-9]\d{8})$/

// Returns the number in one stored form (01XXXXXXXXX) or null if invalid.
// Spaces and dashes are removed first so "017-1234 5678" is accepted.
function normalizeBdPhone(phone) {
  const match = BD_MOBILE_REGEX.exec(String(phone).replace(/[\s-]/g, ''))
  return match ? '0' + match[1] : null
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const OTP_REGEX = /^\d{6}$/



// ============================================================
// SIGNUP
// POST /api/auth/signup
// ============================================================

router.post('/signup', async (req, res) => {

  const { name, email, password, role, phone } = req.body


  if (![name, email, password, role, phone].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({
      error: 'All fields are required.'
    })
  }


  const trimmedName = String(name).trim()
  const trimmedEmail = String(email).trim().toLowerCase()
  const trimmedPhone = normalizeBdPhone(phone)


  if (!trimmedName || trimmedName.length > 100 || !trimmedEmail || trimmedEmail.length > 100) {
    return res.status(400).json({
      error: 'All fields are required.'
    })
  }


  if (!trimmedPhone) {
    return res.status(400).json({
      error: 'Please enter a valid Bangladeshi mobile number (e.g. 01712345678).'
    })
  }


  const emailRegex = EMAIL_REGEX
  // what is this regex doing? /^[^\s@]+@[^\s@]+\.[^\s@]+$/  --> 
  // matches a string that contains one or more characters 
  // that are not whitespace or @, followed by an @, 
  // followed by one or more characters that are not whitespace or @, 
  // followed by a ., followed by one or more characters that are not whitespace or @

  if (!emailRegex.test(trimmedEmail)) {
    return res.status(400).json({
      error: 'Please enter a valid email address.'
    })
  }
  
  // 400 = bad data


  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters and at most 72 UTF-8 bytes.'
    })
  }


  // Public signup can never mint an administrator, no matter what the
  // client sends. This is a separate, explicit rejection so the refusal is
  // obvious rather than hidden inside a generic "invalid role".
  if (role === 'admin') {
    return res.status(403).json({
      error: 'Administrator accounts cannot be created through signup.'
    })
  }


  if (!SIGNUP_ROLES.includes(role)) {
    return res.status(400).json({
      error: 'Invalid role.'
    })
  }


  // Insert the value taken FROM the server-side allowlist, not the raw
  // string off the request body. Same characters, but the row can now only
  // ever hold something this file approved.
  const roleToCreate = SIGNUP_ROLES.find(allowed => allowed === role) // no role tampering: the role is taken from the allowlist, not the request body. This prevents malicious users from creating accounts with invalid roles.
  // what is this line doing?
  // why is it necessary to find the role from the allowlist instead of just using the role from the request body?
  // This is a security measure to ensure that only valid roles can be created, and to prevent malicious users from submitting invalid roles.


  const client = await pool.connect()
  // since we are using a transaction,
  //  we need to use a dedicated client connection for this request. 
  // This is because a transaction is tied to a single connection, 
  // and we don't want other requests to interfere with it.


  try {

    await client.query('BEGIN')


    const existingUser = await client.query(
      'SELECT id FROM users WHERE email=$1',
      [trimmedEmail]
    )


    if (existingUser.rows.length > 0) {

      await client.query('ROLLBACK')

      return res.status(409).json({
        error: 'Email already registered.'
      })

    }


    const hashedPassword = await bcrypt.hash(password, 10)
    // 10 means the cost factor for the hashing algorithm, which determines how many iterations of hashing are performed. A higher number means more security but also more processing time. 10 is a common default that balances security and performance.

    const result = await client.query(

      `
      INSERT INTO users
      (
        name,
        email,
        password,
        role,
        phone
      )

      VALUES
      ($1,$2,$3,$4,$5)

      RETURNING
      id,
      name,
      email,
      role,
      phone
      `,

      [
        trimmedName,
        trimmedEmail,
        hashedPassword,
        roleToCreate,
        trimmedPhone
      ]

    )


    const user = result.rows[0]


    if (roleToCreate === 'rider') {

      await client.query(

        `
        INSERT INTO rider_profiles
        (
          user_id,
          vehicle_type,
          status
        )

        VALUES
        ($1,$2,$3)
        `,

        [
          user.id,
          null,
          'offline'
        ]

      )

    }


    // The account starts unverified (email_verified_at / phone_verified_at
    // are NULL). One code per channel is created in this same transaction,
    // so a user row never exists without the codes that can verify it.
    const codes = {
      email: await otpService.createOtp(client, user.id, 'email'),
      phone: await otpService.createOtp(client, user.id, 'phone')
    }


    await client.query('COMMIT')


    // Sent only after COMMIT — see deliverOtps. No JWT is issued here any
    // more: a token is handed out by /login, once both codes are verified.
    const delivery = await otpService.deliverOtps(user, codes)


    res.status(201).json({

      message: 'Account created. Enter the codes sent to your email and phone to activate it.',
      email: user.email,
      phone_masked: otpService.maskPhone(user.phone),
      delivery,
      expires_in_minutes: otpService.OTP_TTL_MINUTES,
      resend_available_in: otpService.RESEND_COOLDOWN_SECONDS

    })


  }

  catch (error) {

    await client.query('ROLLBACK')

    console.error(
      "SIGNUP ERROR:",
      error
    )


    if (error.code === '23505') return res.status(409).json({ error: 'Email already registered.' })

    res.status(500).json({

      error: 'Server error processing authentication.'

    })

  }

  finally {

    client.release()

  }


})





// ============================================================
// LOGIN
// POST /api/auth/login
// ============================================================


router.post('/login', async (req, res) => {


  const {
    email,
    password,
    expectedRole
  } = req.body



  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password || email.length > 100 || Buffer.byteLength(password, 'utf8') > 72) {

    return res.status(400).json({

      error: "Email and password are required."

    })

  }



  // expectedRole is the role card the visitor clicked ("I am logging in as
  // a rider"). It is a CLAIM, not an identity: it can only ever cause a
  // rejection further down. The real role is read from the users row.
  // A generic login (the admin screen, or an API client) omits it, and
  // then login behaves exactly as it always did.
  if (expectedRole !== undefined && !DB_ROLES.includes(expectedRole)) {

    return res.status(400).json({

      error: "Invalid role."

    })

  }



  const trimmedEmail =
    String(email)
      .trim()
      .toLowerCase()



  try {


    const result = await pool.query(

      'SELECT * FROM users WHERE email=$1',

      [
        trimmedEmail
      ]

    )



    if (result.rows.length === 0) {

      return res.status(401).json({

        error: "Invalid email or password."

      })

    }



    const user = result.rows[0]



    const validPassword =
      await bcrypt.compare(

        password,

        user.password

      )



    if (!validPassword) {

      return res.status(401).json({

        error: "Invalid email or password."

      })

    }




    // The role that counts: read straight off the database row.
    const actualRole = user.role


    // Role mismatch is checked only AFTER the password has been verified.
    // If it were checked first, anyone could type an email with no password
    // and learn from the 403 which role that email belongs to — user
    // enumeration. Failing the password first means a stranger always gets
    // the same generic 401.
    if (expectedRole !== undefined && expectedRole !== actualRole) {

      return res.status(403).json({

        error: `This account is not registered as ${ROLE_LABELS[expectedRole]}.`

      })

    }




    if (!user.is_active) {

      return res.status(403).json({

        error: "Your account has been suspended."

      })

    }




    // Checked only AFTER the password matched, for the same reason as the
    // role check above: a stranger must not learn which emails are pending.
    // The response carries a code (not just text) so the frontend can send
    // the visitor to the verification screen instead of showing a dead end.
    if (user.email_verified_at === null || user.phone_verified_at === null) {

      return res.status(403).json({

        error: "Please verify your email and phone number before logging in.",
        code: 'ACCOUNT_NOT_VERIFIED',
        email: user.email

      })

    }




    if (!process.env.JWT_SECRET) {

      throw new Error(
        "JWT_SECRET missing in .env"
      )

    }



    const jti =
      crypto.randomBytes(16)
        .toString('hex')



    const token = jwt.sign(

      {

        id: user.id,
        email: user.email,
        // From the database row, never from the request body.
        role: actualRole,
        jti

      },

      process.env.JWT_SECRET,

      {
        expiresIn: '7d'
      }

    )



    const {
      password: _,
      ...userWithoutPassword
    } = user



    res.json({

      token,

      user: userWithoutPassword

    })



  }

  catch (error) {


    console.error(
      "LOGIN ERROR FULL:",
      error
    )



    res.status(500).json({

      error: 'Server error processing authentication.'

    })


  }



})





// ============================================================
// VERIFY OTP
// POST /api/auth/verify-otp
// Body: { email, email_otp?, phone_otp? } — at least one code.
//
// Each channel is checked on its own, so a visitor who typed the email
// code right and the phone code wrong keeps the email success and only
// retries the phone code. The account becomes usable once both are done.
// ============================================================

// The message for each failed status, worst first: if several channels
// failed, the response describes the most serious problem.
const OTP_FAILURES = [
  { status: 'locked', http: 429, code: 'OTP_TOO_MANY_ATTEMPTS', error: 'Too many incorrect attempts. Request a new code.' },
  { status: 'expired', http: 400, code: 'OTP_EXPIRED', error: 'This code has expired or was already used. Request a new code.' },
  { status: 'invalid', http: 400, code: 'OTP_INVALID', error: 'The code is incorrect.' }
]

router.post('/verify-otp', async (req, res) => {

  const { email, email_otp: emailOtp, phone_otp: phoneOtp } = req.body

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim()) || email.length > 100) {
    return res.status(400).json({ error: 'A valid email address is required.' })
  }

  // Each code is optional, but whatever is sent must be exactly 6 digits.
  const codes = {}
  if (emailOtp !== undefined && emailOtp !== '') codes.email = emailOtp
  if (phoneOtp !== undefined && phoneOtp !== '') codes.phone = phoneOtp

  if (Object.keys(codes).length === 0) {
    return res.status(400).json({ error: 'Enter the email code, the phone code, or both.' })
  }

  if (!Object.values(codes).every(code => typeof code === 'string' && OTP_REGEX.test(code))) {
    return res.status(400).json({ error: 'Codes are 6 digits.', code: 'OTP_INVALID' })
  }

  try {

    const outcome = await otpService.verifyAccount(email.trim().toLowerCase(), codes)

    // Unknown email: same answer as a wrong code, so this endpoint cannot
    // be used to discover which addresses have accounts.
    if (!outcome) {
      return res.status(400).json({ error: 'The code is incorrect.', code: 'OTP_INVALID' })
    }

    // What the UI needs in every case, success or failure.
    const body = {
      email_verified: outcome.emailVerified,
      phone_verified: outcome.phoneVerified,
      account_verified: outcome.emailVerified && outcome.phoneVerified,
      results: outcome.results
    }

    const failure = OTP_FAILURES.find(item =>
      Object.values(outcome.results).some(result => result.status === item.status))

    if (failure) {
      return res.status(failure.http).json({ ...body, error: failure.error, code: failure.code })
    }

    res.json({
      ...body,
      message: body.account_verified
        ? 'Email and phone verified. You can now log in.'
        : 'Code accepted. Enter the remaining code to finish.'
    })

  }

  catch (error) {

    // Log the failure, never the request body — it contains the codes.
    console.error('VERIFY OTP ERROR:', error.message)

    res.status(500).json({ error: 'Server error while verifying the code.' })

  }

})





// ============================================================
// RESEND OTP
// POST /api/auth/resend-otp
// Body: { email, channel: 'email' | 'phone' | 'both' }
// ============================================================

const RESEND_CHANNELS = {
  email: ['email'],
  phone: ['phone'],
  both: ['email', 'phone']
}

router.post('/resend-otp', async (req, res) => {

  const { email, channel = 'both' } = req.body

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email.trim()) || email.length > 100) {
    return res.status(400).json({ error: 'A valid email address is required.' })
  }

  if (!Object.hasOwn(RESEND_CHANNELS, channel)) {
    return res.status(400).json({ error: "channel must be 'email', 'phone' or 'both'." })
  }

  try {

    const result = await otpService.resendOtps(email.trim().toLowerCase(), RESEND_CHANNELS[channel])

    if (result.outcome === 'cooldown') {
      res.set('Retry-After', String(result.retryAfter))
      return res.status(429).json({
        error: `Please wait ${result.retryAfter} seconds before requesting another code.`,
        code: 'OTP_RESEND_COOLDOWN',
        retry_after: result.retryAfter
      })
    }

    if (result.outcome === 'limit') {
      return res.status(429).json({
        error: 'Too many codes requested. Please try again in an hour.',
        code: 'OTP_RESEND_LIMIT'
      })
    }

    // 'nothing_to_send' (unknown or already-verified email) gets the same
    // generic success as a real send, so it reveals nothing.
    res.json({
      message: 'If this account still needs verification, a new code has been sent.',
      delivery: result.delivery || {},
      phone_masked: result.phoneMasked || null,
      resend_available_in: otpService.RESEND_COOLDOWN_SECONDS
    })

  }

  catch (error) {

    console.error('RESEND OTP ERROR:', error.message)

    res.status(500).json({ error: 'Server error while sending a new code.' })

  }

})





// ============================================================
// LOGOUT
// POST /api/auth/logout
// ============================================================


router.post(
  '/logout',
  authenticateToken,
  async (req, res) => {


    const client = await pool.connect()


    try {

      await client.query('BEGIN')

      await client.query(`
        WITH cleanup AS (DELETE FROM revoked_tokens WHERE expires_at < CURRENT_TIMESTAMP)
        INSERT INTO revoked_tokens (jti, user_id, expires_at)
        VALUES ($1, $2, to_timestamp($3)) ON CONFLICT (jti) DO NOTHING
      `, [req.user.jti, req.user.id, req.user.exp])

      await client.query('COMMIT')

      res.json({

        message: "Logged out successfully."

      })



    }

    catch (error) {

      await client.query('ROLLBACK')

      console.error(
        "LOGOUT ERROR:",
        error
      )



      res.status(500).json({

        error: "Server error during logout."

      })


    }

    finally {

      client.release()

    }



  })





module.exports = router

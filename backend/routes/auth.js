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
  const trimmedPhone = String(phone).trim()

                                                                                                // what is this regex doing? /^[0-9+\-\s()]{7,20}$/  --> matches a string that contains only digits, +, -, whitespace, and parentheses, and is between 7 and 20 characters long
  if (!trimmedName || trimmedName.length > 100 || !trimmedEmail || trimmedEmail.length > 100 || !/^[0-9+\-\s()]{7,20}$/.test(trimmedPhone)) {
    return res.status(400).json({
      error: 'All fields are required.'
    })
  }


  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 
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
      role
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


    await client.query('COMMIT')


    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET missing")
    }


    const jti = crypto.randomBytes(16).toString('hex')
    // 16 means 16 bytes, which is 128 bits. This is a common size for unique identifiers and provides a very low probability of collision.

    const token = jwt.sign(

      {
        id: user.id,
        email: user.email,
        role: user.role,
        jti
      },

      process.env.JWT_SECRET,

      {
        expiresIn: '7d'
      }

    )


    res.status(201).json({

      token,
      user

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

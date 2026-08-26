const express = require('express')
const bcrypt = require('bcryptjs') // pull out the downloaded password hashing rulebooks
const jwt = require('jsonwebtoken') // pull our jwt rulebook
const pool = require('../db/pool') // access the pool of db connections

const router = express.Router()

// ============================================================
// SIGNUP
// POST /api/auth/signup
// ============================================================
router.post('/signup', async (req, res) => {
  const { name, email, password, role, phone } = req.body

  if (!name || !email || !password || !role || !phone) {
    return res.status(400).json({
      error: 'All fields are required.'
    })
  }

  const allowedRoles = [
    'customer',
    'restaurant_owner',
    'rider' // no admin cause 
  ]

  if (!allowedRoles.includes(role)) {
    return res.status(400).json({
      error: 'Invalid role.'
    })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1', // SQL injection prevention
      [email]
    )

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK')

      return res.status(409).json({
        error: 'Email already registered.'
      })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const result = await client.query(
      `
        INSERT INTO users
          (name, email, password, role, phone)
        VALUES
          ($1, $2, $3, $4, $5)
        RETURNING
          id,
          name,
          email,
          role
      `,
      [
        name,
        email,
        hashedPassword,
        role,
        phone
      ]
    )

    const user = result.rows[0]

    if (role === 'rider') {
      await client.query(
        `
          INSERT INTO rider_profiles
            (user_id, vehicle_type, status)
          VALUES
            ($1, $2, $3)
        `,
        [
          user.id,
          null,
          'offline'
        ]
      )
    }

    await client.query('COMMIT')

    const token = jwt.sign( // *****
      {
        id: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d'
      }
    )

    res.status(201).json({ // **** is this accesible by other routes/files? or is this sent straight to frontend?
      token,
      user
    })

  } catch (error) {
    await client.query('ROLLBACK')

    console.error('Signup error:', error)

    res.status(500).json({
      error: 'Server error during signup.'
    })

  } finally {
    client.release()
  }
})


// ============================================================
// LOGIN
// POST /api/auth/login
// ============================================================
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({
      error: 'Email and password are required.'
    })
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: 'Invalid email or password.'
      })
    }

    const user = result.rows[0]

    const validPassword = await bcrypt.compare(
      password,
      user.password
    )

    if (!validPassword) {
      return res.status(401).json({
        error: 'Invalid email or password.'
      })
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role
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

  } catch (error) {
    console.error('Login error:', error)

    res.status(500).json({
      error: 'Server error during login.'
    })
  }
})

module.exports = router
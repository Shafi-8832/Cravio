const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const pool = require('../db/pool')

const router = express.Router()

// ─── SIGNUP ────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { name, email, password, role, phone } = req.body

  const client = await pool.connect();

  // basic validation
  if (!name || !email || !password || !role || !phone) {
    return res.status(400).json({ error: 'All fields are required.' })
  }

  const allowedRoles = ['customer', 'restaurant_owner', 'rider', 'admin']
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' })
  }

  try {
    // check if email already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    )
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' })
    }

    // hash the password (10 = salt rounds, higher = slower but safer)
    const hashedPassword = await bcrypt.hash(password, 10)

    // insert into database
    const result = await pool.query(
      `INSERT INTO users (name, email, password, role, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role`,
      [name, email, hashedPassword, role, phone] 
    )

    const user = result.rows[0]
    if (role == 'rider') {
        await pool.query(
            'INSERT INTO rider_profiles (user_id, vehicle_type, status) VALUES ($1, $2, $3)',
            [user.id, 'bicycle', 'offline'] // default stats
        )
    }

    // create JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    res.status(201).json({ token, user })

  } catch (error) {
    console.error('Signup error:', error)
    res.status(500).json({ error: 'Server error during signup.' })
  }
})

// ─── LOGIN ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  try {
    // find user by email
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const user = result.rows[0];

    // compare submitted password with stored hash
    const validPassword = await bcrypt.compare(password, user.password)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' }) // keep it generic, don't tell the hacker whether it is the password or the email that went wrong
    }

    // create JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    // never send the password back, even hashed
    const { password: _, ...userWithoutPassword } = user

    res.json({ token, user: userWithoutPassword })

  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'Server error during login.' })
  }
})

module.exports = router
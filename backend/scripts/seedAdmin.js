// ============================================================
// SEED ADMIN
// Run once after db/schema.sql has been applied:
//   npm run seed:admin
//
// There is no public /api/auth/signup route for the admin role — see the
// comment in routes/auth.js. This script is the intended way to create the
// platform's first (and any additional) admin account, using the same
// bcrypt hashing as normal signup so it's stored no differently.
//
// Configure via .env. ADMIN_EMAIL and ADMIN_PASSWORD are required:
//   ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PHONE
// ============================================================

require('dotenv').config()
const bcrypt = require('bcryptjs')
const pool = require('../db/pool')

const run = async () => {
  const name = process.env.ADMIN_NAME || 'Platform Admin'
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD || ''
  const phone = process.env.ADMIN_PHONE || null

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 100 ||
      password.length < 12 || Buffer.byteLength(password, 'utf8') > 72 ||
      /^(ChangeMe123!|password123|replace-me|change-me)$/i.test(password)) {
    console.error('Set a valid ADMIN_EMAIL and a unique ADMIN_PASSWORD (12+ characters; at most 72 UTF-8 bytes). No default admin password is supported.')
    process.exitCode = 1
    await pool.end()
    return
  }

  try {
    const existing = await pool.query(
      'SELECT id, role FROM users WHERE email = $1',
      [email]
    )

    if (existing.rows.length > 0) {
      console.log(`A user with email "${email}" already exists (role: ${existing.rows[0].role}). Nothing to do.`)
      return
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const result = await pool.query(
      `
        INSERT INTO users
          (name, email, password, role, phone, is_active)
        VALUES
          ($1, $2, $3, 'admin', $4, true)
        RETURNING id, name, email, role, created_at
      `,
      [name, email, hashedPassword, phone]
    )

    console.log('Admin account created:')
    console.log(result.rows[0])
    console.log(`\nLog in with email "${email}" and the password you set in ADMIN_PASSWORD.`)

  } catch (error) {
    console.error('Failed to seed admin account:', error)
    process.exitCode = 1

  } finally {
    await pool.end()
  }
}

run()

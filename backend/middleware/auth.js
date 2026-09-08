const jwt = require('jsonwebtoken')
const pool = require('../db/pool') // access the pool of db connections

// jwt is stateless, meaning the server never needs to check DB to validate token
// the server only does mathematical operations to verify the token's signature and expiration date
// it doesn't need to lookup the user in the database, which makes it fast and efficient
// adding a blocklist is semistateful

const authenticateToken = async (req, res, next) => {
  // Read the Authorization header sent from Postman/frontend
  const authHeader = req.headers.authorization

  // We expect:
  // Authorization: Bearer eyJhbGciOi...
  if (!authHeader) {
    return res.status(401).json({
      error: 'Access token required.'
    })
  }

  const parts = authHeader.split(' ')

  // Header must have exactly:
  // Bearer TOKEN
  if (
    parts.length !== 2 ||
    parts[0] !== 'Bearer'
  ) {
    return res.status(401).json({
      error: 'Invalid authorization format.'
    })
  }

  const token = parts[1]

  try {
    // Verify token using the same secret used during login
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    // One combined query: is this token revoked, and is the account still active?
    // Checking is_active here (not just at login) means an admin suspending a
    // user takes effect on their very next request, not just their next login.
    const statusCheck = await pool.query(
      `
        SELECT
          u.is_active,
          rt.id AS revoked_id
        FROM users u
        LEFT JOIN revoked_tokens rt
          ON rt.jti = $1
        WHERE u.id = $2
      `,
      [decoded.jti, decoded.id]
    )

    if (statusCheck.rows.length === 0) {
      return res.status(401).json({ error: 'User account no longer exists.' })
    }

    if (statusCheck.rows[0].revoked_id) {
      return res.status(401).json({ error : "Token has been revoked. Please log in again."})
    }

    if (!statusCheck.rows[0].is_active) {
      return res.status(403).json({ error: 'Your account has been suspended. Contact support.' })
    }

    // VERY IMPORTANT:
    // Make logged-in user's data available to later middleware **

    req.user = decoded // creating a user field on the request object, basically attaching the authenticated user's info to the request object so that it can be accessed in subsequent middleware or route handlers

    console.log('Authenticated user:', req.user)

    // Continue to roleCheck and then the actual route
    next()

  } catch (error) {
    console.error('JWT verification error:', error.message)

    return res.status(403).json({
      error: 'Invalid or expired token.'
    })
  }
}

module.exports = authenticateToken
const jwt = require('jsonwebtoken')

const authenticateToken = (req, res, next) => {
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

    // VERY IMPORTANT:
    // Make logged-in user's data available to later middleware
    req.user = decoded

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
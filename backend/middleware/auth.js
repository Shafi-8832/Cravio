const jwt = require('jsonwebtoken')
const pool = require('../db/pool')

// A valid signature identifies a session. Database values decide present access.
const authenticateToken = async (req, res, next) => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')
  if (!match) return res.status(401).json({ error: 'Access token required.' })
  let decoded
  try {
    decoded = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] })
    if (!Number.isInteger(decoded.id) || typeof decoded.jti !== 'string' || !decoded.jti || !decoded.exp) {
      return res.status(401).json({ error: 'Invalid session. Please log in again.' })
    }
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' })
  }
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.role, u.is_active, rt.id AS revoked_id
      FROM users u LEFT JOIN revoked_tokens rt ON rt.jti=$1 WHERE u.id=$2
    `, [decoded.jti, decoded.id])
    const user = result.rows[0]
    if (!user || user.revoked_id) return res.status(401).json({ error: 'Session ended. Please log in again.' })
    if (!user.is_active) return res.status(403).json({ error: 'Your account has been suspended. Contact support.' })
    req.user = { id: user.id, email: user.email, role: user.role, jti: decoded.jti, exp: decoded.exp }
    next()
  } catch (error) {
    // Database outages are service errors, not wrong-password errors.
    next(error)
  }
}
module.exports = authenticateToken

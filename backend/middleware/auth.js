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

    // inner join korle ami just shei user gulai pabo jader token revoked hoise
    // but LEFT join korle ami shob user pabo
    // jader token revoked hoy nai tader column NULL thakbe
    // so user info o pacchi (middle ware naile ki attach korbe?) & jantesi o je token revoked kina

    const user = result.rows[0]

    if (!user || user.revoked_id) return res.status(401).json({ error: 'Session ended. Please log in again.' })

    if (!user.is_active) return res.status(403).json({ error: 'Your account has been suspended. Contact support.' })

    req.user = { id: user.id, email: user.email, role: user.role, jti: decoded.jti, exp: decoded.exp }
    // the single most important line in this entire file. This is what allows the rest of the application to know who the user is and what their role is. Without this line, the user would be authenticated but the application would have no way of knowing who they are or what they can do.
    // this is line where middleware actually attaches the user object to the HTTP request object
    // so that the server knows who exactly is this making the HTTP request


    next()
  } catch (error) {
    // Database outages are service errors, not wrong-password errors.
    next(error)
  }
}
module.exports = authenticateToken // make the function PUBLIC

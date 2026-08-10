// authennticate token --> 
// Is the user logged in? -->
//  required role(..)--> 
// is the logged in user allowed

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Not authenticated.'
      })
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}`
      })
    }

    next()
  }
}

module.exports = requireRole
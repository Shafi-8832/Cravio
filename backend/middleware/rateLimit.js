// Single-process development limiter. Multi-instance production deployments
// need a shared limiter at the gateway or a shared store.
module.exports = function rateLimit({ limit = 30, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map()
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [key, record] of attempts) if (record.resetAt <= now) attempts.delete(key)
  }, 60000)
  cleanup.unref()
  return (req, res, next) => {
    const now = Date.now()
    const key = req.ip
    let record = attempts.get(key)
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + windowMs }
      attempts.set(key, record)
    }
    record.count++
    if (record.count > limit) {
      res.set('Retry-After', String(Math.ceil((record.resetAt - now) / 1000)))
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' })
    }
    next()
  }
}

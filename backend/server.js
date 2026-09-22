const express = require('express')
const cors = require('cors') // ?
require('dotenv').config() // ?

// Fail fast instead of per-request. Without JWT_SECRET, jwt.sign() throws
// inside every login and jwt.verify() inside every authenticated request,
// so the app "starts" fine and then 500s on everything — a much harder
// problem to diagnose than refusing to boot.
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

const pool = require('./db/pool')
const path = require('path')
const rateLimit = require('./middleware/rateLimit')

const authRoutes = require('./routes/auth')
const restaurantRoutes = require('./routes/restaurants')

const cartRoutes = require('./routes/cart')

const menuRoutes = require('./routes/menu') // Menu Routes
const orderRoutes = require('./routes/orders') // Order Routes
const riderRoutes = require('./routes/rider') // Rider Routes
const adminRoutes = require('./routes/admin') // Admin Routes
const paymentRoutes = require('./routes/payments') // Payment Routes
const reviewRoutes = require('./routes/reviews') // Review Routes

const app = express()
const PORT = process.env.PORT || 8000

app.disable('x-powered-by')
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim())
app.use(cors({ origin(origin, callback) {
  // Command-line clients have no Origin header. Browsers must match configuration.
  callback(null, !origin || allowedOrigins.includes(origin))
} }))
app.use(express.json({ limit: '100kb' }))
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})
app.use('/media', express.static(path.join(__dirname, 'data/images'), { maxAge: '1d' }))
const loginLimiter = rateLimit({ limit: 30 })
app.use('/api/auth/login', loginLimiter)
app.use('/api/auth/signup', loginLimiter)

/* Routes
if URL starts with '/api/auth', then leave the rest to 'authRoutes' function
'/api/auth' is a relative path

Express doesn't care about your domain name (like google.com or localhost:5000). 
It only cares about the path after the domain name.

The front part of the URL (the domain/host and port) is determined by where your server is running, 
not by your Express code. */

app.use('/api/auth', authRoutes)
app.use('/api/restaurants', restaurantRoutes)
app.use('/api/menu', menuRoutes)
app.use('/api/cart', cartRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/rider', riderRoutes)
app.use('/api/admin/analytics', require('./routes/adminAnalytics'))
app.use('/api/admin', adminRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/reviews', reviewRoutes)
app.use('/api/account', require('./routes/account'))
app.use('/api/profile', require('./routes/profile'))
app.use('/api/owner', require('./routes/owner'))
app.use('/api/operations', require('./routes/operations'))
app.use('/api/directory', require('./routes/directory'))

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1')
  res.json({ status: 'ok', database: 'connected', manual_payments_enabled: process.env.ALLOW_MANUAL_PAYMENTS === 'true' })
})

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Cravio API is running'
  })
})

app.use((req, res) => res.status(404).json({ error: 'API route not found.' }))
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' })
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' })
  console.error('Request failed:', error.code || error.message)
  res.status(500).json({ error: 'Server error. Please try again.', code: 'INTERNAL_SERVER_ERROR' })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
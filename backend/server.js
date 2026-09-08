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

require('./db/pool')

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

app.use(cors())
app.use(express.json())

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
app.use('/api/admin', adminRoutes)
app.use('/api/payments', paymentRoutes)
app.use('/api/reviews', reviewRoutes)

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Cravio API is running'
  })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
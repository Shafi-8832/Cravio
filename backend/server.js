const express = require('express')
const cors = require('cors') // ? 
require('dotenv').config() // ?
require('./db/pool')

const authRoutes = require('./routes/auth')
const restaurantRoutes = require('./routes/restaurants')

const cartRoutes = require('./routes/cart')

const menuRoutes = require('./routes/menu') // Menu Routes
const orderRoutes = require('./routes/orders') // Order Routes

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

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Cravio API is running'
  })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
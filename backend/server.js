const express = require('express')
const cors = require('cors')
require('dotenv').config()
require('./db/pool')

const authRoutes = require('./routes/auth')
const restaurantRoutes = require('./routes/restaurants')

const menuRoutes = require('./routes/menu') // Menu Routes

const app = express()
const PORT = process.env.PORT || 8000

app.use(cors())
app.use(express.json())

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/restaurants', restaurantRoutes)
app.use('/api/menu', menuRoutes)

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Cravio API is running'
  })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
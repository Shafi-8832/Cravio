const express = require('express')
const cors = require('cors')
require('dotenv').config()
require('./db/pool')

const authRoutes = require('./routes/auth')

const app = express()
const PORT = process.env.PORT || 8000
.
app.use(cors())
app.use(express.json())

// all auth routes will be prefixed with /api/auth
app.use('/api/auth', authRoutes)

app.get('/', (req, res) => {
  res.json({ message: 'Cravio API is running' })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
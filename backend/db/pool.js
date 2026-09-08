const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

// This is just a startup connectivity check, not a connection we intend to
// use — release it immediately or it permanently holds one client out of
// the pool for the lifetime of the process.
pool.connect()
  .then(client => {
    console.log('PostgreSQL connected')
    client.release()
  })
  .catch(err => console.error('PostgreSQL connection error:', err))

module.exports = pool
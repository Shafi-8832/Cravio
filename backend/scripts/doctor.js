// Checks configuration without printing credentials or changing the database.
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true })
const { Pool } = require('pg')

async function doctor() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing from backend/.env.')
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET to a random string of at least 32 characters.')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
  try {
    await pool.query('SELECT 1')
    console.log('PASS PostgreSQL connection')
    const result = await pool.query(`SELECT to_regclass('public.users') AS users,
      to_regclass('public.schema_migrations') AS migrations,
      to_regprocedure('public.place_order(integer,integer,text,character varying,character varying)') AS checkout`)
    if (Object.values(result.rows[0]).some(value => !value)) throw new Error('Database setup is incomplete. Run npm run db:migrate.')
    console.log('PASS Base tables, migration ledger and checkout function')
    const migrations = await pool.query('SELECT name FROM schema_migrations ORDER BY name')
    migrations.rows.forEach(row => console.log(`PASS ${row.name}`))
    console.log('Configuration ready. Start the API with npm run dev:api.')
  } finally {
    await pool.end()
  }
}
doctor().catch(error => {
  console.error(`CHECK FAILED: ${error.message}`)
  process.exitCode = 1
})

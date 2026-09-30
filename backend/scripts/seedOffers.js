// (Re)creates the demo item offers in backend/db/seeds/demo_item_offers.sql.
// Offer times are relative to "now", so run this again before a demo to get
// fresh countdowns. Only the demo dishes' own offers are replaced.
const fs = require('node:fs/promises')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true })
const { Pool } = require('pg')

async function seedOffers() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in backend/.env first.')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
  const client = await pool.connect()
  try {
    const sql = await fs.readFile(path.join(__dirname, '../db/seeds/demo_item_offers.sql'), 'utf8')
    // One transaction: the DELETE and the INSERT succeed together or not at all.
    await client.query('BEGIN')
    await client.query(sql)
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM item_offers) AS total_offers,
        (SELECT COUNT(*)::int FROM active_item_offers) AS active_now
    `)
    await client.query('COMMIT')
    console.log(`Demo offers ready: ${counts.rows[0].total_offers} offers, ${counts.rows[0].active_now} running now.`)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

seedOffers().catch(error => {
  console.error(`Seeding offers failed: ${error.message}`)
  process.exitCode = 1
})

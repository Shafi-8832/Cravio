// ============================================================
// GIVE EVERY RESTAURANT NATIONAL COVERAGE
//   node scripts/expandBranches.js --check
//   node scripts/expandBranches.js --apply
//
// Restaurants that come from a catalog file get their full branch list at
// import time. The five sample restaurants seeded by scripts/seed.js do
// not — they were written with one or two Dhaka outlets — so a customer
// browsing from Sylhet sees nothing to order from.
//
// This tops any restaurant up to one outlet per division, leaving whatever
// branches already exist untouched. It matches on address, the same
// natural key importCatalog.js uses, so running it twice inserts nothing.
// ============================================================

require('dotenv').config()
const pool = require('../db/pool')
const { DIVISION_AREAS, addressFor } = require('./divisionBranches')

// Delivery terms are copied from a branch the restaurant already has, so a
// topped-up outlet charges what that restaurant charges rather than some
// number invented here.
async function expandBranches(client, apply) {
  const added = []

  const restaurants = await client.query('SELECT id, name FROM restaurants ORDER BY id')

  for (const restaurant of restaurants.rows) {
    const existing = await client.query(
      `SELECT division, delivery_fee, min_order_amount, eta_min, eta_max
       FROM restaurant_branches WHERE restaurant_id = $1 ORDER BY id`,
      [restaurant.id]
    )
    if (existing.rows.length === 0) continue

    const covered = new Set(existing.rows.map(branch => branch.division))
    const terms = existing.rows[0]

    for (const entry of DIVISION_AREAS) {
      if (covered.has(entry.division)) continue

      const area = entry.areas[0]
      const address = addressFor(restaurant.name, area, entry.city)

      if (apply) {
        await client.query(
          `INSERT INTO restaurant_branches
             (restaurant_id, address, area, city, division, is_open,
              delivery_fee, min_order_amount, eta_min, eta_max)
           SELECT $1, $2, $3, $4, $5, true, $6, $7, $8, $9
           WHERE NOT EXISTS (
             SELECT 1 FROM restaurant_branches
             WHERE restaurant_id = $1 AND address = $2
           )`,
          [restaurant.id, address, area, entry.city, entry.division,
            terms.delivery_fee, terms.min_order_amount, terms.eta_min, terms.eta_max]
        )
      }
      added.push(`${restaurant.name} → ${entry.division}`)
    }
  }

  return added
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--check', '--apply'].includes(arg))) throw new Error('Use --check or --apply.')
  const apply = args.includes('--apply')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const added = await expandBranches(client, apply)
    await client.query('COMMIT')
    console.log(`${apply ? 'Added' : 'Would add'} ${added.length} branches`)
    for (const entry of added) console.log('  ' + entry)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })

module.exports = { expandBranches }

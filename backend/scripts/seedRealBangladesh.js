// ============================================================
// IMPORT THE FOUR SOURCED BRANDS
//   npm --prefix backend run catalog:real:check   (validate only)
//   npm run seed:real                             (validate + import)
//
// The four official-*.json snapshots publish one record per outlet.
// buildBrandCatalog.js folds each brand's outlets back into a single
// restaurant with many branches — see the long comment at the top of
// that file for why — and this script imports the result.
//
// Each brand needs a restaurant_owner account before it can be
// imported, because importCatalog.js refuses to enable ordering on a
// restaurant nobody owns. Those accounts are created here first.
//
// IDEMPOTENT: accounts are inserted only when missing and existing
// passwords are never reset; the catalog import only inserts rows it
// cannot already find. Re-running changes nothing.
// ============================================================

require('dotenv').config()
const bcrypt = require('bcryptjs')
const { importCatalog, validateCatalog } = require('./importCatalog')
const { BRANDS, buildBrandCatalog } = require('./buildBrandCatalog')
const { ADDED_OWNERS, buildAddedRestaurants } = require('./buildAddedRestaurants')
const { backfillPhotos } = require('./backfillPhotos')
const { expandBranches } = require('./expandBranches')

// Same rule the real /api/auth/signup route applies, so these accounts
// can log in through the normal login form like any other owner.
const OWNER_PASSWORD = process.env.BRAND_OWNER_PASSWORD || process.env.DEMO_PASSWORD || ''

// The account rows are created without the person's knowledge, so they
// exist only to demonstrate the owner side locally. Creating logins on a
// production database is not something a catalog import should do.
async function ensureBrandOwners(client) {
  let created = 0
  const hash = await bcrypt.hash(OWNER_PASSWORD, 10)

  const owners = [...BRANDS.map(brand => brand.owner), ...ADDED_OWNERS]

  for (const owner of owners) {
    // Lower-cased comparison because users.email is unique but not
    // case-folded, so 'Owner.KFC@…' and 'owner.kfc@…' would both insert.
    const existing = await client.query(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [owner.email]
    )

    if (existing.rows.length > 0) continue

    await client.query(
      `INSERT INTO users (name, email, password, role, phone, is_active)
       VALUES ($1, $2, $3, 'restaurant_owner', $4, true)`,
      [owner.name, owner.email, hash, owner.phone]
    )
    created++
  }

  return created
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--check', '--apply'].includes(arg))) throw new Error('Use --check or --apply.')

  const catalogs = [buildBrandCatalog(), buildAddedRestaurants()]
  const catalog = { schema_version: 1, restaurants: catalogs.flatMap(entry => entry.restaurants) }
  console.log('Full catalog:', validateCatalog(catalog))
  for (const restaurant of catalog.restaurants) {
    console.log(
      `  ${restaurant.name}: ${restaurant.branches.length} branches, ` +
      `${restaurant.categories.length} categories, ` +
      `${restaurant.categories.reduce((total, category) => total + category.items.length, 0)} menu items`
    )
  }

  if (!args.includes('--apply')) {
    console.log('Checked only. Add --apply to import.')
    return
  }

  if (process.env.NODE_ENV === 'production') throw new Error('This import creates owner logins; do not run it in production.')
  if (OWNER_PASSWORD.length < 8 || Buffer.byteLength(OWNER_PASSWORD, 'utf8') > 72) {
    throw new Error('Set BRAND_OWNER_PASSWORD (or DEMO_PASSWORD) in backend/.env to 8+ characters, at most 72 UTF-8 bytes.')
  }

  const pool = require('../db/pool')
  const client = await pool.connect()

  try {
    // One transaction for both steps: a brand whose owner account was
    // created but whose menu failed to import would leave an orphan login.
    await client.query('BEGIN')
    const owners = await ensureBrandOwners(client)
    const stats = await importCatalog(client, catalog)

    // Same transaction, so a menu is never committed half-photographed.
    // This also covers the older sample restaurants, which were seeded
    // before menu photos existed.
    const photos = await backfillPhotos(client, true)

    // The older sample restaurants were seeded with one or two Dhaka
    // outlets, so they are topped up to cover every division too.
    const branches = await expandBranches(client, true)
    await client.query('COMMIT')

    console.log('Owner accounts created:', owners)
    console.log('Imported new rows:', stats)
    console.log('Stand-in photos attached:', photos.filled)
    console.log('Branches added for national coverage:', branches.length)
    console.log('Existing menus, prices, accounts and ordering permissions were preserved.')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })

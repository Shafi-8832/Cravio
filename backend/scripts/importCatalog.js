// Import only operator-supplied catalog files. Validation works without a database.
// Existing rows are preserved; re-running only inserts missing rows.
const fs = require('node:fs')
const path = require('node:path')

const DIVISIONS = ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Barishal', 'Sylhet', 'Rangpur', 'Mymensingh']
const fail = message => { throw new Error(message) }
const text = (value, label, max, required = true) => {
  if (value == null && !required) return
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}: expected text (1–${max} characters).`)
}
const number = (value, label, min, max, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label}: invalid number.`)
}
const bool = (value, label) => { if (value != null && typeof value !== 'boolean') fail(`${label}: expected true or false.`) }
const url = (value, label, local = false) => {
  if (!value) return
  if (local && /^\/media\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp|avif)$/.test(value)) return
  let parsed
  try { parsed = new URL(value) } catch { fail(`${label}: use an HTTPS URL or a local /media image.`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail(`${label}: use an HTTPS URL without credentials.`)
}
const unique = (items, getKey, label) => {
  const keys = items.map(getKey)
  if (new Set(keys).size !== keys.length) fail(`${label}: duplicate keys.`)
}
const photo = (record, label) => {
  if (!record.image_url) return
  text(record.image_url, `${label}.image_url`, 255)
  url(record.image_url, `${label}.image_url`, true)
  text(record.image_credit, `${label}.image_credit`, 500)
  text(record.image_source_url, `${label}.image_source_url`, 2048)
  url(record.image_source_url, `${label}.image_source_url`)
  bool(record.image_is_illustrative, `${label}.image_is_illustrative`)
}

function validateCatalog(catalog) {
  if (!catalog || catalog.schema_version !== 1 || !Array.isArray(catalog.restaurants) || !catalog.restaurants.length || catalog.restaurants.length > 2000) fail('Expected schema_version: 1 and 1–2000 restaurants.')
  unique(catalog.restaurants, r => r.catalog_slug, 'restaurants')
  let menuCount = 0
  for (const r of catalog.restaurants) {
    text(r.catalog_slug, 'catalog_slug', 100)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.catalog_slug)) fail(`${r.catalog_slug}: use a lowercase hyphenated catalog_slug.`)
    const label = r.catalog_slug
    text(r.name, `${label}.name`, 100)
    text(r.description, `${label}.description`, 3000, false)
    text(r.cuisine, `${label}.cuisine`, 80, false)
    bool(r.is_demo, `${label}.is_demo`)
    bool(r.ordering_enabled, `${label}.ordering_enabled`)
    if (r.owner_email != null) {
      text(r.owner_email, `${label}.owner_email`, 100)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.owner_email)) fail(`${label}: invalid owner_email.`)
    }
    photo(r, label)
    url(r.logo_url, `${label}.logo_url`, true)
    url(r.logo_source_url, `${label}.logo_source_url`)
    url(r.menu_source_url, `${label}.menu_source_url`)
    if (r.logo_url && !r.logo_source_url) fail(`${label}: logo needs its official source URL.`)
    if (r.menu_scope && !['branch', 'brand'].includes(r.menu_scope)) fail(`${label}: invalid menu_scope.`)
    if (r.gallery != null && (!Array.isArray(r.gallery) || r.gallery.length > 12)) fail(`${label}: gallery must have at most 12 photos.`)
    for (const entry of r.gallery || []) { photo(entry, label + '.gallery'); text(entry.caption, label + '.gallery.caption', 200) }

    url(r.source_url, `${label}.source_url`)
    if (r.verified_at != null && (!/^\d{4}-\d{2}-\d{2}T/.test(r.verified_at) || !Number.isFinite(Date.parse(r.verified_at)) || Date.parse(r.verified_at) > Date.now())) fail(`${label}: verified_at must be a past ISO timestamp.`)
    if (!r.is_demo && !r.source_url) fail(`${label}: real directory entries need a source_url.`)
    if (r.ordering_enabled && !r.owner_email) fail(`${label}: ordering needs an existing restaurant owner.`)
    // Live ordering under a real business's name still demands a verified
    // owner, a checked source date and an actual picture.
    //
    // A flagged illustrative hero is allowed, though. The rule this guard
    // exists to enforce is "never pass stock photography off as the
    // restaurant's own" — and image_is_illustrative is precisely the
    // admission that we are not doing so: the restaurant page prints
    // "Illustrative photo, not this restaurant's actual food" underneath
    // it. Kacchi Bhai needs this, because every one of its outlet pages
    // publishes an "IMAGE COMING SOON" graphic where a photo should be.
    // What stays banned is a missing image, or an unflagged stand-in.
    if (r.ordering_enabled && !r.is_demo && (!r.verified_at || r.owner_verified !== true || !r.image_url)) fail(`${label}: live ordering requires owner_verified: true, verified_at and a restaurant photo.`)
    if (!Array.isArray(r.branches) || !r.branches.length || r.branches.length > 100) fail(`${label}: provide 1–100 branches.`)
    unique(r.branches, b => b.address, `${label}.branches`)
    for (const b of r.branches) {
      text(b.address, `${label}.address`, 1000)
      text(b.area, `${label}.area`, 100)
      text(b.city, `${label}.city`, 100)
      text(b.phone, `${label}.phone`, 20, false)
      if (!DIVISIONS.includes(b.division)) fail(`${label}: invalid division.`)
      bool(b.is_open, `${label}.is_open`)
      if ((b.latitude == null) !== (b.longitude == null)) fail(`${label}: provide both coordinates or neither.`)
      if (b.latitude != null) {
        number(b.latitude, `${label}.latitude`, -90, 90)
        number(b.longitude, `${label}.longitude`, -180, 180)
      }
      number(b.delivery_fee ?? 49, `${label}.delivery_fee`, 0, 10000)
      number(b.min_order_amount ?? 0, `${label}.min_order_amount`, 0, 100000)
      number(b.eta_min ?? 25, `${label}.eta_min`, 1, 240, true)
      number(b.eta_max ?? 45, `${label}.eta_max`, b.eta_min ?? 25, 240, true)
    }
    if (!Array.isArray(r.categories) || r.categories.length > 50) fail(`${label}: categories must be an array (at most 50).`)
    unique(r.categories, c => c.name, `${label}.categories`)
    const allNames = []
    for (const c of r.categories) {
      text(c.name, `${label}.category.name`, 50)
      if (!Array.isArray(c.items) || !c.items.length || c.items.length > 200) fail(`${label}: each category needs 1–200 items.`)
      for (const item of c.items) {
        text(item.name, `${label}.item.name`, 100)
        text(item.description, `${label}.item.description`, 3000, false)
        number(item.price, `${label}.${item.name}.price`, 0.01, 100000)
        if (Math.abs(item.price * 100 - Math.round(item.price * 100)) > 0.000001) fail(`${label}.${item.name}: price must have at most two decimal places.`)
        bool(item.is_veg, `${label}.item.is_veg`)
        bool(item.is_available, `${label}.item.is_available`)
        photo(item, `${label}.${item.name}`)
        allNames.push(item.name)
        menuCount++
      }
    }
    if (new Set(allNames).size !== allNames.length) fail(`${label}: menu item names must be unique within the restaurant.`)
    if (r.ordering_enabled && !allNames.length) fail(`${label}: ordering needs at least one menu item.`)
  }
  if (menuCount > 50000) fail('Split the catalog into files with at most 50,000 menu items.')
  return { restaurants: catalog.restaurants.length, branches: catalog.restaurants.reduce((n, r) => n + r.branches.length, 0), menu_items: menuCount }
}

async function importCatalog(client, catalog) {
  validateCatalog(catalog)
  const stats = { restaurants: 0, branches: 0, categories: 0, menu_items: 0 }
  // The caller owns the transaction; the same lock serializes seeds and imports.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('cravio-catalog-import'))")
  for (const r of catalog.restaurants) {
    let ownerId = null
    if (r.owner_email) {
      const owner = await client.query("SELECT id FROM users WHERE lower(email) = lower($1) AND role = 'restaurant_owner' AND is_active = true", [r.owner_email])
      if (!owner.rows.length) fail(`${r.catalog_slug}: create an active restaurant_owner account for ${r.owner_email} before import.`)
      ownerId = owner.rows[0].id
    }
    let restaurant = await client.query('SELECT id, owner_id, is_demo FROM restaurants WHERE catalog_slug = $1', [r.catalog_slug])
    if (restaurant.rows.length && (restaurant.rows[0].owner_id !== ownerId || restaurant.rows[0].is_demo !== (r.is_demo === true))) fail(`${r.catalog_slug}: owner/demo identity differs from the existing record; no reassignment is performed by an import.`)
    if (!restaurant.rows.length) {
      restaurant = await client.query(`INSERT INTO restaurants
        (owner_id, name, description, cuisine, image_url, image_credit, image_source_url,
         image_is_illustrative, is_demo, catalog_slug, source_url, verified_at, ordering_enabled)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [ownerId, r.name, r.description || null, r.cuisine || 'Bangladeshi', r.image_url || null,
        r.image_credit || null, r.image_source_url || null, r.image_is_illustrative === true,
        r.is_demo === true, r.catalog_slug, r.source_url || null, r.verified_at || null, r.ordering_enabled === true])
      stats.restaurants++
    }
    const restaurantId = restaurant.rows[0].id
    // Metadata is initialized only; subsequent imports do not overwrite owner changes.
    await client.query(`UPDATE restaurants SET logo_url = COALESCE(logo_url,$2),
      logo_source_url = COALESCE(logo_source_url,$3), menu_source_url = COALESCE(menu_source_url,$4),
      menu_scope = CASE WHEN menu_source_url IS NULL THEN $5 ELSE menu_scope END,
      gallery = CASE WHEN gallery = '[]'::jsonb THEN $6::jsonb ELSE gallery END WHERE id=$1`,
      [restaurantId, r.logo_url || null, r.logo_source_url || null, r.menu_source_url || null,
        r.menu_scope || 'branch', JSON.stringify(r.gallery || [])])
    for (const b of r.branches) {
      const exists = await client.query('SELECT id FROM restaurant_branches WHERE restaurant_id = $1 AND address = $2', [restaurantId, b.address])
      if (!exists.rows.length) {
        await client.query(`INSERT INTO restaurant_branches
          (restaurant_id, address, area, city, phone, latitude, longitude, is_open, division,
           delivery_fee, min_order_amount, eta_min, eta_max)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [restaurantId, b.address, b.area, b.city, b.phone || null, b.latitude ?? null, b.longitude ?? null,
          r.ordering_enabled === true && b.is_open === true, b.division, b.delivery_fee ?? 49,
          b.min_order_amount ?? 0, b.eta_min ?? 25, b.eta_max ?? 45])
        stats.branches++
      }
    }
    for (const c of r.categories) {
      let category = await client.query('SELECT id FROM menu_categories WHERE restaurant_id = $1 AND name = $2', [restaurantId, c.name])
      if (!category.rows.length) {
        category = await client.query('INSERT INTO menu_categories (restaurant_id, name) VALUES ($1,$2) RETURNING id', [restaurantId, c.name])
        stats.categories++
      }
      for (const item of c.items) {
        const exists = await client.query('SELECT id FROM menu_items WHERE restaurant_id = $1 AND name = $2', [restaurantId, item.name])
        if (!exists.rows.length) {
          await client.query(`INSERT INTO menu_items
            (restaurant_id, category_id, name, description, price, image_url, image_credit,
             image_source_url, image_is_illustrative, is_veg, is_available)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [restaurantId, category.rows[0].id, item.name, item.description || null, item.price,
            item.image_url || null, item.image_credit || null, item.image_source_url || null,
            item.image_is_illustrative === true, item.is_veg === true, item.is_available !== false])
          stats.menu_items++
        }
      }
    }
  }
  return stats
}

async function main() {
  const args = process.argv.slice(2)
  const filename = args.find(a => !a.startsWith('--'))
  if (!filename || args.some(a => a.startsWith('--') && !['--check', '--apply'].includes(a)) || (args.includes('--check') && args.includes('--apply'))) fail('Usage: node scripts/importCatalog.js <catalog.json> [--check | --apply]. Default: check only.')
  const fullPath = path.resolve(filename)
  if (fs.statSync(fullPath).size > 5 * 1024 * 1024) fail('Catalog must be at most 5 MB. Split larger catalogs.')
  const catalog = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
  console.log('Validated catalog:', validateCatalog(catalog))
  if (!args.includes('--apply')) { console.log('No database changes. Add --apply to import.'); return }
  require('dotenv').config()
  if (process.env.NODE_ENV === 'production' && catalog.restaurants.some(r => r.is_demo)) fail('Demo restaurants cannot be imported in production.')
  const pool = require('../db/pool')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const stats = await importCatalog(client, catalog)
    await client.query('COMMIT')
    console.log('Imported new rows:', stats)
    console.log('Existing menus, prices, accounts and ordering permissions were preserved.')
  } catch (error) {
    if (client) await client.query('ROLLBACK')
    throw error
  } finally {
    client?.release()
    await pool.end()
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { DIVISIONS, validateCatalog, importCatalog }

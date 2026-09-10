// ============================================================
// BACKFILL MISSING PHOTOGRAPHS
//   node scripts/backfillPhotos.js --check   (report only)
//   node scripts/backfillPhotos.js --apply   (write)
//
// The sample restaurants seeded by scripts/seed.js predate menu photos,
// so their dishes render as an empty-plate placeholder. This attaches an
// illustrative stock photo to any restaurant or dish that still has none,
// using the keyword rules in illustrativePhotos.js.
//
// It only ever fills a hole. A row that already has a photograph — every
// row imported from an official source snapshot — is left untouched by
// the `image_url IS NULL` guard, so a real KFC photo can never be
// overwritten by a stock one.
//
// Everything it writes is flagged image_is_illustrative, which makes the
// menu print "Illustrative photo" beneath the image.
// ============================================================

require('dotenv').config()
const path = require('node:path')
const pool = require('../db/pool')
const { PHOTOS, illustrativePhotoFor } = require('./illustrativePhotos')

async function backfillPhotos(client, apply) {
  const filled = { restaurants: 0, menu_items: 0 }
  const skipped = []

  // A dish is matched on its own name first and its category's name
  // second, so "Margherita" still gets a photo from being filed under
  // "Pizzas". LEFT JOIN because menu_categories.id is ON DELETE SET NULL,
  // meaning a dish can legitimately have no category.
  const items = await client.query(
    `SELECT mi.id, mi.name, COALESCE(mc.name, '') AS category_name
     FROM menu_items mi
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.image_url IS NULL
     ORDER BY mi.id`
  )

  for (const item of items.rows) {
    const photo = illustrativePhotoFor(item.name, item.category_name)
    if (!photo) { skipped.push(`dish: ${item.name}`); continue }

    if (apply) {
      await client.query(
        `UPDATE menu_items
         SET image_url = $2, image_credit = $3, image_source_url = $4, image_is_illustrative = true
         WHERE id = $1 AND image_url IS NULL`,
        [item.id, photo.image_url, photo.image_credit, photo.image_source_url]
      )
    }
    filled.menu_items++
  }

  // Restaurants come second, because the best available hero photo for a
  // restaurant is one of its own dishes — "Chuli Kitchen" and
  // "Wok & Roll" say nothing about the food, but their menus do. Matching
  // the restaurant's name against the keyword list would leave those two
  // with nothing, so this borrows from the menu the loop above just
  // finished filling.
  //
  // Only illustrative dish photos are borrowed. Promoting an official
  // photo of one dish to be the restaurant's hero image would present it
  // as a picture of the restaurant, which it is not.
  const restaurants = await client.query(
    `SELECT r.id, r.name,
       (SELECT mi.image_url FROM menu_items mi
        WHERE mi.restaurant_id = r.id AND mi.image_url IS NOT NULL AND mi.image_is_illustrative = true
        ORDER BY mi.id LIMIT 1) AS menu_photo
     FROM restaurants r
     WHERE r.image_url IS NULL
     ORDER BY r.id`
  )

  for (const restaurant of restaurants.rows) {
    const photo = restaurant.menu_photo
      ? PHOTOS.get(path.basename(restaurant.menu_photo))
      : illustrativePhotoFor(restaurant.name)

    if (!photo) { skipped.push(`restaurant: ${restaurant.name}`); continue }

    if (apply) {
      await client.query(
        `UPDATE restaurants
         SET image_url = $2, image_credit = $3, image_source_url = $4, image_is_illustrative = true
         WHERE id = $1 AND image_url IS NULL`,
        [restaurant.id, photo.image_url, photo.image_credit, photo.image_source_url]
      )
    }
    filled.restaurants++
  }

  return { filled, skipped }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--check', '--apply'].includes(arg))) throw new Error('Use --check or --apply.')
  const apply = args.includes('--apply')

  const client = await pool.connect()
  try {
    // One transaction so a half-photographed menu is never committed.
    await client.query('BEGIN')
    const { filled, skipped } = await backfillPhotos(client, apply)
    await client.query('COMMIT')

    console.log(apply ? 'Photos attached:' : 'Photos that would be attached:', filled)
    if (skipped.length) {
      console.log(`Left without a photo on purpose (${skipped.length}, no sensible match):`)
      for (const entry of skipped) console.log('  ' + entry)
    }
    if (!apply) console.log('No database changes. Add --apply to write.')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

// Also called directly by seedRealBangladesh.js, inside its transaction.
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })

module.exports = { backfillPhotos }

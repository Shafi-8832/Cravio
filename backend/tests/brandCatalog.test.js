// Covers the two things that broke the restaurant page: a catalogue
// whose shape did not match the one restaurant / many branches model,
// and dishes reaching the menu with no usable photograph.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { validateCatalog } = require('../scripts/importCatalog')
const { BRANDS, buildBrandCatalog } = require('../scripts/buildBrandCatalog')
const { illustrativePhotoFor } = require('../scripts/illustrativePhotos')

const catalog = buildBrandCatalog()
const imagePath = url => path.join(__dirname, '../data/images', url.replace('/media/', ''))

test('the four brands merge into one orderable restaurant each, with three branches', () => {
  assert.deepEqual(validateCatalog(catalog), { restaurants: 4, branches: 40, menu_items: 205 })
  assert.deepEqual(catalog.restaurants.map(r => r.name), ['Kacchi Bhai', 'KFC', 'BFC', 'Chillox'])
  // Three real Dhaka outlets each — enough to choose between, not a wall
  // of 47 buttons — plus one per remaining division for national coverage.
  assert.deepEqual(catalog.restaurants.map(r => r.branches.length), [10, 10, 10, 10])
  for (const restaurant of catalog.restaurants) {
    assert.ok(restaurant.branches.some(b => b.area === 'Khilgaon'), restaurant.name + ' lost its Khilgaon branch')
    assert.equal(new Set(restaurant.branches.map(b => b.division)).size, 8, restaurant.name + ' does not cover all divisions')
    assert.equal(restaurant.branches.filter(b => b.division === 'Dhaka').length, 3)
  }

  // The per-outlet snapshots total 139 restaurants; the whole point of
  // the merge is that the customer sees 4.
  assert.equal(new Set(catalog.restaurants.map(r => r.catalog_slug)).size, 4)

  for (const restaurant of catalog.restaurants) {
    // Every branch address must be distinct: importCatalog.js matches an
    // existing branch on address, so a duplicate would silently collapse
    // two real outlets into one on re-import.
    const addresses = restaurant.branches.map(b => b.address)
    assert.equal(new Set(addresses).size, addresses.length, restaurant.name + ' has duplicate branch addresses')

    // A brand imported closed or unavailable would appear and then
    // refuse every order — the snapshots ship that way by default.
    assert.equal(restaurant.ordering_enabled, true)
    assert.ok(restaurant.branches.every(b => b.is_open))
    assert.ok(restaurant.categories.flatMap(c => c.items).every(i => i.is_available))

    assert.ok(restaurant.source_url.startsWith('https://'), restaurant.name + ' lost its source link')
    assert.ok(restaurant.owner_email, restaurant.name + ' needs an owner to enable ordering')
  }

  assert.deepEqual(
    catalog.restaurants.map(r => r.owner_email),
    BRANDS.map(b => b.owner.email)
  )
})

test('every photograph the merged catalogue points at exists on disk', () => {
  for (const restaurant of catalog.restaurants) {
    const records = [restaurant, ...restaurant.gallery, ...restaurant.categories.flatMap(c => c.items)]
    for (const record of records) {
      if (!record.image_url) continue
      assert.ok(fs.statSync(imagePath(record.image_url)).size > 100, record.image_url + ' is missing or empty')
      assert.ok(record.image_source_url.startsWith('https://'), record.image_url + ' lost its source link')
      assert.ok(record.image_credit, record.image_url + ' lost its credit')
    }
    assert.ok(fs.statSync(imagePath(restaurant.logo_url)).size > 100)
  }
})

test('a stand-in photo is always flagged illustrative, and never enters a gallery', () => {
  const items = catalog.restaurants.flatMap(r => r.categories.flatMap(c => c.items))
  const standIns = items.filter(item => item.image_url && item.image_url.startsWith('/media/') && !item.image_url.includes('official-'))

  assert.ok(standIns.length > 0, 'expected BFC/Chillox dishes to need a stand-in')
  for (const item of standIns) assert.equal(item.image_is_illustrative, true, item.name + ' is a stock photo pretending to be authentic')

  // A gallery reads as "here is this restaurant", so a stock photo has no
  // business in one even when flagged.
  for (const restaurant of catalog.restaurants) {
    for (const photo of restaurant.gallery) assert.equal(photo.image_is_illustrative, false)
  }
})

test('a keyword must start a word, so "Yard Classic" is not a lassi', () => {
  // The real bug: l-a-s-s-i sits inside "C(lassi)c", so a burger was
  // served with a photograph of a drink.
  assert.equal(illustrativePhotoFor('Yard Classic', 'Burgers').image_url, '/media/burger.jpg')

  // Matching only at the front of a word must still allow suffixes.
  assert.equal(illustrativePhotoFor('200ml Drinks', 'BEVERAGE').image_url, '/media/tea.jpg')
  assert.equal(illustrativePhotoFor('Naga Wings', 'CHICKEN WINGS').image_url, '/media/fries.jpg')

  // The dish name wins over its category, and the category is the
  // fallback when the name says nothing.
  assert.equal(illustrativePhotoFor('Oreo Shake', 'Fries & Shakes').image_url, '/media/tea.jpg')
  assert.equal(illustrativePhotoFor('Margherita', 'Pizzas').image_url, '/media/pizza.jpg')

  // Something that is not a dish gets an honest placeholder instead of a
  // stock picture of food it is not.
  assert.equal(illustrativePhotoFor('Delivery charge', 'SIDE MENU'), null)
  assert.equal(illustrativePhotoFor('BBQ DIP', 'SIDE MENU'), null)
})

test('Kacchi Bhai never ships the "IMAGE COMING SOON" graphic', () => {
  const placeholder = '/media/official-Kacchi-Bhai-fc0e8ce800cb.avif'
  const kacchi = catalog.restaurants.find(r => r.name === 'Kacchi Bhai')

  // Every one of its 47 outlet pages publishes this graphic where a photo
  // should be, so it reached the database as the brand's hero image.
  assert.notEqual(kacchi.image_url, placeholder)
  assert.ok(kacchi.image_url, 'Kacchi Bhai still needs some hero image')
  assert.ok(kacchi.gallery.every(photo => photo.image_url !== placeholder))

  // The stand-in is a photo of the dish, and says so.
  assert.equal(kacchi.image_is_illustrative, true)
  assert.ok(kacchi.image_credit)

  for (const restaurant of catalog.restaurants) {
    assert.ok(restaurant.categories.flatMap(c => c.items).every(i => i.image_url !== placeholder))
  }
})

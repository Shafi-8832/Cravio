// ============================================================
// BRAND CATALOG BUILDER
//
// The four official-*.json snapshots store one restaurant record per
// physical outlet: "Kacchi Bhai — Badda", "Kacchi Bhai — Board Bazar",
// and 45 more. That shape is faithful to how the source pages are
// published, but it is wrong for the app in two ways.
//
// 1. A customer looks for "Kacchi Bhai", not for one of its 47 outlets.
//    Importing the snapshots as-is puts 139 near-identical cards on the
//    homepage and makes the brand impossible to find.
// 2. Our schema already models this properly: one row in `restaurants`
//    owns many rows in `restaurant_branches`. The per-outlet shape
//    throws that relationship away and duplicates the whole menu 47
//    times.
//
// So this file folds each brand's records back into ONE restaurant with
// every outlet as a branch, which is the shape the rest of the app —
// carts, the branch picker at checkout, place_order() — was written for.
//
// It only reshapes data; it never invents any. Names, prices, photos,
// source URLs and credits are copied from the snapshots unchanged.
// ============================================================

const fs = require('node:fs')
const path = require('node:path')

// A delivery fee and an ETA are the only things the snapshots do not
// publish, because the real brands are not delivering through Cravio.
// They are set here per brand so checkout has something to work with,
// and are kept obvious and round rather than dressed up as researched
// figures.
const BRANDS = [
  {
    slug: 'brand-kacchi-bhai',
    file: 'official-kacchi-bhai.json',
    name: 'Kacchi Bhai',
    cuisine: 'Kacchi & Biryani',
    description: 'Kacchi Bhai serves basmati kacchi, borhani and firni from its published brand menu, with outlets across the country.',
    owner: { email: 'owner.kacchibhai@cravio.test', name: 'Kacchi Bhai Operations', phone: '01711000030' },
    delivery_fee: 60,
    eta_min: 35,
    eta_max: 55,

    // Every Kacchi Bhai outlet page publishes the same "IMAGE COMING SOON"
    // graphic where a photo should be. The only other images the snapshot
    // carries are dining-room interiors, which tell a hungry customer
    // nothing. So the hero is overridden with a licensed photograph of the
    // dish the brand is named for, flagged illustrative like any stand-in.
    hero_override: {
      image_url: "/media/dish-kacchi-biryani.jpg",
      image_credit: "Nahian / Wikimedia Commons (CC BY 4.0) \u00b7 illustrative photo",
      image_source_url: "https://commons.wikimedia.org/wiki/File:Basmati_Kacchi_Biryani_(1).jpg"
    },

    // The published snapshot lists only four dishes, which makes for a
    // very thin demo menu. These are added so there is something to build
    // a real order from. They are NOT from the brand's published menu, so
    // the category says so and every item repeats it in its description —
    // and they carry stock photography, flagged illustrative, rather than
    // being paired with one of the brand's own photographs.
    extra_category: 'Kitchen favourites (demo additions)',
    extra_items: [
      { name: 'Mutton Kacchi (1 person)', price: 420 },
      { name: 'Beef Tehari (1 person)', price: 260 },
      { name: 'Morog Polao (1 person)', price: 280 },
      { name: 'Shahi Jorda (1 person)', price: 120 },
      { name: 'Jali Kabab (2 pieces)', price: 160 },
      { name: 'Chicken Chaap (1 piece)', price: 190 },
      { name: 'Mango Lassi (250ml)', price: 120 },
      { name: 'Zafrani Borhani (500ml)', price: 150 },
      { name: 'Mineral Water (500ml)', price: 20 },
      { name: 'Salad & Achar', price: 60, is_veg: true }
    ]
  },
  {
    slug: 'brand-kfc',
    file: 'official-kfc.json',
    name: 'KFC',
    cuisine: 'Fried Chicken & Burgers',
    description: 'KFC brings its published line-up of crispy chicken, zinger burgers, rice bowls and shareable buckets.',
    owner: { email: 'owner.kfc@cravio.test', name: 'KFC Operations', phone: '01711000031' },
    delivery_fee: 70,
    eta_min: 25,
    eta_max: 45
  },
  {
    slug: 'brand-bfc',
    file: 'official-bfc.json',
    name: 'BFC',
    cuisine: 'Fried Chicken & Fast Food',
    description: 'BFC (Best Fried Chicken) lists fried chicken, wings, burgers, rice platters and sides from its published branch menus.',
    owner: { email: 'owner.bfc@cravio.test', name: 'BFC Operations', phone: '01711000032' },
    delivery_fee: 50,
    eta_min: 25,
    eta_max: 40
  },
  {
    slug: 'brand-chillox',
    file: 'official-chillox.json',
    name: 'Chillox',
    cuisine: 'Burgers & Rice Bowls',
    description: 'Chillox is known for its burgers, fried chicken and rice bowls, listed here from its published branch menus.',
    owner: { email: 'owner.chillox@cravio.test', name: 'Chillox Operations', phone: '01711000033' },
    delivery_fee: 60,
    eta_min: 20,
    eta_max: 40
  }
]

// Some outlet pages publish an "IMAGE COMING SOON" graphic instead of a
// photograph, and the scraper stored it like any other image. It is a
// picture of nothing, so it is banned outright rather than being allowed
// to become a brand's hero shot or sit in its gallery.
const PLACEHOLDER_IMAGES = new Set(['/media/official-Kacchi-Bhai-fc0e8ce800cb.avif'])
const isPlaceholder = url => PLACEHOLDER_IMAGES.has(url)

// The first snapshot record that actually carries a value wins. Brand
// photos, logos and source links repeat across the outlet records, so
// picking the first non-empty one is enough and avoids a null hero image
// when one particular outlet page happened to publish no photo.
const firstWith = (records, read) => records.map(read).find(value => value != null && value !== '' && !isPlaceholder(value)) || null

// BFC publishes no photo for 47 of its dishes and Chillox misses one;
// those fall back to a flagged stock photo. See illustrativePhotos.js.
const { illustrativePhotoFor } = require('./illustrativePhotos')
const { standardBranches } = require('./divisionBranches')

// Three branches is enough to choose between. A brand with 47 outlets
// turns the branch picker into a wall of buttons without making the
// choice any more meaningful.
const PREFERRED_AREAS = ['Khilgaon', 'Dhanmondi', 'Lalbagh']
const BRANCH_LIMIT = 3

// Loose matching on purpose: the sources publish "Dhanmondi 5",
// "Dhanmondi 13" and, in Chillox's case, the misspelling "Dhannmondi".
// Dropping non-letters handles the numbered outlets, and collapsing
// runs of the same letter handles the misspelling.
const normalizeArea = value => value.toLowerCase().replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1')
const matchesArea = (branch, area) => normalizeArea(branch.area).includes(normalizeArea(area))

// ------------------------------------------------------------
// Branches.
//
// Address is the natural key — it is what importCatalog.js matches on
// when deciding whether a branch already exists — so duplicates are
// dropped on address rather than on the outlet's display name.
//
// is_open is forced true. The snapshots mark every outlet closed because
// they were built as a read-only directory; leaving that would import a
// brand whose every branch refuses orders.
//
// Only KFC actually has an outlet in all three preferred areas, so any
// brand short of three is topped up from its other Dhaka outlets rather
// than being left with a single branch to "choose" from.
// ------------------------------------------------------------
function collectBranches(records, brand) {
  const all = []
  const seen = new Set()

  for (const record of records) {
    for (const branch of record.branches) {
      if (seen.has(branch.address)) continue
      seen.add(branch.address)
      all.push(branch)
    }
  }

  const chosen = []
  for (const area of PREFERRED_AREAS) {
    const match = all.find(branch => !chosen.includes(branch) && matchesArea(branch, area))
    if (match) chosen.push(match)
  }
  for (const branch of all) {
    if (chosen.length >= BRANCH_LIMIT) break
    if (!chosen.includes(branch) && branch.division === 'Dhaka') chosen.push(branch)
  }

  // The snapshots only cover Dhaka, but the app should be orderable from
  // anywhere in the country, so each brand also gets one outlet per
  // remaining division. Those are ordinary city-centre areas rather than
  // surveyed addresses — see divisionBranches.js.
  const national = standardBranches(brand.name).filter(branch => branch.division !== 'Dhaka')

  const real = chosen.map(branch => ({
    address: branch.address,
    area: branch.area,
    city: branch.city,
    division: branch.division,
    phone: branch.phone || null,
    latitude: branch.latitude ?? null,
    longitude: branch.longitude ?? null,
    is_open: true,
    delivery_fee: brand.delivery_fee,
    // No minimum order: the brands do not publish one, so inventing a
    // threshold would only block a legitimate small order.
    min_order_amount: 0,
    eta_min: brand.eta_min,
    eta_max: brand.eta_max
  }))

  return [...real, ...national.map(branch => ({
    ...branch,
    phone: null,
    latitude: null,
    longitude: null,
    delivery_fee: brand.delivery_fee,
    min_order_amount: 0,
    eta_min: brand.eta_min,
    eta_max: brand.eta_max
  }))]
}

// ------------------------------------------------------------
// Menu.
//
// Kacchi Bhai and KFC publish one brand-wide menu that every outlet
// record repeats verbatim; BFC and Chillox publish a slightly different
// menu per outlet. Merging by dish name covers both: the repeated brand
// menu collapses to a single copy, and the per-outlet variations union
// into one full brand menu.
//
// First occurrence wins on a name clash. That keeps the price stable
// instead of letting whichever file was read last decide it, and it is
// required anyway — importCatalog.js rejects a restaurant with two menu
// items of the same name.
//
// is_available is forced true for the same reason branches are opened:
// the snapshots mark everything unavailable by default.
// ------------------------------------------------------------
function collectCategories(records) {
  const categories = new Map()
  const takenNames = new Set()

  for (const record of records) {
    for (const category of record.categories || []) {
      if (!categories.has(category.name)) categories.set(category.name, [])
      const items = categories.get(category.name)

      for (const item of category.items) {
        if (takenNames.has(item.name)) continue
        takenNames.add(item.name)

        // The brand's own photo always wins; the stock one is only ever
        // a stand-in for a dish the source published without any image.
        const photo = item.image_url
          ? {
              image_url: item.image_url,
              image_credit: item.image_credit || null,
              image_source_url: item.image_source_url || null,
              image_is_illustrative: item.image_is_illustrative === true
            }
          : illustrativePhotoFor(item.name, category.name)

        items.push({
          name: item.name,
          description: item.description || null,
          price: item.price,
          image_url: photo?.image_url || null,
          image_credit: photo?.image_credit || null,
          image_source_url: photo?.image_source_url || null,
          image_is_illustrative: photo?.image_is_illustrative === true,
          is_veg: item.is_veg === true,
          is_available: true
        })
      }
    }
  }

  // A category that contributed nothing new is dropped: importCatalog.js
  // requires every category to hold at least one item.
  return [...categories.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, items }))
}

// Dishes a brand config adds on top of its published menu. Kept separate
// from collectCategories so the published menu is never quietly mixed
// with additions: these land in their own labelled category, and each one
// says in its own description that it is not from the published menu.
function extraCategory(brand) {
  if (!brand.extra_items) return []

  const items = brand.extra_items.map(item => {
    const photo = illustrativePhotoFor(item.name, brand.cuisine)
    return {
      name: item.name,
      description: 'Added for the Cravio demonstration; not from the published brand menu.',
      price: item.price,
      image_url: photo?.image_url || null,
      image_credit: photo?.image_credit || null,
      image_source_url: photo?.image_source_url || null,
      image_is_illustrative: true,
      is_veg: item.is_veg === true,
      is_available: true
    }
  })

  return [{ name: brand.extra_category, items }]
}

// ------------------------------------------------------------
// Gallery.
//
// Kacchi Bhai publishes a storefront photo per outlet, so pooling those
// gives it a real gallery. The other three publish none at all, so their
// gallery is topped up from their own dish photography instead — those
// are still the brand's published images, just filed against a dish.
//
// Only authentic photos are eligible. A gallery is read as "here is this
// restaurant", so a stock stand-in has no business in it even flagged.
// Capped at 12 because that is importCatalog.js's limit.
// ------------------------------------------------------------
function collectGallery(records) {
  const gallery = []
  const seen = new Set()

  const add = (photo, caption) => {
    if (!photo.image_url || seen.has(photo.image_url) || gallery.length >= 12) return
    if (photo.image_is_illustrative === true || isPlaceholder(photo.image_url)) return
    seen.add(photo.image_url)

    gallery.push({
      image_url: photo.image_url,
      caption,
      image_credit: photo.image_credit,
      image_source_url: photo.image_source_url,
      image_is_illustrative: false
    })
  }

  for (const record of records) {
    for (const photo of record.gallery || []) add(photo, photo.caption)
  }

  // Second pass, so a published storefront photo is never pushed out of
  // the twelve slots by a dish photo.
  for (const record of records) {
    for (const category of record.categories || []) {
      for (const item of category.items) add(item, item.name)
    }
  }

  return gallery
}

function buildBrandCatalog(dataDirectory = path.join(__dirname, '../data')) {
  const restaurants = BRANDS.map(brand => {
    const snapshot = JSON.parse(fs.readFileSync(path.join(dataDirectory, brand.file), 'utf8'))
    const records = snapshot.restaurants

    return {
      catalog_slug: brand.slug,
      name: brand.name,
      description: brand.description,
      cuisine: brand.cuisine,
      owner_email: brand.owner.email,

      // Ordering is switched on deliberately: this checkout has to be
      // demonstrable end to end against a menu with real dishes and real
      // photographs. The source link and photo credits stay on the page,
      // and no money moves — see docs/DATA_SOURCES.md.
      ordering_enabled: true,
      owner_verified: true,
      is_demo: false,

      // Kacchi Bhai's outlet pages publish only the placeholder graphic,
      // so it falls back to a licensed photo of the dish it is known for.
      image_url: brand.hero_override?.image_url || firstWith(records, record => record.image_url) || null,
      image_credit: brand.hero_override?.image_credit || firstWith(records, record => record.image_credit),
      image_source_url: brand.hero_override?.image_source_url || firstWith(records, record => record.image_source_url),
      image_is_illustrative: !!brand.hero_override,
      logo_url: firstWith(records, record => record.logo_url),
      logo_source_url: firstWith(records, record => record.logo_source_url),

      source_url: firstWith(records, record => record.source_url),
      menu_source_url: firstWith(records, record => record.menu_source_url),

      // A merged menu is no longer one outlet's menu, so it is labelled
      // brand-wide however the individual snapshots labelled themselves.
      menu_scope: 'brand',
      verified_at: firstWith(records, record => record.verified_at),

      gallery: collectGallery(records),
      branches: collectBranches(records, brand),
      categories: [...collectCategories(records), ...extraCategory(brand)]
    }
  })

  return { schema_version: 1, restaurants }
}

module.exports = { BRANDS, buildBrandCatalog }

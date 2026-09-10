// ============================================================
// THE FIVE ADDED RESTAURANTS
//
// Sultan's Dine, Khana's, Domino's Pizza, Takeout and Fry Bucket are real
// businesses, but unlike the four in official-*.json we hold no published
// snapshot of their menus or photography. Their dishes and prices here are
// written by us, and their food photos are freely-licensed stock pictures
// of the dish rather than of that restaurant's own cooking.
//
// So every one of them is marked `is_demo: true`. That is not a
// technicality to get past the importer's validation — it is the accurate
// label, and the restaurant card prints "Sample restaurant" because of it.
// Presenting invented prices under a real business's name without saying
// so would be the one thing this catalogue has consistently refused to do.
//
// They are still fully orderable, so the whole checkout → delivery →
// review lifecycle can be demonstrated against them.
//
// No `source_url` is set. That field drives an "Official listing · source
// checked" line on the restaurant page, and we checked no source.
// ============================================================

const fs = require('node:fs')
const path = require('node:path')
const { standardBranches } = require('./divisionBranches')

const PHOTO_SOURCES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../data/commons-photo-sources.json'), 'utf8')
).photos

// Look a downloaded Commons photo up by filename and return it in the
// shape importCatalog.js validates: url plus its author and licence.
function photo(filename) {
  const record = PHOTO_SOURCES[filename]
  if (!record) throw new Error(`${filename} is not in commons-photo-sources.json — run scripts/fetchCommonsPhotos.js first.`)
  return {
    image_url: record.image_url,
    image_credit: record.image_credit,
    image_source_url: record.image_source_url,
    image_is_illustrative: true,
  }
}

const dish = (name, price, filename, extra = {}) => ({ name, price, ...extra, ...photo(filename) })

const RESTAURANTS = [
  {
    catalog_slug: 'added-sultans-dine',
    name: "Sultan's Dine",
    cuisine: 'Kacchi & Biryani',
    description: "Sultan's Dine is known across Dhaka for its kacchi biryani, served with borhani and firni in the traditional way.",
    owner_email: 'sultandine@gmail.com',
    owner_name: "Sultan's Dine Operations",
    owner_phone: '01711000040',
    logo: 'logo-sultans-dine.png',
    hero: 'dish-kacchi-biryani.jpg',
    delivery_fee: 70,
    eta_min: 35,
    eta_max: 60,
    categories: [
      {
        name: 'Kacchi & Rice',
        items: [
          dish('Kacchi Biryani (Full)', 450, 'dish-kacchi-biryani.jpg', { description: 'Mutton kacchi layered with basmati rice, potato and aloo bukhara.' }),
          dish('Kacchi Biryani (Half)', 280, 'dish-kacchi-biryani.jpg', { description: 'A single-portion plate of the same kacchi.' }),
          dish('Morog Polao', 320, 'dish-morog-polao.jpg', { description: 'Fragrant chicken polao with a boiled egg.' }),
          dish('Beef Tehari', 300, 'dish-beef-tehari.jpg', { description: 'Spiced short-grain rice cooked through with beef.' }),
        ],
      },
      {
        name: 'Sides & Sweets',
        items: [
          dish('Chicken Roast', 190, 'dish-chicken-roast.jpg', { description: 'Slow-cooked roast leg in a sweet-savoury gravy.' }),
          dish('Jali Kabab', 150, 'dish-jali-kabab.jpg', { description: 'Two lattice-fried minced beef kababs.' }),
          dish('Borhani', 90, 'dish-borhani.jpg', { description: 'Chilled spiced yoghurt drink.' }),
          dish('Firni', 80, 'dish-firni.jpg', { description: 'Ground-rice pudding set in a clay bowl.' }),
        ],
      },
    ],
  },
  {
    catalog_slug: 'added-khanas',
    name: "Khana's",
    cuisine: 'Mughlai & Indian',
    description: "Khana's serves North Indian and Mughlai plates — butter chicken, seekh kebab and fresh tandoori bread.",
    owner_email: 'khanas@gmail.com',
    owner_name: "Khana's Operations",
    owner_phone: '01711000041',
    logo: 'logo-khanas.png',
    hero: 'dish-butter-chicken.jpg',
    delivery_fee: 65,
    eta_min: 30,
    eta_max: 50,
    categories: [
      {
        name: 'From the Tandoor',
        items: [
          dish('Butter Chicken', 380, 'dish-butter-chicken.jpg', { description: 'Tandoori chicken finished in a tomato and cream gravy.' }),
          dish('Seekh Kebab', 260, 'dish-seekh-kebab.jpg', { description: 'Minced meat skewers grilled over charcoal.' }),
          dish('Butter Naan', 60, 'dish-naan.jpg', { description: 'Tandoor-baked flatbread brushed with butter.', is_veg: true }),
        ],
      },
      {
        name: 'Rice & Sides',
        items: [
          dish('Chicken Biryani', 340, 'dish-chicken-biryani.jpg', { description: 'Long-grain biryani layered with marinated chicken.' }),
          dish('Mango Lassi', 130, 'dish-lassi.jpg', { description: 'Thick sweet yoghurt drink blended with mango.', is_veg: true }),
          dish('Garden Salad', 110, 'dish-salad.jpg', { description: 'Cucumber, tomato, onion and lemon.', is_veg: true }),
        ],
      },
    ],
  },
  {
    catalog_slug: 'added-dominos-pizza',
    name: "Domino's Pizza",
    cuisine: 'Pizza & Sides',
    description: "Domino's Pizza delivers hand-tossed pizzas, oven-baked sides and desserts.",
    owner_email: 'domino@gmail.com',
    owner_name: "Domino's Pizza Operations",
    owner_phone: '01711000042',
    logo: 'logo-dominos.png',
    hero: 'dish-margherita.jpg',
    delivery_fee: 60,
    eta_min: 25,
    eta_max: 45,
    categories: [
      {
        name: 'Pizzas',
        items: [
          dish('Margherita (Medium)', 550, 'dish-margherita.jpg', { description: 'Tomato sauce, mozzarella and basil.', is_veg: true }),
          dish('Pepperoni (Medium)', 690, 'dish-pepperoni.jpg', { description: 'Double pepperoni over mozzarella.' }),
        ],
      },
      {
        name: 'Sides & Desserts',
        items: [
          dish('Garlic Bread', 220, 'dish-garlic-bread.jpg', { description: 'Oven-baked bread with garlic butter.', is_veg: true }),
          dish('Chicken Wings (6 pcs)', 320, 'dish-chicken-wings.jpg', { description: 'Oven-baked wings tossed in hot sauce.' }),
          dish('Choco Brownie', 180, 'dish-brownie.jpg', { description: 'Warm fudge brownie.', is_veg: true }),
          dish('Soft Drink (500ml)', 60, 'dish-soft-drink.jpg', { description: 'Chilled bottle.', is_veg: true }),
        ],
      },
    ],
  },
  {
    catalog_slug: 'added-takeout',
    name: 'Takeout',
    cuisine: 'Burgers & Fast Food',
    description: 'Takeout does smash burgers, loaded fries and wraps, built for delivery.',
    owner_email: 'take@gmail.com',
    owner_name: 'Takeout Operations',
    owner_phone: '01711000043',
    logo: 'logo-takeout.png',
    hero: 'dish-burger.jpg',
    delivery_fee: 55,
    eta_min: 20,
    eta_max: 40,
    categories: [
      {
        name: 'Burgers & Wraps',
        items: [
          dish('Classic Beef Burger', 380, 'dish-burger.jpg', { description: 'Smashed beef patty, cheddar, pickles and house sauce.' }),
          dish('Crispy Chicken Burger', 340, 'dish-chicken-burger.jpg', { description: 'Buttermilk-fried chicken thigh in a brioche bun.' }),
          dish('Chicken Wrap', 290, 'dish-wrap.jpg', { description: 'Grilled chicken, salad and garlic mayo in a warm tortilla.' }),
        ],
      },
      {
        name: 'Sides & Shakes',
        items: [
          dish('Loaded Fries', 190, 'dish-fries.jpg', { description: 'Fries under melted cheese and jalapeños.', is_veg: true }),
          dish('Chicken Nuggets (6 pcs)', 210, 'dish-nuggets.jpg', { description: 'Crispy nuggets with a dip.' }),
          dish('Chocolate Milkshake', 220, 'dish-milkshake.jpg', { description: 'Thick shake blended with chocolate.', is_veg: true }),
        ],
      },
    ],
  },
  {
    catalog_slug: 'added-fry-bucket',
    name: 'Fry Bucket',
    cuisine: 'Fried Chicken',
    description: 'Fry Bucket is built around shareable buckets of crispy fried chicken, wings and sides.',
    owner_email: 'frybucket@gmail.com',
    owner_name: 'Fry Bucket Operations',
    owner_phone: '01711000044',
    logo: 'logo-fry-bucket.png',
    hero: 'dish-chicken-bucket.jpg',
    delivery_fee: 55,
    eta_min: 25,
    eta_max: 45,
    categories: [
      {
        name: 'Buckets & Chicken',
        items: [
          dish('Chicken Bucket (8 pcs)', 890, 'dish-chicken-bucket.jpg', { description: 'Eight pieces of crispy fried chicken to share.' }),
          dish('Fried Chicken (2 pcs)', 260, 'dish-fried-chicken.jpg', { description: 'Two pieces with a side of fries.' }),
          dish('Hot Wings (6 pcs)', 300, 'dish-chicken-wings.jpg', { description: 'Six wings tossed in hot sauce.' }),
          dish('Crispy Burger', 320, 'dish-chicken-burger.jpg', { description: 'Fried chicken fillet burger with slaw.' }),
        ],
      },
      {
        name: 'Sides',
        items: [
          dish('French Fries', 150, 'dish-fries.jpg', { description: 'Salted fries, regular size.', is_veg: true }),
          dish('Coleslaw', 90, 'dish-coleslaw.jpg', { description: 'Creamy cabbage and carrot slaw.', is_veg: true }),
        ],
      },
    ],
  },
]

function buildAddedRestaurants() {
  const restaurants = RESTAURANTS.map(entry => {
    const hero = photo(entry.hero)
    const logo = PHOTO_SOURCES[entry.logo]

    return {
      catalog_slug: entry.catalog_slug,
      name: entry.name,
      description: entry.description,
      cuisine: entry.cuisine,
      owner_email: entry.owner_email,

      // Real name, sample menu — see the note at the top of this file.
      is_demo: true,
      ordering_enabled: true,

      ...hero,
      logo_url: '/media/' + entry.logo,
      // A generated wordmark has no source page, so it only claims one
      // when the logo genuinely came from Commons (Domino's).
      logo_source_url: logo ? logo.image_source_url : 'https://commons.wikimedia.org/wiki/Commons:Licensing',
      menu_scope: 'brand',

      gallery: entry.categories.flatMap(category => category.items).slice(0, 6).map(item => ({
        image_url: item.image_url,
        caption: item.name,
        image_credit: item.image_credit,
        image_source_url: item.image_source_url,
        image_is_illustrative: true,
      })),

      branches: standardBranches(entry.name).map(branch => ({
        ...branch,
        delivery_fee: entry.delivery_fee,
        min_order_amount: 0,
        eta_min: entry.eta_min,
        eta_max: entry.eta_max,
      })),

      categories: entry.categories.map(category => ({
        name: category.name,
        items: category.items.map(item => ({
          name: item.name,
          description: item.description || null,
          price: item.price,
          is_veg: item.is_veg === true,
          is_available: true,
          image_url: item.image_url,
          image_credit: item.image_credit,
          image_source_url: item.image_source_url,
          image_is_illustrative: true,
        })),
      })),
    }
  })

  return { schema_version: 1, restaurants }
}

// The owner accounts the seed has to create before these can be imported.
const ADDED_OWNERS = RESTAURANTS.map(entry => ({
  email: entry.owner_email,
  name: entry.owner_name,
  phone: entry.owner_phone,
}))

module.exports = { ADDED_OWNERS, buildAddedRestaurants }

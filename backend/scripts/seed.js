// ============================================================
// SEED SAMPLE DATA
// Run after npm run db:setup (requires migration 003_marketplace):
//   npm run seed
//
// Inserts a realistic slice of the platform: test accounts for every
// role, 5 restaurants with branches and menus, and a couple of promo
// codes so checkout can actually be exercised end to end.
//
// IDEMPOTENT: every insert is guarded by a lookup on the row's natural
// key, so running this twice inserts nothing the second time. Most of
// these tables have no UNIQUE constraint to hang an ON CONFLICT off
// (only users.email, promo_codes.code and rider_profiles.user_id do),
// so the guard is a SELECT inside the same transaction rather than an
// upsert. That is safe for a seed script run by hand; it would NOT be
// safe against two copies racing each other.
//
// Existing rows are never modified. If you change a price below and
// re-run, the already-seeded row keeps its old price. Update existing
// menus through the owner dashboard; never reset a populated database.
// ============================================================

require('dotenv').config()
const bcrypt = require('bcryptjs')
const pool = require('./../db/pool')

// Same password for every seeded account. 8+ chars, so it satisfies the
// same validation the real /api/auth/signup route applies.
const TEST_PASSWORD = process.env.DEMO_PASSWORD || ''

if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Set ALLOW_DEMO_SEED=true for local development. Demo accounts must not be seeded into production.')
  pool.end().finally(() => { process.exitCode = 1 })
} else if (TEST_PASSWORD.length < 8 || Buffer.byteLength(TEST_PASSWORD, 'utf8') > 72) {
  console.error('DEMO_PASSWORD must be 8+ characters and at most 72 UTF-8 bytes.')
  pool.end().finally(() => { process.exitCode = 1 })
}

// ============================================================
// DATA
// ============================================================

const USERS = [
  // customers
  { name: 'Ayesha Rahman',  email: 'ayesha@example.com',  role: 'customer',         phone: '01711000001' },
  { name: 'Tanvir Hossain', email: 'tanvir@example.com',  role: 'customer',         phone: '01711000002' },

  // restaurant owners — one per restaurant below, except Nabila who owns two
  { name: 'Nabila Chowdhury', email: 'nabila@example.com', role: 'restaurant_owner', phone: '01711000010' },
  { name: 'Rafiq Islam',      email: 'rafiq@example.com',  role: 'restaurant_owner', phone: '01711000011' },
  { name: 'Sadia Karim',      email: 'sadia@example.com',  role: 'restaurant_owner', phone: '01711000012' },
  { name: 'Imran Bhuiyan',    email: 'imran@example.com',  role: 'restaurant_owner', phone: '01711000013' },

  // riders — rider_profiles rows are created alongside these
  { name: 'Jahangir Alam', email: 'jahangir@example.com', role: 'rider', phone: '01711000020', vehicle_type: 'motorcycle', rider_status: 'online' },
  { name: 'Shuvo Das',     email: 'shuvo@example.com',    role: 'rider', phone: '01711000021', vehicle_type: 'bicycle',    rider_status: 'offline' }
]

const RESTAURANTS = [
  {
    name: 'Chuli Kitchen',
    owner: 'nabila@example.com',
    branches: [
      { address: 'House 42, Road 27, Dhanmondi', area: 'Dhanmondi', city: 'Dhaka', phone: '029661000', latitude: 23.751600, longitude: 90.375000, is_open: true },
      { address: 'Plot 12, Sector 7, Uttara',    area: 'Uttara',    city: 'Dhaka', phone: '028912000', latitude: 23.874500, longitude: 90.379700, is_open: true }
    ],
    categories: [
      {
        name: 'Biryani & Rice',
        items: [
          { name: 'Kacchi Biryani',        description: 'Mutton marinated overnight, layered with aromatic basmati and slow-cooked on dum.', price: 420.00, is_veg: false },
          { name: 'Chicken Tehari',        description: 'Short-grain chinigura rice tossed with green chilli and tender chicken.',          price: 280.00, is_veg: false },
          { name: 'Morog Polao',           description: 'Mildly spiced chicken pulao served with a boiled egg and salad.',                  price: 320.00, is_veg: false },
          { name: 'Plain Basmati Rice',    description: 'Steamed long-grain basmati.',                                                      price: 90.00,  is_veg: true  }
        ]
      },
      {
        name: 'Curries',
        items: [
          { name: 'Beef Bhuna',      description: 'Slow-reduced beef curry with onion, ginger and whole garam masala.', price: 340.00, is_veg: false },
          { name: 'Shorshe Ilish',   description: 'Hilsa in mustard gravy. Seasonal.',                                  price: 550.00, is_veg: false },
          { name: 'Dal Makhani',     description: 'Black lentils simmered with butter and cream.',                      price: 180.00, is_veg: true  }
        ]
      },
      {
        name: 'Drinks',
        items: [
          { name: 'Borhani',      description: 'Spiced yoghurt drink with mint and mustard.', price: 70.00, is_veg: true },
          { name: 'Lemon Mint',   description: 'Fresh lime, mint and soda over ice.',         price: 90.00, is_veg: true }
        ]
      }
    ]
  },

  {
    name: 'Pizza Republic',
    owner: 'rafiq@example.com',
    branches: [
      { address: '9 Gulshan Avenue, Gulshan 1', area: 'Gulshan', city: 'Dhaka', phone: '028812000', latitude: 23.780800, longitude: 90.415500, is_open: true },
      // Deliberately closed so the BRANCH_CLOSED path in place_order() is
      // reachable without editing data by hand.
      { address: 'Road 11, Banani',             area: 'Banani',  city: 'Dhaka', phone: '028813000', latitude: 23.793700, longitude: 90.404300, is_open: false }
    ],
    categories: [
      {
        name: 'Pizzas',
        items: [
          { name: 'Margherita',          description: 'San Marzano tomato, fior di latte, basil.',                      price: 650.00, is_veg: true  },
          { name: 'Pepperoni Classic',   description: 'Double pepperoni with mozzarella on a hand-stretched base.',     price: 850.00, is_veg: false },
          { name: 'BBQ Chicken',         description: 'Smoked chicken, red onion, coriander and barbecue sauce.',       price: 890.00, is_veg: false },
          { name: 'Four Cheese',         description: 'Mozzarella, cheddar, parmesan and a blue cheese drizzle.',       price: 920.00, is_veg: true  }
        ]
      },
      {
        name: 'Sides',
        items: [
          { name: 'Garlic Bread',      description: 'Baked with garlic butter and herbs.',        price: 220.00, is_veg: true  },
          { name: 'Buffalo Wings',     description: 'Six wings tossed in hot sauce, blue cheese dip.', price: 380.00, is_veg: false },
          { name: 'Caesar Salad',      description: 'Romaine, parmesan, croutons, anchovy dressing.',   price: 340.00, is_veg: false }
        ]
      }
    ]
  },

  {
    name: 'Wok & Roll',
    owner: 'sadia@example.com',
    branches: [
      { address: 'Level 4, Bashundhara City, Panthapath', area: 'Panthapath', city: 'Dhaka', phone: '029130000', latitude: 23.750900, longitude: 90.390400, is_open: true }
    ],
    categories: [
      {
        name: 'Noodles & Rice',
        items: [
          { name: 'Chicken Chow Mein',   description: 'Wok-tossed egg noodles with julienned vegetables.',      price: 290.00, is_veg: false },
          { name: 'Thai Basil Fried Rice', description: 'Jasmine rice with holy basil, chilli and fried egg.',  price: 310.00, is_veg: false },
          { name: 'Veg Hakka Noodles',   description: 'Cabbage, carrot, spring onion, light soy.',              price: 240.00, is_veg: true  }
        ]
      },
      {
        name: 'From the Wok',
        items: [
          { name: 'Kung Pao Chicken', description: 'Diced chicken, roasted peanuts, dried red chilli.',    price: 420.00, is_veg: false },
          { name: 'Chilli Prawn',     description: 'Prawns in a sweet-hot garlic glaze.',                  price: 520.00, is_veg: false },
          { name: 'Tofu in Black Bean Sauce', description: 'Silken tofu, fermented black bean, peppers.',  price: 330.00, is_veg: true  }
        ]
      },
      {
        name: 'Soups',
        items: [
          { name: 'Thai Thick Soup',   description: 'Chicken, egg and corn in a thickened broth.', price: 190.00, is_veg: false },
          { name: 'Hot & Sour Veg Soup', description: 'White pepper, vinegar, shiitake.',          price: 170.00, is_veg: true  }
        ]
      }
    ]
  },

  {
    name: 'The Burger Yard',
    owner: 'imran@example.com',
    branches: [
      { address: 'Shop 3, Road 2, Dhanmondi',    area: 'Dhanmondi', city: 'Dhaka',      phone: '029662000', latitude: 23.739000, longitude: 90.376900, is_open: true },
      { address: 'GEC Circle, Nasirabad',        area: 'Nasirabad', city: 'Chattogram', phone: '031650000', latitude: 22.358700, longitude: 91.821300, is_open: true }
    ],
    categories: [
      {
        name: 'Burgers',
        items: [
          { name: 'Yard Classic',       description: 'Single beef patty, cheddar, pickles, house sauce.',       price: 380.00, is_veg: false },
          { name: 'Double Smash',       description: 'Two smashed patties, American cheese, caramelised onion.', price: 520.00, is_veg: false },
          { name: 'Crispy Chicken',     description: 'Buttermilk-fried thigh, slaw, sriracha mayo.',            price: 420.00, is_veg: false },
          { name: 'Mushroom Swiss (V)', description: 'Grilled portobello, swiss cheese, garlic aioli.',         price: 390.00, is_veg: true  }
        ]
      },
      {
        name: 'Fries & Shakes',
        items: [
          { name: 'Loaded Cheese Fries', description: 'Fries under cheese sauce, jalapeño and spring onion.', price: 260.00, is_veg: true },
          { name: 'Peri Peri Fries',     description: 'Hand-cut fries dusted with peri peri.',                price: 180.00, is_veg: true },
          { name: 'Oreo Shake',          description: 'Thick vanilla shake blended with cookies.',            price: 280.00, is_veg: true }
        ]
      }
    ]
  },

  {
    name: 'Green Bowl',
    owner: 'nabila@example.com', // second restaurant for this owner
    branches: [
      { address: 'Road 12, Block E, Banani', area: 'Banani', city: 'Dhaka', phone: '028814000', latitude: 23.794100, longitude: 90.406100, is_open: true }
    ],
    categories: [
      {
        name: 'Bowls',
        items: [
          { name: 'Quinoa Falafel Bowl', description: 'Quinoa, baked falafel, hummus, pickled cabbage.',    price: 480.00, is_veg: true  },
          { name: 'Grilled Chicken Bowl', description: 'Brown rice, grilled chicken, avocado, tahini.',     price: 540.00, is_veg: false },
          { name: 'Peanut Tofu Bowl',    description: 'Soba noodles, crisp tofu, satay dressing.',          price: 460.00, is_veg: true  }
        ]
      },
      {
        name: 'Cold Press',
        items: [
          { name: 'Green Detox',   description: 'Cucumber, spinach, apple, ginger.', price: 220.00, is_veg: true },
          { name: 'Beet Boost',    description: 'Beetroot, carrot, orange, lemon.',  price: 220.00, is_veg: true },
          // One unavailable item, so the "sold out" UI state and the
          // CART_CONTAINS_UNAVAILABLE_ITEM checkout guard have something
          // to act on.
          { name: 'Turmeric Latte', description: 'Oat milk, turmeric, black pepper. Currently unavailable.', price: 260.00, is_veg: true, is_available: false }
        ]
      }
    ]
  }
]

// Modifier groups, keyed by "<restaurant name>::<menu item name>". Kept
// separate from RESTAURANTS so the item lists above stay readable — only a
// few dishes have modifiers, and nesting empty arrays under the rest would
// bury the menu.
const MODIFIERS = {
  'Pizza Republic::Margherita': [
    {
      name: 'Size',
      is_required: true,
      min_selection: 1,
      max_selection: 1,
      options: [
        { name: 'Regular (9")', price_modifier: 0.00 },
        { name: 'Large (12")', price_modifier: 250.00 },
        { name: 'Family (16")', price_modifier: 520.00 }
      ]
    },
    {
      name: 'Extra toppings',
      is_required: false,
      min_selection: 0,
      max_selection: 3,
      options: [
        { name: 'Extra cheese', price_modifier: 120.00 },
        { name: 'Mushrooms', price_modifier: 90.00 },
        { name: 'Olives', price_modifier: 80.00 },
        { name: 'Jalapeños', price_modifier: 70.00 }
      ]
    }
  ],

  'The Burger Yard::Yard Classic': [
    {
      name: 'Doneness',
      is_required: true,
      min_selection: 1,
      max_selection: 1,
      options: [
        { name: 'Medium', price_modifier: 0.00 },
        { name: 'Well done', price_modifier: 0.00 }
      ]
    },
    {
      name: 'Add-ons',
      is_required: false,
      min_selection: 0,
      max_selection: 4,
      options: [
        { name: 'Extra patty', price_modifier: 180.00 },
        { name: 'Bacon', price_modifier: 140.00 },
        { name: 'Fried egg', price_modifier: 60.00 },
        // A negative modifier is legitimate: removing something cheapens the
        // burger, and exercises the signed price_modifier column.
        { name: 'No cheese', price_modifier: -30.00 }
      ]
    }
  ],

  'Chuli Kitchen::Kacchi Biryani': [
    {
      name: 'Portion',
      is_required: true,
      min_selection: 1,
      max_selection: 1,
      options: [
        { name: 'Half', price_modifier: -150.00 },
        { name: 'Full', price_modifier: 0.00 }
      ]
    },
    {
      name: 'Sides',
      is_required: false,
      min_selection: 0,
      max_selection: 2,
      options: [
        { name: 'Extra borhani', price_modifier: 70.00 },
        { name: 'Boiled egg', price_modifier: 40.00 },
        // Seeded unavailable so the MODIFIER_OPTION_UNAVAILABLE path is
        // reachable without editing rows by hand.
        { name: 'Jali kabab', price_modifier: 160.00, is_available: false }
      ]
    }
  ]
}

const PROMO_CODES = [
  { code: 'WELCOME20', discount_percent: 20, min_order_amount: 300.00,  expiry_date: '2027-12-31', usage_limit: 500 },
  { code: 'FLAT10',    discount_percent: 10, min_order_amount: 0.00,    expiry_date: '2027-12-31', usage_limit: 1000 },
  // Expired on purpose — exercises the PROMO_CODE_EXPIRED branch.
  { code: 'OLDDEAL',   discount_percent: 50, min_order_amount: 0.00,    expiry_date: '2020-01-01', usage_limit: 100 }
]

// ============================================================
// IDEMPOTENT INSERT HELPERS
//
// Each returns { id, created } so the summary at the end can report how
// much of this run was actually new.
// ============================================================

const ensureUser = async (client, user, hashedPassword) => {
  const existing = await client.query(
    'SELECT id FROM users WHERE email = $1',
    [user.email]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO users
        (name, email, password, role, phone, is_active)
      VALUES
        ($1, $2, $3, $4, $5, true)
      RETURNING id
    `,
    [user.name, user.email, hashedPassword, user.role, user.phone]
  )

  return { id: inserted.rows[0].id, created: true }
}

// rider_profiles.user_id is UNIQUE, so this one can use a real upsert.
const ensureRiderProfile = async (client, userId, vehicleType, status) => {
  const inserted = await client.query(
    `
      INSERT INTO rider_profiles
        (user_id, vehicle_type, status)
      VALUES
        ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
      RETURNING id
    `,
    [userId, vehicleType, status]
  )

  return { created: inserted.rows.length > 0 }
}

// Natural key: one restaurant of a given name per owner.
const ensureRestaurant = async (client, ownerId, name) => {
  const existing = await client.query(
    'SELECT id FROM restaurants WHERE owner_id = $1 AND name = $2',
    [ownerId, name]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO restaurants (owner_id, name, is_demo, image_is_illustrative)
      VALUES ($1, $2, true, true)
      RETURNING id
    `,
    [ownerId, name]
  )

  return { id: inserted.rows[0].id, created: true }
}

// Natural key: street address within a restaurant.
const ensureBranch = async (client, restaurantId, branch) => {
  const existing = await client.query(
    'SELECT id FROM restaurant_branches WHERE restaurant_id = $1 AND address = $2',
    [restaurantId, branch.address]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO restaurant_branches
        (restaurant_id, address, area, city, phone, latitude, longitude, is_open)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `,
    [
      restaurantId,
      branch.address,
      branch.area,
      branch.city,
      branch.phone,
      branch.latitude,
      branch.longitude,
      branch.is_open
    ]
  )

  return { id: inserted.rows[0].id, created: true }
}

// Natural key: category name within a restaurant.
const ensureCategory = async (client, restaurantId, name) => {
  const existing = await client.query(
    'SELECT id FROM menu_categories WHERE restaurant_id = $1 AND name = $2',
    [restaurantId, name]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO menu_categories (restaurant_id, name)
      VALUES ($1, $2)
      RETURNING id
    `,
    [restaurantId, name]
  )

  return { id: inserted.rows[0].id, created: true }
}

// Natural key: item name within a restaurant (not within a category, so
// moving an item between categories by hand does not resurrect it here).
const ensureMenuItem = async (client, restaurantId, categoryId, item) => {
  const existing = await client.query(
    'SELECT id FROM menu_items WHERE restaurant_id = $1 AND name = $2',
    [restaurantId, item.name]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO menu_items
        (category_id, restaurant_id, name, description, price, is_available, is_veg)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [
      categoryId,
      restaurantId,
      item.name,
      item.description,
      item.price,
      item.is_available !== false, // default true unless explicitly false
      item.is_veg
    ]
  )

  return { id: inserted.rows[0].id, created: true }
}

// Natural key: group name within a menu item.
const ensureModifierGroup = async (client, menuItemId, group) => {
  const existing = await client.query(
    'SELECT id FROM modifier_groups WHERE menu_item_id = $1 AND name = $2',
    [menuItemId, group.name]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO modifier_groups
        (menu_item_id, name, is_required, min_selection, max_selection)
      VALUES
        ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    [
      menuItemId,
      group.name,
      group.is_required,
      group.min_selection,
      group.max_selection
    ]
  )

  return { id: inserted.rows[0].id, created: true }
}

// Natural key: option name within a group.
const ensureModifierOption = async (client, groupId, option) => {
  const existing = await client.query(
    'SELECT id FROM modifier_options WHERE modifier_group_id = $1 AND name = $2',
    [groupId, option.name]
  )

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false }
  }

  const inserted = await client.query(
    `
      INSERT INTO modifier_options
        (modifier_group_id, name, price_modifier, is_available)
      VALUES
        ($1, $2, $3, $4)
      RETURNING id
    `,
    [
      groupId,
      option.name,
      option.price_modifier,
      option.is_available !== false // default true unless explicitly false
    ]
  )

  return { id: inserted.rows[0].id, created: true }
}

// promo_codes.code is UNIQUE — another real upsert.
const ensurePromoCode = async (client, promo) => {
  const inserted = await client.query(
    `
      INSERT INTO promo_codes
        (code, discount_percent, min_order_amount, expiry_date, is_active, usage_limit, used_count)
      VALUES
        ($1, $2, $3, $4, true, $5, 0)
      ON CONFLICT (code) DO NOTHING
      RETURNING id
    `,
    [
      promo.code,
      promo.discount_percent,
      promo.min_order_amount,
      promo.expiry_date,
      promo.usage_limit
    ]
  )

  return { created: inserted.rows.length > 0 }
}

// ============================================================
// RUN
// ============================================================

const run = async () => {
  const client = await pool.connect()

  // Counters so a second run visibly reports "0 created" instead of
  // looking identical to the first.
  const stats = {
    users: 0,
    riderProfiles: 0,
    restaurants: 0,
    branches: 0,
    categories: 0,
    menuItems: 0,
    modifierGroups: 0,
    modifierOptions: 0,
    promoCodes: 0
  }

  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cravio-catalog-import'))")

    // ---- Users -------------------------------------------------
    // Hash once per run rather than per user — bcrypt is deliberately
    // slow and every seeded account shares the same password.
    const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 10)

    // email -> id, so restaurants can be attached to their owner below
    const userIdByEmail = new Map()

    for (const user of USERS) {
      const { id, created } = await ensureUser(client, user, hashedPassword)
      userIdByEmail.set(user.email, id)
      if (created) stats.users++

      if (user.role === 'rider') {
        const profile = await ensureRiderProfile(
          client,
          id,
          user.vehicle_type,
          user.rider_status
        )
        if (profile.created) stats.riderProfiles++
      }
    }

    // ---- Restaurants, branches, menus --------------------------
    for (const restaurant of (process.env.SEED_ACCOUNTS_ONLY === 'true' ? [] : RESTAURANTS)) {
      const ownerId = userIdByEmail.get(restaurant.owner)

      if (!ownerId) {
        throw new Error(
          `Restaurant "${restaurant.name}" names owner "${restaurant.owner}", who is not in USERS.`
        )
      }

      const { id: restaurantId, created } = await ensureRestaurant(
        client,
        ownerId,
        restaurant.name
      )
      if (created) stats.restaurants++

      for (const branch of restaurant.branches) {
        const result = await ensureBranch(client, restaurantId, branch)
        if (result.created) stats.branches++
      }

      for (const category of restaurant.categories) {
        const { id: categoryId, created: categoryCreated } = await ensureCategory(
          client,
          restaurantId,
          category.name
        )
        if (categoryCreated) stats.categories++

        for (const item of category.items) {
          const result = await ensureMenuItem(client, restaurantId, categoryId, item)
          if (result.created) stats.menuItems++

          // Attach this dish's modifier groups, if it has any.
          const groups = MODIFIERS[`${restaurant.name}::${item.name}`] || []

          for (const group of groups) {
            const groupResult = await ensureModifierGroup(
              client,
              result.id,
              group
            )
            if (groupResult.created) stats.modifierGroups++

            for (const option of group.options) {
              const optionResult = await ensureModifierOption(
                client,
                groupResult.id,
                option
              )
              if (optionResult.created) stats.modifierOptions++
            }
          }
        }
      }
    }

    // ---- Promo codes -------------------------------------------
    // There is no admin UI for these, so seeding them is the only way
    // to exercise the discount branch of place_order().
    for (const promo of PROMO_CODES) {
      const result = await ensurePromoCode(client, promo)
      if (result.created) stats.promoCodes++
    }

    await client.query('COMMIT')

    // ---- Report ------------------------------------------------
    const total = Object.values(stats).reduce((sum, n) => sum + n, 0)

    console.log('Seed complete. Rows created this run:')
    console.log(`  users            ${stats.users}`)
    console.log(`  rider_profiles   ${stats.riderProfiles}`)
    console.log(`  restaurants      ${stats.restaurants}`)
    console.log(`  branches         ${stats.branches}`)
    console.log(`  menu_categories  ${stats.categories}`)
    console.log(`  menu_items       ${stats.menuItems}`)
    console.log(`  modifier_groups  ${stats.modifierGroups}`)
    console.log(`  modifier_options ${stats.modifierOptions}`)
    console.log(`  promo_codes      ${stats.promoCodes}`)

    if (total === 0) {
      console.log('\nNothing new — the sample data was already present.')
    } else {
      console.log(`\n${total} rows inserted.`)
    }

    console.log('\nNew demo accounts use the DEMO_PASSWORD you configured. Existing passwords are unchanged.')
    console.log('  customer          ayesha@example.com')
    console.log('  restaurant_owner  nabila@example.com  (sample restaurant owner)')
    console.log('  rider             jahangir@example.com')
    console.log('\nAdmin is seeded separately: npm run seed:admin')

  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Seed failed, rolled back:', error)
    process.exitCode = 1

  } finally {
    client.release()
    await pool.end()
  }
}

if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEMO_SEED === 'true' && TEST_PASSWORD.length >= 8 && Buffer.byteLength(TEST_PASSWORD, 'utf8') <= 72) run()

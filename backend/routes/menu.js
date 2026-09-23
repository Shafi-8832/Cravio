const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')

const router = express.Router()


// ============================================================
// GET /api/menu/restaurants/:restaurantId
// Public
// Returns restaurant + categories + menu items
// ============================================================
router.get('/restaurants/:restaurantId', async (req, res) => {
  const restaurantId = parseId(req.params.restaurantId) // fetch the restaurant ID from the browsers URL

  if (restaurantId === null) {
    return res.status(400).json({
      error: 'Invalid restaurant ID.'
    })
  }

  try {
    // Check that restaurant exists
    const restaurantResult = await pool.query(`
      SELECT
        id,
        name
      FROM restaurants
      WHERE id = $1
    `, [restaurantId])

    if (restaurantResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Restaurant not found.'
      })
    }

    // Get all categories
    const categoriesResult = await pool.query(`
      SELECT
        id,
        name
      FROM menu_categories
      WHERE restaurant_id = $1
      ORDER BY name
    `, [restaurantId])

    // Get all items
    const itemsResult = await pool.query(`
      SELECT
        id,
        category_id,
        name,
        description,
        price,
        image_url, image_credit, image_source_url, image_is_illustrative,
        is_available,
        is_veg,
        quality_flag,
        created_at
      FROM menu_items
      WHERE restaurant_id = $1
      ORDER BY name
    `, [restaurantId])

    // Get every modifier group + option for this restaurant in one query.
    // Fetching per item would mean one round trip per dish; this is a single
    // pass that the loop below slices up in memory.
    const modifiersResult = await pool.query(`
      SELECT
        mg.id AS group_id,
        mg.menu_item_id,
        mg.name AS group_name,
        mg.is_required,
        mg.min_selection,
        mg.max_selection,
        mo.id AS option_id,
        mo.name AS option_name,
        mo.price_modifier,
        mo.is_available AS option_is_available
      FROM modifier_groups mg
      JOIN menu_items mi
        ON mi.id = mg.menu_item_id
      LEFT JOIN modifier_options mo
        ON mo.modifier_group_id = mg.id
      WHERE mi.restaurant_id = $1
      ORDER BY mg.id, mo.id
    `, [restaurantId])

    // Rebuild the group -> options nesting the LEFT JOIN flattened. A group
    // with no options yet still has one row (option_id IS NULL), so it stays
    // visible to the owner editing the menu.
    const groupsByItem = new Map()

    for (const row of modifiersResult.rows) {
      if (!groupsByItem.has(row.menu_item_id)) {
        groupsByItem.set(row.menu_item_id, new Map())
      }

      const itemGroups = groupsByItem.get(row.menu_item_id)

      if (!itemGroups.has(row.group_id)) {
        itemGroups.set(row.group_id, {
          id: row.group_id,
          name: row.group_name,
          is_required: row.is_required,
          min_selection: row.min_selection,
          max_selection: row.max_selection,
          options: []
        })
      }

      if (row.option_id !== null) {
        itemGroups.get(row.group_id).options.push({
          id: row.option_id,
          name: row.option_name,
          price_modifier: row.price_modifier,
          is_available: row.option_is_available
        })
      }
    }

    // Put items inside their respective categories // can be done through SQL ? **
    const categories = categoriesResult.rows.map(category => ({
      ...category,
      items: itemsResult.rows
        .filter(item => item.category_id === category.id)
        .map(item => ({
          ...item,
          modifier_groups: Array.from(
            groupsByItem.get(item.id)?.values() || []
          )
        }))
    }))

  //   const result = await pool.query(`
  //   SELECT 
  //     c.id,
  //     c.name,
  //     COALESCE(
  //       json_agg(
  //         json_build_object(
  //           'id', i.id,
  //           'category_id', i.category_id,
  //           'name', i.name,
  //           'description', i.description,
  //           'price', i.price,
  //           'image_url', i.image_url,
  //           'is_available', i.is_available,
  //           'is_veg', i.is_veg,
  //           'quality_flag', i.quality_flag,
  //           'created_at', i.created_at
  //         ) ORDER BY i.name
  //       ) FILTER (WHERE i.id IS NOT NULL), 
  //       '[]' // --> fallback : empty array
  //     ) AS items
  //   FROM menu_categories c
  //   LEFT JOIN menu_items i ON c.id = i.category_id
  //   WHERE c.restaurant_id = $1
  //   GROUP BY c.id, c.name
  //   ORDER BY c.name;
  // `, [restaurantId]);

  // const categories = result.rows;


    res.json({
      restaurant: restaurantResult.rows[0],
      categories
    })

  } catch (error) {
    console.error('Get menu error:', error)

    res.status(500).json({
      error: 'Server error fetching menu.'
    })
  }
})


// ============================================================
// POST /api/menu/restaurants/:restaurantId/categories
// restaurant_owner or admin only
// Creates a menu category
// ============================================================
router.post( // every HTTP call needs to be verified.
  '/restaurants/:restaurantId/categories',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const restaurantId = parseId(req.params.restaurantId) // fetch the ID from the browser URL
    const { name } = req.body

    if (restaurantId === null) {
      return res.status(400).json({
        error: 'Invalid restaurant ID.'
      })
    }

    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      return res.status(400).json({
        error: 'Category name is required.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // Find restaurant and owner
      const restaurantResult = await client.query(`
        SELECT
          id,
          owner_id
        FROM restaurants
        WHERE id = $1
      `, [restaurantId])

      if (restaurantResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Restaurant not found.'
        })
      }

      const restaurant = restaurantResult.rows[0]

      // Restaurant owner can modify only their own restaurant
      if (
        req.user.role !== 'admin' &&
        restaurant.owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant.'
        })
      }

      const result = await client.query(`
        INSERT INTO menu_categories
          (restaurant_id, name)
        VALUES ($1, $2)
        RETURNING id, restaurant_id, name
      `, [
        restaurantId,
        name.trim()
      ])

      await client.query('COMMIT')

      res.status(201).json({
        category: result.rows[0]
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create category error:', error)

      res.status(500).json({
        error: 'Server error creating menu category.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// POST /api/menu/categories/:categoryId/items
// restaurant_owner or admin only
// Adds an item to a menu category
// ============================================================
router.post(
  '/categories/:categoryId/items',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const categoryId = parseId(req.params.categoryId)

    const {
      name,
      description,
      price,
      image_url,
      is_veg
    } = req.body

    if (categoryId === null) {
      return res.status(400).json({
        error: 'Invalid category ID.'
      })
    }

    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      return res.status(400).json({
        error: 'Menu item name is required.'
      })
    }

    if (
      price === undefined ||
      price === null ||
      !Number.isFinite(Number(price)) || Number(price) < 0 || Number(price) > 1000000
    ) {
      return res.status(400).json({
        error: 'A valid menu item price is required.'
      })
    }

    if ((description !== undefined && (typeof description !== 'string' || description.length > 2000)) ||
        (is_veg !== undefined && typeof is_veg !== 'boolean') ||
        (image_url !== undefined && (typeof image_url !== 'string' || image_url.length > 255 || (image_url && !/^https:\/\/[^\s]+$|^\/media\/[\w-]+\.(jpg|jpeg|png|webp)$/.test(image_url))))) {
      return res.status(400).json({ error: 'Invalid description, photo URL or vegetarian flag.' })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // Find category, restaurant, and owner together

      // SQL NOTE ** : this is a MANY JOIN 1 scenario
      // the frontend is only sending the category ID
      // so in menu_category table (id, restaurant_id, name)
      // from the cat_id == menu_cat.id, grab the restaurant_id
      // go to the restaurant table with this restaurant_id
      // fetch the owner_id of that restaurant
      // check whether the fetched owner_id matches the id sent by frontend 
      // if matches, the request is safe, otherwise not
      const categoryResult = await client.query(`
        SELECT
          mc.id,
          mc.restaurant_id,
          r.owner_id
        FROM menu_categories mc
        JOIN restaurants r
          ON mc.restaurant_id = r.id
        WHERE mc.id = $1
      `, [categoryId])

      if (categoryResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Menu category not found.'
        })
      }

      const category = categoryResult.rows[0]

      // Only owner of this restaurant or admin can add item
      if (
        req.user.role !== 'admin' &&
        category.owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      const result = await client.query(`
        INSERT INTO menu_items
        (
          category_id,
          restaurant_id,
          name,
          description,
          price,
          image_url,
          is_veg
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        categoryId, // or you can write category.id 
        category.restaurant_id,
        name.trim(),
        description || null,
        price,
        image_url || null,
        is_veg ?? false
      ])

      await client.query('COMMIT')

      res.status(201).json({
        item: result.rows[0]
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create menu item error:', error)

      res.status(500).json({
        error: 'Server error creating menu item.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// PATCH /api/menu/items/:itemId
// restaurant_owner or admin only
// Updates menu item information
// ============================================================
router.patch(
  '/items/:itemId',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const itemId = parseId(req.params.itemId)

    const {
      name,
      description,
      price,
      image_url,
      is_veg
    } = req.body

    if (itemId === null) {
      return res.status(400).json({
        error: 'Invalid menu item ID.'
      })
    }

    if (
      price !== undefined &&
      (!Number.isFinite(Number(price)) || Number(price) < 0 || Number(price) > 1000000)
    ) {
      return res.status(400).json({
        error: 'Price cannot be negative.'
      })
    }

    if ((name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 100)) ||
        (is_veg !== undefined && typeof is_veg !== 'boolean') ||
        (description !== undefined && (typeof description !== 'string' || description.length > 2000)) ||
        (image_url !== undefined && (typeof image_url !== 'string' || image_url.length > 255 || (image_url && !/^https?:\/\/|^\/media\//.test(image_url))))) {
      return res.status(400).json({ error: 'Invalid item name, description, image URL or vegetarian flag.' })
    }

    const client = await pool.connect()

    try { // ? menu_category + restaurant + menu_items --> 3 relationships or trinary relationship? which is better?
      await client.query('BEGIN')

      // Find item + restaurant owner


      // SQL NOTE ** : menu_items has restaurant_id
      // so join restaurant table USING (restaurant_id)
      // after join, you will have the owner_id available in the merged table
      // fetch the owner_id, match it with the owner_id sent from the frontend
      // if matches, safe. otherwise reject

      const itemResult = await client.query(`
        SELECT
          mi.id,
          mi.restaurant_id,
          r.owner_id
        FROM menu_items mi
        JOIN restaurants r
          ON mi.restaurant_id = r.id
        WHERE mi.id = $1
      `, [itemId])

      if (itemResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      const item = itemResult.rows[0]

      if (
        req.user.role !== 'admin' &&
        item.owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      // SQL NOTE ** : COALESCE(value1, value2, value3, ......, fall_back) reads data from left to right, returns the first NOT NULL value
      // so if the user left the name field blank then JS passes NULL to $1
      // so the previous name stays

      const result = await client.query(`
        UPDATE menu_items
        SET
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          price = COALESCE($3, price),
          image_url = COALESCE($4, image_url),
          is_veg = COALESCE($5, is_veg)
        WHERE id = $6
        RETURNING * 
      `, [
        name !== undefined ? name.trim() : null,
        description !== undefined ? description : null,
        price !== undefined ? price : null,
        image_url !== undefined ? image_url : null,
        is_veg !== undefined ? is_veg : null,
        itemId
      ])

      await client.query('COMMIT')

      res.json({ // send the 
        item: result.rows[0] // Frontend needs to instantly reflects the changes
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Update menu item error:', error)

      res.status(500).json({
        error: 'Server error updating menu item.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// PATCH /api/menu/items/:itemId/toggle
// restaurant_owner or admin only
// Toggles available / unavailable
// ============================================================
router.patch(
  '/items/:itemId/toggle',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const itemId = parseId(req.params.itemId)

    if (itemId === null) {
      return res.status(400).json({
        error: 'Invalid menu item ID.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')


      // the API request PATCH from frontend did not contain owner_id
      // we need to find it ourselves
      // join menu_items with restaurants using PK & FK
      // fetch the owner_id by the itemID
      // if the id from frontend matches the owner_id from db --> safe

      const itemResult = await client.query(`
        SELECT
          mi.id,
          r.owner_id
        FROM menu_items mi
        JOIN restaurants r
          ON mi.restaurant_id = r.id
        WHERE mi.id = $1
      `, [itemId])

      if (itemResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      const item = itemResult.rows[0]

      if (
        req.user.role !== 'admin' &&
        item.owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      // SQL NOTE ** : ezzy
      const result = await client.query(`
        UPDATE menu_items
        SET is_available = NOT is_available
        WHERE id = $1
        RETURNING
          id,
          name,
          is_available
      `, [itemId])

      await client.query('COMMIT')

      res.json({
        item: result.rows[0], // nested JSON object
        message: `Item is now ${
          result.rows[0].is_available
            ? 'available'
            : 'unavailable'
        }.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Toggle menu item error:', error)

      res.status(500).json({
        error: 'Server error toggling menu item availability.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// DELETE /api/menu/items/:itemId
// restaurant_owner or admin only
// Deletes an item
// ============================================================
router.delete(
  '/items/:itemId',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const itemId = parseId(req.params.itemId)

    if (itemId === null) {
      return res.status(400).json({
        error: 'Invalid menu item ID.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const itemResult = await client.query(`
        SELECT
          mi.id,
          mi.name,
          r.owner_id
        FROM menu_items mi
        JOIN restaurants r
          ON mi.restaurant_id = r.id
        WHERE mi.id = $1
      `, [itemId])

      if (itemResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      const item = itemResult.rows[0]

      if (
        req.user.role !== 'admin' &&
        item.owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      await client.query(`
        DELETE FROM menu_items
        WHERE id = $1
      `, [itemId])

      await client.query('COMMIT')

      res.json({
        message: `Menu item "${item.name}" deleted successfully.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Delete menu item error:', error)

      res.status(500).json({
        error: 'Server error deleting menu item.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// MODIFIERS
//
// A modifier group is a question about a dish ("Choose your size",
// "Add-ons"); a modifier option is one answer, optionally with a price
// difference. Groups hang off a single menu item, so ownership is always
// resolved menu_item -> restaurant -> owner_id.
// ============================================================

// Shared ownership check for both levels of the modifier tree. Returns the
// menu item row if the caller may edit it, otherwise null — the caller turns
// that into the right 403/404.
const findEditableMenuItem = async (db, menuItemId, actor) => {
  const result = await db.query(`
    SELECT
      mi.id,
      mi.restaurant_id,
      r.owner_id
    FROM menu_items mi
    JOIN restaurants r
      ON r.id = mi.restaurant_id
    WHERE mi.id = $1
  `, [menuItemId])

  return result.rows[0] || null
}


// ============================================================
// POST /api/menu/items/:itemId/modifier-groups
// restaurant_owner or admin only
// ============================================================
router.post(
  '/items/:itemId/modifier-groups',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const itemId = parseId(req.params.itemId)
    const { name, is_required, min_selection, max_selection } = req.body

    if (itemId === null) {
      return res.status(400).json({
        error: 'Invalid menu item ID.'
      })
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        error: 'Modifier group name is required.'
      })
    }

    const minSelection = min_selection === undefined ? 0 : Number(min_selection)
    const maxSelection = max_selection === undefined ? 1 : Number(max_selection)
    const isRequired = is_required === true

    if (!Number.isInteger(minSelection) || minSelection < 0) {
      return res.status(400).json({
        error: 'min_selection must be a non-negative integer.'
      })
    }

    if (!Number.isInteger(maxSelection) || maxSelection < 1) {
      return res.status(400).json({
        error: 'max_selection must be an integer of at least 1.'
      })
    }

    if (minSelection > maxSelection) {
      return res.status(400).json({
        error: 'min_selection cannot exceed max_selection.'
      })
    }

    // A required group the customer could satisfy by picking nothing is a
    // contradiction, and would let checkout through with an incomplete dish.
    if (isRequired && minSelection < 1) {
      return res.status(400).json({
        error: 'A required group must have min_selection of at least 1.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const item = await findEditableMenuItem(pool, itemId, req.user)

      if (!item) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      if (req.user.role !== 'admin' && item.owner_id !== req.user.id) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      const result = await client.query(`
        INSERT INTO modifier_groups
          (menu_item_id, name, is_required, min_selection, max_selection)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, menu_item_id, name, is_required, min_selection, max_selection
      `, [
        itemId,
        String(name).trim(),
        isRequired,
        minSelection,
        maxSelection
      ])

      await client.query('COMMIT')

      res.status(201).json({
        modifier_group: {
          ...result.rows[0],
          options: []
        }
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create modifier group error:', error)

      res.status(500).json({
        error: 'Server error creating modifier group.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// POST /api/menu/modifier-groups/:groupId/options
// restaurant_owner or admin only
// ============================================================
router.post(
  '/modifier-groups/:groupId/options',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const groupId = parseId(req.params.groupId)
    const { name, price_modifier } = req.body

    if (groupId === null) {
      return res.status(400).json({
        error: 'Invalid modifier group ID.'
      })
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        error: 'Modifier option name is required.'
      })
    }

    // A negative price_modifier is legitimate — "no cheese, -20" is a real
    // discount — so only the shape is validated here, not the sign.
    const priceModifier =
      price_modifier === undefined || price_modifier === null
        ? 0
        : Number(price_modifier)

    if (!Number.isFinite(priceModifier)) {
      return res.status(400).json({
        error: 'price_modifier must be a number.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const groupResult = await client.query(`
        SELECT
          mg.id,
          mg.menu_item_id,
          r.owner_id
        FROM modifier_groups mg
        JOIN menu_items mi
          ON mi.id = mg.menu_item_id
        JOIN restaurants r
          ON r.id = mi.restaurant_id
        WHERE mg.id = $1
      `, [groupId])

      if (groupResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Modifier group not found.'
        })
      }

      if (
        req.user.role !== 'admin' &&
        groupResult.rows[0].owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      const result = await client.query(`
        INSERT INTO modifier_options
          (modifier_group_id, name, price_modifier)
        VALUES ($1, $2, $3)
        RETURNING id, modifier_group_id, name, price_modifier, is_available
      `, [
        groupId,
        String(name).trim(),
        priceModifier
      ])

      await client.query('COMMIT')

      res.status(201).json({
        modifier_option: result.rows[0]
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create modifier option error:', error)

      res.status(500).json({
        error: 'Server error creating modifier option.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// PATCH /api/menu/modifier-options/:optionId/toggle
// restaurant_owner or admin only
// Marks an option temporarily unavailable (ran out of cheese) without
// deleting it and losing the price history on past orders.
// ============================================================
router.patch(
  '/modifier-options/:optionId/toggle',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const optionId = parseId(req.params.optionId)

    if (optionId === null) {
      return res.status(400).json({
        error: 'Invalid modifier option ID.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const optionResult = await client.query(`
        SELECT
          mo.id,
          r.owner_id
        FROM modifier_options mo
        JOIN modifier_groups mg
          ON mg.id = mo.modifier_group_id
        JOIN menu_items mi
          ON mi.id = mg.menu_item_id
        JOIN restaurants r
          ON r.id = mi.restaurant_id
        WHERE mo.id = $1
      `, [optionId])

      if (optionResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Modifier option not found.'
        })
      }

      if (
        req.user.role !== 'admin' &&
        optionResult.rows[0].owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      const result = await client.query(`
        UPDATE modifier_options
        SET is_available = NOT is_available
        WHERE id = $1
        RETURNING id, name, price_modifier, is_available
      `, [optionId])

      await client.query('COMMIT')

      res.json({
        modifier_option: result.rows[0]
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Toggle modifier option error:', error)

      res.status(500).json({
        error: 'Server error toggling modifier option.'
      })
    } finally {
      client.release()
    }
  }
)


// ============================================================
// DELETE /api/menu/modifier-groups/:groupId
// restaurant_owner or admin only
// Options cascade with the group (ON DELETE CASCADE). Past orders are
// unaffected: order_item_modifiers snapshots the name and price.
// ============================================================
router.delete(
  '/modifier-groups/:groupId',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const groupId = parseId(req.params.groupId)

    if (groupId === null) {
      return res.status(400).json({
        error: 'Invalid modifier group ID.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const groupResult = await client.query(`
        SELECT
          mg.id,
          mg.name,
          r.owner_id
        FROM modifier_groups mg
        JOIN menu_items mi
          ON mi.id = mg.menu_item_id
        JOIN restaurants r
          ON r.id = mi.restaurant_id
        WHERE mg.id = $1
      `, [groupId])

      if (groupResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Modifier group not found.'
        })
      }

      if (
        req.user.role !== 'admin' &&
        groupResult.rows[0].owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      await client.query(
        'DELETE FROM modifier_groups WHERE id = $1',
        [groupId]
      )

      await client.query('COMMIT')

      res.json({
        message: `Modifier group "${groupResult.rows[0].name}" deleted successfully.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Delete modifier group error:', error)

      res.status(500).json({
        error: 'Server error deleting modifier group.'
      })
    } finally {
      client.release()
    }
  }
)


module.exports = router

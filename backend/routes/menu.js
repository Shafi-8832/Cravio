const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

const router = express.Router()


// ============================================================
// GET /api/menu/restaurants/:restaurantId
// Public
// Returns restaurant + categories + menu items
// ============================================================
router.get('/restaurants/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params // fetch the restaurant ID from the browsers URL

  try {
    // Check that restaurant exists
    const restaurantResult = await pool.query(`
      SELECT
        id,
        name,
        avg_rating
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
        image_url,
        is_available,
        is_veg,
        quality_flag,
        created_at
      FROM menu_items
      WHERE restaurant_id = $1
      ORDER BY name
    `, [restaurantId])

    // Put items inside their respective categories // can be done through SQL ? **
    const categories = categoriesResult.rows.map(category => ({
      ...category,
      items: itemsResult.rows.filter(
        item => item.category_id === category.id
      )
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

    const { restaurantId } = req.params // fetch the ID from the browser URL
    const { name } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'Category name is required.'
      })
    }

    try {
      // Find restaurant and owner
      const restaurantResult = await pool.query(`
        SELECT
          id,
          owner_id
        FROM restaurants
        WHERE id = $1
      `, [restaurantId])

      if (restaurantResult.rows.length === 0) {
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
        return res.status(403).json({
          error: 'You can only modify your own restaurant.'
        })
      }

      const result = await pool.query(`
        INSERT INTO menu_categories
          (restaurant_id, name)
        VALUES ($1, $2)
        RETURNING id, restaurant_id, name
      `, [
        restaurantId,
        name.trim()
      ])

      res.status(201).json({
        category: result.rows[0]
      })

    } catch (error) {
      console.error('Create category error:', error)

      res.status(500).json({
        error: 'Server error creating menu category.'
      })
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

    const { categoryId } = req.params

    const {
      name,
      description,
      price,
      image_url,
      is_veg
    } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'Menu item name is required.'
      })
    }

    if (
      price === undefined ||
      price === null ||
      Number(price) < 0
    ) {
      return res.status(400).json({
        error: 'A valid menu item price is required.'
      })
    }

    try {
      // Find category, restaurant, and owner together

      // SQL NOTE ** : this is a MANY JOIN 1 scenario
      // the frontend is only sending the category ID
      // so in menu_category table (id, restaurant_id, name)
      // from the cat_id == menu_cat.id, grab the restaurant_id
      // go to the restaurant table with this restaurant_id
      // fetch the owner_id of that restaurant
      // check whether the fetched owner_id matches the id sent by frontend 
      // if matches, the request is safe, otherwise not
      const categoryResult = await pool.query(`
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
        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      const result = await pool.query(`
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

      res.status(201).json({
        item: result.rows[0]
      })

    } catch (error) {
      console.error('Create menu item error:', error)

      res.status(500).json({
        error: 'Server error creating menu item.'
      })
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

    const { itemId } = req.params

    const {
      name,
      description,
      price,
      image_url,
      is_veg
    } = req.body

    if (
      price !== undefined &&
      price !== null &&
      Number(price) < 0
    ) {
      return res.status(400).json({
        error: 'Price cannot be negative.'
      })
    }

    try { // ? menu_category + restaurant + menu_items --> 3 relationships or trinary relationship? which is better?
      // Find item + restaurant owner


      // SQL NOTE ** : menu_items has restaurant_id
      // so join restaurant table USING (restaurant_id)
      // after join, you will have the owner_id available in the merged table
      // fetch the owner_id, match it with the owner_id sent from the frontend
      // if matches, safe. otherwise reject

      const itemResult = await pool.query(`
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
        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      const item = itemResult.rows[0]

      if (
        req.user.role !== 'admin' &&
        item.owner_id !== req.user.id
      ) {
        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      // SQL NOTE ** : COALESCE(value1, value2, value3, ......, fall_back) reads data from left to right, returns the first NOT NULL value
      // so if the user left the name field blank then JS passes NULL to $1
      // so the previous name stays

      const result = await pool.query(`
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

      res.json({ // send the 
        item: result.rows[0] // Frontend needs to instantly reflects the changes
      })

    } catch (error) {
      console.error('Update menu item error:', error)

      res.status(500).json({
        error: 'Server error updating menu item.'
      })
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

    const { itemId } = req.params

    try {

      // the API request PATCH from frontend did not contain owner_id
      // we need to find it ourselves
      // join menu_items with restaurants using PK & FK
      // fetch the owner_id by the itemID
      // if the id from frontend matches the owner_id from db --> safe

      const itemResult = await pool.query(`
        SELECT
          mi.id,
          r.owner_id
        FROM menu_items mi
        JOIN restaurants r
          ON mi.restaurant_id = r.id
        WHERE mi.id = $1
      `, [itemId])

      if (itemResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      const item = itemResult.rows[0]

      if (
        req.user.role !== 'admin' &&
        item.owner_id !== req.user.id
      ) {
        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      // SQL NOTE ** : ezzy
      const result = await pool.query(`
        UPDATE menu_items
        SET is_available = NOT is_available
        WHERE id = $1
        RETURNING
          id,
          name,
          is_available
      `, [itemId])

      res.json({
        item: result.rows[0], // nested JSON object
        message: `Item is now ${
          result.rows[0].is_available
            ? 'available'
            : 'unavailable'
        }.`
      })

    } catch (error) {
      console.error('Toggle menu item error:', error)

      res.status(500).json({
        error: 'Server error toggling menu item availability.'
      })
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

    const { itemId } = req.params

    try {
      const itemResult = await pool.query(`
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
        return res.status(404).json({
          error: 'Menu item not found.'
        })
      }

      const item = itemResult.rows[0]

      if (
        req.user.role !== 'admin' &&
        item.owner_id !== req.user.id
      ) {
        return res.status(403).json({
          error: 'You can only modify your own restaurant menu.'
        })
      }

      await pool.query(`
        DELETE FROM menu_items
        WHERE id = $1
      `, [itemId])

      res.json({
        message: `Menu item "${item.name}" deleted successfully.`
      })

    } catch (error) {
      console.error('Delete menu item error:', error)

      res.status(500).json({
        error: 'Server error deleting menu item.'
      })
    }
  }
)


module.exports = router
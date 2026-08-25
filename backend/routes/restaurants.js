const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')

const router = express.Router()


// ============================================================
// GET /api/restaurants
// Public
// Returns every restaurant + owner + number of branches
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { area, city } = req.query

    // 1. Base query (no WHERE clause yet)
    let queryText = `
      SELECT 
        r.id, 
        r.name, 
        r.avg_rating, 
        r.created_at,
        u.name AS owner_name,
        COUNT(rb.id) AS branch_count
      FROM restaurants r
      JOIN users u ON r.owner_id = u.id
      LEFT JOIN restaurant_branches rb ON r.id = rb.restaurant_id
    `
    
    const conditions = []
    const values = []

    // 2. Dynamically add conditions if the user provided them
    if (area) {
      values.push(`%${area}%`)
      conditions.push(`rb.area ILIKE $${values.length}`) // $1
    }

    if (city) {
      values.push(`%${city}%`)
      conditions.push(`rb.city ILIKE $${values.length}`) // $2 (or $1 if no area)
    }

    // 3. Glue the WHERE clause to the base query if needed
    if (conditions.length > 0) {
      queryText += ` WHERE ` + conditions.join(' AND ')
    }

    // 4. Add the grouping and sorting at the very end
    queryText += ` GROUP BY r.id, u.name ORDER BY r.avg_rating DESC`

    const result = await pool.query(queryText, values)
    
    res.json({
      restaurants: result.rows
    })

  } catch (error) {
    console.error('Get restaurants error:', error)
    res.status(500).json({
      error: 'Server error fetching restaurants.'
    })
  }
})


// ============================================================
// GET /api/restaurants/:id
// Public
// Returns one restaurant + branches + menu categories
// ============================================================
router.get('/:id', async (req, res) => {
  const { id } = req.params

  try {
    const restaurantResult = await pool.query(`
      SELECT
        r.id,
        r.name,
        r.avg_rating,
        r.created_at,
        u.name AS owner_name,
        u.phone AS owner_phone
      FROM restaurants r
      JOIN users u
        ON r.owner_id = u.id
      WHERE r.id = $1
    `, [id])

    if (restaurantResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Restaurant not found.'
      })
    }

    const restaurant = restaurantResult.rows[0]

    const branchesResult = await pool.query(`
      SELECT
        id,
        address,
        area,
        city,
        phone,
        latitude,
        longitude,
        is_open
      FROM restaurant_branches
      WHERE restaurant_id = $1
      ORDER BY city
    `, [id])

    const categoriesResult = await pool.query(`
      SELECT
        id,
        name
      FROM menu_categories
      WHERE restaurant_id = $1
      ORDER BY name
    `, [id])

    res.json({
      restaurant: {
        ...restaurant,
        branches: branchesResult.rows,
        categories: categoriesResult.rows
      }
    })

  } catch (error) {
    console.error('Get restaurant error:', error)

    res.status(500).json({
      error: 'Server error fetching restaurant.'
    })
  }
})


// ============================================================
// POST /api/restaurants
// restaurant_owner or admin only
// Creates a restaurant
// ============================================================
router.post(
  '/',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const { name } = req.body

    if (!name) {
      return res.status(400).json({
        error: 'Restaurant name is required.'
      })
    }

    const client = await pool.connect() // dedicated connection only to handle db transactions

    try {
      await client.query('BEGIN')

      const result = await client.query(`
        INSERT INTO restaurants (owner_id, name)
        VALUES ($1, $2)
        RETURNING id, name, avg_rating, created_at
      `, [req.user.id, name])

      await client.query('COMMIT')

      res.status(201).json({
        restaurant: result.rows[0]
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create restaurant error:', error)

      res.status(500).json({
        error: 'Server error creating restaurant.'
      })

    } finally {
      client.release()
    }
  }
)


// ============================================================
// POST /api/restaurants/:id/branches
// restaurant_owner or admin
// Owner can only add branches to their own restaurant
// ============================================================
router.post(
  '/:id/branches',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const { id } = req.params

    const {
      address,
      area,
      city,
      phone,
      latitude,
      longitude
    } = req.body

    if (!address || !area || !city) {
      return res.status(400).json({
        error: 'Address, area, and city are required.'
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const ownerCheck = await client.query(`
        SELECT id
        FROM restaurants
        WHERE id = $1
          AND owner_id = $2
      `, [id, req.user.id])

      if (
        ownerCheck.rows.length === 0 &&
        req.user.role !== 'admin'
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only add branches to your own restaurant.'
        })
      }

      const result = await client.query(`
        INSERT INTO restaurant_branches
        (
          restaurant_id,
          address,
          area,
          city,
          phone,
          latitude,
          longitude
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        id,
        address,
        area,
        city,
        phone,
        latitude,
        longitude
      ])

      await client.query('COMMIT')

      res.status(201).json({
        branch: result.rows[0]
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Create branch error:', error)

      res.status(500).json({
        error: 'Server error creating branch.'
      })

    } finally {
      client.release()
    }
  }
)


// ============================================================
// PATCH /api/restaurants/branches/:branchId/toggle
// Owner/admin only
// Opens or closes a branch
// ============================================================
router.patch(
  '/branches/:branchId/toggle',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const { branchId } = req.params

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      const ownerCheck = await client.query(`
        SELECT rb.id
        FROM restaurant_branches rb
        JOIN restaurants r
          ON rb.restaurant_id = r.id
        WHERE rb.id = $1
          AND r.owner_id = $2
      `, [branchId, req.user.id])

      if (
        ownerCheck.rows.length === 0 &&
        req.user.role !== 'admin'
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'Access denied.'
        })
      }

      const result = await client.query(`
        UPDATE restaurant_branches
        SET is_open = NOT is_open
        WHERE id = $1
        RETURNING id, is_open
      `, [branchId])

      if (result.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Branch not found.'
        })
      }

      await client.query('COMMIT')

      res.json({
        branch: result.rows[0],
        message: `Branch is now ${
          result.rows[0].is_open ? 'open' : 'closed'
        }.`
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Toggle branch error:', error)

      res.status(500).json({
        error: 'Server error toggling branch.'
      })

    } finally {
      client.release()
    }
  }
)


module.exports = router
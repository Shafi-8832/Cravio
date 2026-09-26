const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId, parseCoordinates } = require('../utils/validation')

const router = express.Router()


// ============================================================
// GET /api/restaurants
// Public
// Returns every restaurant + owner + number of branches
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { area = '', city = '', division = '', search = '', cuisine = '' } = req.query
    if ([area, city, division, search, cuisine].some(value => typeof value !== 'string' || value.length > 100)) {
      return res.status(400).json({ error: 'Search filters must be text up to 100 characters.' })
    }
    const limit = req.query.limit === undefined ? 60 : Number(req.query.limit)
    const page = req.query.page === undefined ? 1 : Number(req.query.page)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(page) || page < 1) {
      return res.status(400).json({ error: 'Use a positive page and limit between 1 and 100.' })
    }
    const sort = req.query.sort || 'recommended'
    if (!['recommended','rating','name'].includes(sort) || (req.query.open_only !== undefined && !['true','false'].includes(req.query.open_only))) return res.status(400).json({error:'Invalid sort or open filter.'})
    const orderBy = sort === 'rating' ? 'r.avg_rating DESC NULLS LAST, r.name, r.id' : sort === 'name' ? 'r.name,r.id' : 'r.ordering_enabled DESC,r.name,r.id'
    const result = await pool.query(`
      SELECT r.*, r.avg_rating AS average_rating, u.name AS owner_name,
        COUNT(rb.id)::int AS branch_count,
        COALESCE(json_agg(json_build_object(
          'id',rb.id,'area',rb.area,'city',rb.city,'division',rb.division,
          'is_open',rb.is_open,'delivery_fee',rb.delivery_fee,'min_order_amount',rb.min_order_amount,
          'eta_min',rb.eta_min,'eta_max',rb.eta_max
        ) ORDER BY rb.id) FILTER (WHERE rb.id IS NOT NULL), '[]') AS branches,
        MIN(rb.delivery_fee) AS delivery_fee, MIN(rb.eta_min) AS eta_min, MAX(rb.eta_max) AS eta_max,
        COUNT(*) OVER()::int AS total_count
      FROM restaurants r LEFT JOIN users u ON u.id=r.owner_id
      LEFT JOIN restaurant_branches rb ON rb.restaurant_id=r.id
      WHERE ($1::text='' OR rb.area ILIKE '%' || $1 || '%')
        AND ($2::text='' OR rb.city ILIKE '%' || $2 || '%')
        AND ($3::text='' OR rb.division=$3)
        AND ($4::text='' OR r.name ILIKE '%' || $4 || '%' OR r.cuisine ILIKE '%' || $4 || '%'
          OR rb.area ILIKE '%' || $4 || '%' OR rb.city ILIKE '%' || $4 || '%'
          OR EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id=r.id AND mi.name ILIKE '%' || $4 || '%'))
        AND ($5::text='' OR r.cuisine ILIKE '%' || $5 || '%')
      AND ($8::boolean=false OR (r.ordering_enabled=true AND rb.is_open=true))
      GROUP BY r.id,u.name ORDER BY ${orderBy} LIMIT $6 OFFSET $7
    `, [area, city, division, search, cuisine, limit, (page - 1) * limit, req.query.open_only === 'true'])

    res.json({
      restaurants: result.rows,
      pagination: { page, limit, total: result.rows[0]?.total_count || 0 }
    })

  } catch (error) {
    console.error('Get restaurants error:', error)
    res.status(500).json({
      error: 'Server error fetching restaurants.'
    })
  }
})


// ============================================================
// GET /api/restaurants/mine
// restaurant_owner only
// Returns every restaurant owned by the logged-in user, with branches
// nested inline. This must be declared BEFORE GET /:id, otherwise
// Express would try to parse "mine" as a numeric restaurant id.
// ============================================================
router.get(
  '/mine',
  authenticateToken,
  requireRole('restaurant_owner'),
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          r.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', rb.id,
                'address', rb.address,
                'area', rb.area,
                'city', rb.city,
                'phone', rb.phone,
                'is_open', rb.is_open,
                'division', rb.division,
                'delivery_fee', rb.delivery_fee,
                'min_order_amount', rb.min_order_amount,
                'eta_min', rb.eta_min,
                'eta_max', rb.eta_max,
                -- ::float8 so the pin arrives as a JSON number, not the
                -- string pg uses for NUMERIC.
                'latitude', rb.latitude::float8,
                'longitude', rb.longitude::float8
              ) ORDER BY rb.id
            ) FILTER (WHERE rb.id IS NOT NULL),
            '[]'
          ) AS branches
        FROM restaurants r
        LEFT JOIN restaurant_branches rb
          ON rb.restaurant_id = r.id
        WHERE r.owner_id = $1
        GROUP BY r.id
        ORDER BY r.created_at DESC
      `, [req.user.id])

      res.json({
        restaurants: result.rows
      })

    } catch (error) {
      console.error('Get my restaurants error:', error)

      res.status(500).json({
        error: 'Server error fetching your restaurants.'
      })
    }
  }
)


// ============================================================
// GET /api/restaurants/nearby?lat=&lng=&radius_km=
// Any logged-in user
// Branches within radius_km of the given point, closest first.
// Declared BEFORE GET /:id, otherwise Express would treat "nearby" as an id.
// ============================================================
router.get('/nearby', authenticateToken, async (req, res) => {
  const point = parseCoordinates(req.query.lat, req.query.lng)

  if (point.error) {
    return res.status(400).json({
      error: `Invalid ?lat=&lng= point: ${point.error}`
    })
  }

  // Default 5 km, at most 25 km — beyond that "near me" stops meaning
  // anything in a city, and the result list would just be everything.
  const radiusKm = req.query.radius_km === undefined || req.query.radius_km === ''
    ? 5
    : Number(req.query.radius_km)

  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 25) {
    return res.status(400).json({
      error: 'radius_km must be a number greater than 0 and at most 25.'
    })
  }

  try {
    // ------------------------------------------------------------
    // GRADED COMPLEX QUERY — "restaurants near me".
    // Joins restaurant_branches with restaurants, computes the distance
    // IN SQL with our own distance_km() function, filters by radius and
    // sorts by distance.
    //
    // Why the inner SELECT? A WHERE clause cannot refer to a column alias
    // defined in the same SELECT, so distance_km is computed once in the
    // inner query and then filtered and sorted in the outer one.
    //
    // Rating comes from the stored r.avg_rating column (kept correct by
    // trg_sync_restaurant_rating), not recomputed per row.
    // ------------------------------------------------------------
    const result = await pool.query(`
      SELECT nearby.*
      FROM (
        SELECT
          r.id AS restaurant_id,
          r.name,
          r.cuisine,
          r.image_url,
          r.logo_url,
          r.ordering_enabled,
          r.avg_rating::float8 AS avg_rating,
          r.review_count,
          rb.id AS branch_id,
          rb.area,
          rb.city,
          rb.is_open,
          rb.latitude::float8 AS latitude,
          rb.longitude::float8 AS longitude,
          distance_km($1, $2, rb.latitude, rb.longitude)::float8 AS distance_km
        FROM restaurant_branches rb
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        WHERE rb.latitude IS NOT NULL
          AND rb.longitude IS NOT NULL
      ) AS nearby
      WHERE nearby.distance_km <= $3
      ORDER BY nearby.distance_km ASC, nearby.branch_id
      LIMIT 100
    `, [point.latitude, point.longitude, radiusKm])

    res.json({
      center: { latitude: point.latitude, longitude: point.longitude },
      radius_km: radiusKm,
      branches: result.rows
    })

  } catch (error) {
    console.error('Nearby restaurants error:', error)

    res.status(500).json({
      error: 'Server error finding nearby restaurants.'
    })
  }
})


// ============================================================
// GET /api/restaurants/:id
// Public
// Returns one restaurant + branches + menu categories
// ============================================================
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id)

  if (id === null) {
    return res.status(400).json({
      error: 'Invalid restaurant ID.'
    })
  }

  try {
    const restaurantResult = await pool.query(`
      SELECT
        r.*,
        u.name AS owner_name,

        -- Same stored columns as the list endpoint above, maintained by
        -- trg_sync_restaurant_rating rather than recomputed here.
        r.avg_rating AS average_rating,
        r.review_count
      FROM restaurants r
      LEFT JOIN users u
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
        division, delivery_fee, min_order_amount, eta_min, eta_max,
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

    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
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
        RETURNING id, name, created_at
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

    const id = parseId(req.params.id)

    const {
      address,
      area,
      city,
      phone,
      latitude,
      longitude, division, delivery_fee = 49, min_order_amount = 0, eta_min = 25, eta_max = 45
    } = req.body

    if (id === null) {
      return res.status(400).json({
        error: 'Invalid restaurant ID.'
      })
    }

    if (![address,area,city].every(value => typeof value === 'string' && value.trim() && value.length <= 500) ||
        !['Dhaka','Chattogram','Rajshahi','Khulna','Barishal','Sylhet','Rangpur','Mymensingh'].includes(division) ||
        !Number.isFinite(Number(delivery_fee)) || Number(delivery_fee) < 0 || Number(delivery_fee) > 5000 ||
        !Number.isFinite(Number(min_order_amount)) || Number(min_order_amount) < 0 ||
        !Number.isInteger(eta_min) || !Number.isInteger(eta_max) || eta_min < 1 || eta_max < eta_min || eta_max > 300 ||
        ((latitude == null) !== (longitude == null)) ||
        (latitude != null && (!Number.isFinite(Number(latitude)) || Math.abs(Number(latitude)) > 90)) ||
        (longitude != null && (!Number.isFinite(Number(longitude)) || Math.abs(Number(longitude)) > 180))) {
      return res.status(400).json({
        error: 'Provide address, area, city, division and valid delivery fees, ETA and coordinates.'
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
          longitude, division, delivery_fee, min_order_amount, eta_min, eta_max
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        id,
        address,
        area,
        city,
        phone,
        latitude,
        longitude, division, delivery_fee, min_order_amount, eta_min, eta_max
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

    const branchId = parseId(req.params.branchId)

    if (branchId === null) {
      return res.status(400).json({
        error: 'Invalid branch ID.'
      })
    }

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


// ============================================================
// PATCH /api/restaurants/branches/:branchId/location
// Owner of THIS branch's restaurant, or admin
// Body: { latitude, longitude }
// Sets the branch's map pin — the pickup point used by "near me" and by
// live order tracking.
// ============================================================
router.patch(
  '/branches/:branchId/location',
  authenticateToken,
  requireRole('restaurant_owner', 'admin'),
  async (req, res) => {

    const branchId = parseId(req.params.branchId)

    if (branchId === null) {
      return res.status(400).json({
        error: 'Invalid branch ID.'
      })
    }

    const point = parseCoordinates(req.body.latitude, req.body.longitude)

    if (point.error) {
      return res.status(400).json({
        error: point.error
      })
    }

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // Look the branch up WITH its owner first, so a missing branch (404)
      // and someone else's branch (403) get different answers.
      // FOR UPDATE OF rb locks just the branch row until COMMIT.
      const branchResult = await client.query(`
        SELECT rb.id, r.owner_id
        FROM restaurant_branches rb
        JOIN restaurants r
          ON r.id = rb.restaurant_id
        WHERE rb.id = $1
        FOR UPDATE OF rb
      `, [branchId])

      if (branchResult.rows.length === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'Branch not found.'
        })
      }

      // Object-level ownership check: the owner id comes from the
      // database row, the user id from the verified token.
      if (
        req.user.role !== 'admin' &&
        branchResult.rows[0].owner_id !== req.user.id
      ) {
        await client.query('ROLLBACK')

        return res.status(403).json({
          error: 'You can only set the location of your own branches.'
        })
      }

      const result = await client.query(`
        UPDATE restaurant_branches
        SET latitude = $1,
            longitude = $2
        WHERE id = $3
        RETURNING id, latitude::float8 AS latitude, longitude::float8 AS longitude
      `, [point.latitude, point.longitude, branchId])

      await client.query('COMMIT')

      res.json({
        branch: result.rows[0],
        message: 'Branch location saved.'
      })

    } catch (error) {
      await client.query('ROLLBACK')

      console.error('Set branch location error:', error)

      res.status(500).json({
        error: 'Server error saving branch location.'
      })

    } finally {
      client.release()
    }
  }
)


// Owners may edit their public profile. Directory ownership and approval cannot
// be self-assigned by this endpoint.
router.patch('/:id', authenticateToken, requireRole('restaurant_owner', 'admin'), async (req, res) => {
  const id = parseId(req.params.id)
  const { name, description = '', cuisine = 'Bangladeshi', image_url = '', image_credit = '', image_source_url = '' } = req.body
  if (!id || typeof name !== 'string' || !name.trim() || name.length > 100 ||
    typeof description !== 'string' || description.length > 3000 ||
    typeof cuisine !== 'string' || !cuisine.trim() || cuisine.length > 100 ||
    typeof image_url !== 'string' || image_url.length > 2048 || (image_url && !/^https:\/\/[^\s]+$|^\/media\/[\w-]+\.(jpg|jpeg|png|webp)$/.test(image_url)) ||
    typeof image_credit !== 'string' || image_credit.length > 500 ||
    typeof image_source_url !== 'string' || image_source_url.length > 2048 || (image_source_url && !/^https:\/\/[^\s]+$/.test(image_source_url))) {
    return res.status(400).json({ error: 'Provide a name, cuisine, description and valid HTTPS photo details.' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(`UPDATE restaurants SET name=$1,description=$2,cuisine=$3,
      image_url=$4,image_credit=$5,image_source_url=$6
      WHERE id=$7 AND (owner_id=$8 OR $9='admin') RETURNING *`,
    [name.trim(), description, cuisine.trim(), image_url || null, image_credit || null, image_source_url || null, id, req.user.id, req.user.role])
    if (!result.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Restaurant not found for your account.' })
    }
    await client.query('COMMIT')
    res.json({ restaurant: result.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

module.exports = router

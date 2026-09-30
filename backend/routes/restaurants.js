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

    // is_open here is what the CUSTOMER cares about: the owner's manual
    // switch AND the opening hours (branch_is_open() in SQL), so a branch
    // outside its hours is shown as closed. opens_at/closes_at and the
    // radius are returned so the page can explain why.
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
        opens_at, closes_at, delivery_radius_km::float8 AS delivery_radius_km,
        (COALESCE(is_open, false) AND branch_is_open(opens_at, closes_at)) AS is_open
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
// GET /api/restaurants/:id/reviews/summary
// [GRADED: auth] [GRADED: complex query]
//
// WHAT: returns the star breakdown for one restaurant — how many 1-star
// reviews, how many 2-star, up to 5 — plus the total and the average.
// WHY: the restaurant page wants to draw five bars. Sending the raw reviews
// and counting them in the browser would (a) break the course rule that the
// database does the aggregation, and (b) mean shipping every review just to
// draw five numbers.
// HOW IT FITS: the page's rating button calls this first, draws the bars from
// it, and then calls the paginated list route below for the review text.
//
// authenticateToken is "middleware" — a function Express runs BEFORE this
// handler. It checks the caller's token and either rejects the request or
// attaches the verified account to req.user. Putting it here means an
// anonymous caller never reaches the query.
// ============================================================
router.get('/:id/reviews/summary', authenticateToken, async (req, res) => {

  // parseId turns the text from the URL into a positive integer, or null.
  // Without it, "/api/restaurants/abc/reviews/summary" would hand "abc" to a
  // query expecting an INTEGER and Postgres would raise an error we would
  // surface as a 500 — a server fault — when the caller's request is what was
  // malformed. 400 ("bad request") is the honest code for that.
  const id = parseId(req.params.id)

  if (id === null) {
    return res.status(400).json({
      error: 'Invalid restaurant ID.'
    })
  }

  try {
    // Existence check, deliberately its own query.
    //
    // WHY SEPARATE: the breakdown query below uses generate_series, so it
    // ALWAYS returns five rows — one per star — even for a restaurant that
    // does not exist. That means its result can never tell us apart
    // "restaurant 999 is not real" from "restaurant 7 has no reviews yet".
    // The first deserves 404 (nothing at this address); the second is a
    // perfectly good 200 with five zeros. So we ask the question directly.
    const exists = await pool.query(
      'SELECT id FROM restaurants WHERE id = $1',
      [id]
    )

    if (exists.rows.length === 0) {
      return res.status(404).json({
        error: 'Restaurant not found.'
      })
    }

    // [GRADED: complex query] The whole breakdown in ONE statement.
    //
    // Read it in three parts.
    //
    // 1. scoped_reviews (a CTE — a named temporary result used further down):
    //    restaurant_reviews has no restaurant_id column of its own. A review
    //    belongs to an order, and the order records which BRANCH it was placed
    //    at, and a branch belongs to a restaurant. So reaching "this
    //    restaurant's reviews" means walking review -> order -> branch. Both
    //    are INNER JOINs because a review with no order, or an order with no
    //    branch, is not a review of anything — those rows should disappear.
    //    We stop at restaurant_branches rather than joining restaurants,
    //    because restaurant_branches.restaurant_id already holds the value we
    //    filter on; the extra hop would buy nothing here.
    //
    // 2. generate_series(1, 5) manufactures the five star levels as five rows.
    //    LEFT JOIN (not INNER) is the point of the whole query: LEFT keeps
    //    every row on the left even when nothing on the right matches, so a
    //    star nobody has ever given still comes back with count 0. With INNER
    //    JOIN that star would vanish and the UI would draw four bars for a
    //    five-point scale.
    //
    // 3. GROUP BY stars.star collapses the joined rows into one row per star,
    //    which is what COUNT then counts. COUNT(sr.rating) rather than
    //    COUNT(*) matters: after a LEFT JOIN with no match, the right-hand
    //    columns are NULL, and COUNT of a column skips NULLs — so an unused
    //    star counts 0, whereas COUNT(*) would count the one phantom joined
    //    row and report 1.
    //
    //    SUM(...) OVER () is a "window function": it runs after the grouping
    //    and sums across all five result rows, giving each row the grand
    //    total without a second query. The average is then the weighted mean
    //    of the distribution — sum(star x count) / total — so the number in
    //    the header and the bars underneath it are computed from the same
    //    rows and can never disagree.
    //
    // $1 is a "placeholder": we send the SQL and the value separately, and
    // Postgres treats the value strictly as data. If we pasted the id into
    // the string instead, a caller could send text that ends the statement
    // and starts another one — SQL injection. $1 here will contain the
    // integer from the URL, e.g. 7.
    //
    // Example: a restaurant with two 5-star and one 3-star review returns
    //   star 5 -> count 2, star 4 -> 0, star 3 -> 1, star 2 -> 0, star 1 -> 0
    //   total_reviews 3, average_rating (5*2 + 3*1) / 3 = 4.33
    const breakdown = await pool.query(`
      WITH scoped_reviews AS (
        SELECT rev.rating
        FROM restaurant_reviews rev
        JOIN orders o
          ON o.id = rev.order_id
        JOIN restaurant_branches b
          ON b.id = o.branch_id
        WHERE b.restaurant_id = $1
      )
      SELECT
        stars.star::INTEGER AS star,
        COUNT(sr.rating)::INTEGER AS review_count,
        (SUM(COUNT(sr.rating)) OVER ())::INTEGER AS total_reviews,
        ROUND(
          100.0 * COUNT(sr.rating) / NULLIF(SUM(COUNT(sr.rating)) OVER (), 0),
          1
        ) AS share_pct,
        ROUND(
          SUM(stars.star * COUNT(sr.rating)) OVER ()
            / NULLIF(SUM(COUNT(sr.rating)) OVER (), 0),
          2
        ) AS average_rating
      FROM generate_series(1, 5) AS stars(star)
      LEFT JOIN scoped_reviews sr
        ON sr.rating = stars.star
      GROUP BY stars.star
      ORDER BY stars.star DESC
    `, [id])

    // NULLIF(total, 0) above returns NULL when there are no reviews at all,
    // and anything divided by NULL is NULL — which is how we avoid dividing
    // by zero. That means average_rating and share_pct arrive as null for an
    // unreviewed restaurant, so we read them off the first row and let the
    // client render "no reviews yet" rather than NaN.
    const rows = breakdown.rows

    res.json({
      restaurant_id: id,
      total_reviews: rows[0].total_reviews,
      average_rating: rows[0].average_rating,
      breakdown: rows
    })

  } catch (error) {
    console.error('Review summary error:', error)

    res.status(500).json({
      error: 'Server error fetching the review summary.'
    })
  }
})


// ============================================================
// GET /api/restaurants/:id/reviews?limit=10&offset=0
// [GRADED: auth] [GRADED: complex query]
//
// WHAT: one page of that restaurant's reviews, newest first, with the
// reviewer's display name.
// WHY: a popular restaurant could have thousands of reviews. Returning them
// all would be slow and would send data nobody scrolls to, so the caller asks
// for a window of rows with limit (how many) and offset (how many to skip).
// HOW IT FITS: the drawer calls this after the summary, and calls it again
// with a larger offset each time the visitor presses "Load more".
// ============================================================
router.get('/:id/reviews', authenticateToken, async (req, res) => {

  const id = parseId(req.params.id)

  if (id === null) {
    return res.status(400).json({
      error: 'Invalid restaurant ID.'
    })
  }

  // Pagination validation.
  //
  // WHY: limit and offset are pasted straight into a query that reads rows,
  // so a caller could ask for limit=1000000 and make one request expensive
  // for everyone. Capping it at 50 bounds the work a single request can
  // cause. Rejecting non-numbers is separate from that: Number('abc') is NaN,
  // and passing NaN to Postgres for an INTEGER would fail as a 500, when the
  // real problem is the caller's input — hence 400, not 404: the address
  // /api/restaurants/7/reviews is a real address, the query string is what
  // was wrong.
  const MAX_LIMIT = 50

  const limit = req.query.limit === undefined ? 10 : Number(req.query.limit)
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset)

  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
    return res.status(400).json({
      error: `limit must be a whole number between 0 and ${MAX_LIMIT}.`
    })
  }

  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({
      error: 'offset must be a whole number of 0 or more.'
    })
  }

  try {
    // Same reasoning as the summary route: an empty page of reviews and a
    // restaurant that does not exist both produce zero rows, so existence is
    // asked separately to keep 404 and 200-with-nothing distinguishable.
    const exists = await pool.query(
      'SELECT id FROM restaurants WHERE id = $1',
      [id]
    )

    if (exists.rows.length === 0) {
      return res.status(404).json({
        error: 'Restaurant not found.'
      })
    }

    // [GRADED: complex query] Four tables.
    //
    // The first three joins are the same review -> order -> branch walk the
    // summary uses, for the same reason. The fourth, to users, is how we get
    // the reviewer's name: the review does not store it, the ORDER stores
    // customer_id, so the name lives one hop past the order. All four are
    // INNER JOINs — a review whose order, branch or customer is missing is
    // not displayable, so dropping those rows is correct.
    //
    // THE NAME IS TRIMMED IN SQL, ON PURPOSE. A review is public feedback,
    // not an introduction, so the caller gets "Rahim K." and never the full
    // name, the email or the user id. Doing it here rather than in JavaScript
    // means the full name never leaves the database in the first place — you
    // cannot leak a column you did not select.
    //   split_part(u.name, ' ', 1) takes everything before the first space.
    //   regexp_replace(btrim(u.name), '^.* ', '') strips everything up to the
    //   LAST space, leaving the final word: the greedy .* deliberately eats as
    //   much as it can before the final literal space. left(..., 1) is that
    //   word's first letter.
    //   The pattern uses a literal space rather than the \s shorthand on
    //   purpose: this SQL lives in a JavaScript template literal, and
    //   JavaScript would consume the single backslash before Postgres ever saw
    //   it, turning \s into a plain "s" — which would then strip up to the last
    //   letter s and turn 'Tanvir Ahmed Hossain' into 'Tanvir a.'.
    //   strpos(...) > 0 asks "is there a space at all", so a single-word name
    //   is returned unchanged instead of gaining a stray initial.
    //
    // Example: 'Tanvir Ahmed Hossain' -> 'Tanvir H.'
    //          'Rahim Khan'           -> 'Rahim K.'
    //          'Madonna'              -> 'Madonna'
    //
    // ORDER BY rev.created_at DESC is "newest first". rev.id DESC breaks ties:
    // two reviews written in the same clock tick would otherwise come back in
    // an arbitrary order, and an unstable order across pages can show the
    // same review twice or skip one entirely as the offset moves.
    //
    // COUNT(*) OVER () is a window function again — it returns how many
    // reviews the restaurant has IN TOTAL alongside this page of rows, so the
    // client knows whether to keep showing "Load more" without us running a
    // second counting query.
    //
    // $1 = restaurant id, $2 = how many rows to return (limit),
    // $3 = how many to skip (offset). All three are sent as values, never
    // spliced into the SQL text.
    const reviews = await pool.query(`
      SELECT
        rev.id,
        rev.rating,
        rev.comment,
        rev.created_at,
        rev.owner_reply,
        rev.owner_replied_at,
        split_part(u.name, ' ', 1)
          || CASE
               WHEN strpos(btrim(u.name), ' ') > 0
                 THEN ' ' || left(regexp_replace(btrim(u.name), '^.* ', ''), 1) || '.'
               ELSE ''
             END AS reviewer_name,
        (COUNT(*) OVER ())::INTEGER AS total_reviews
      FROM restaurant_reviews rev
      JOIN orders o
        ON o.id = rev.order_id
      JOIN restaurant_branches b
        ON b.id = o.branch_id
      JOIN users u
        ON u.id = o.customer_id
      WHERE b.restaurant_id = $1
      ORDER BY rev.created_at DESC, rev.id DESC
      LIMIT $2 OFFSET $3
    `, [id, limit, offset])

    // COUNT(*) OVER () only exists on returned rows, so a page past the end
    // comes back empty and has no total to read. Falling back to 0 keeps the
    // response shape identical for every page.
    const total = reviews.rows[0]?.total_reviews ?? 0

    res.json({
      reviews: reviews.rows,
      pagination: {
        total,
        limit,
        offset,
        // Plain boolean so the client does not have to redo this arithmetic.
        // Example: total 23, limit 10, offset 10 -> 10 + 10 = 20 < 23 -> true.
        has_more: offset + reviews.rows.length < total
      }
    })

  } catch (error) {
    console.error('Restaurant reviews error:', error)

    res.status(500).json({
      error: 'Server error fetching reviews.'
    })
  }
})



// ============================================================
// GET /api/restaurants/:id/branches?lat=&lng=
// Any logged-in user
// Every orderable branch of this restaurant, measured from the given
// point, best choice first, plus which one the app should auto-select.
// ============================================================
router.get('/:id/branches', authenticateToken, async (req, res) => {
  // Validate the id and the point first, so bad input is a clear 400 and
  // never reaches SQL. parseCoordinates rejects "abc", NaN, Infinity and
  // out-of-range numbers.
  const restaurantId = parseId(req.params.id)

  if (restaurantId === null) {
    return res.status(400).json({
      error: 'Invalid restaurant ID.'
    })
  }

  const point = parseCoordinates(req.query.lat, req.query.lng)

  if (point.error) {
    return res.status(400).json({
      error: `Invalid ?lat=&lng= point: ${point.error}`
    })
  }

  try {
    // 404 for an unknown restaurant, instead of an empty list that would
    // look like "no branch delivers to you".
    const restaurantResult = await pool.query(
      'SELECT id FROM restaurants WHERE id = $1',
      [restaurantId]
    )

    if (restaurantResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Restaurant not found.'
      })
    }

    // ------------------------------------------------------------
    // GRADED FUNCTION + COMPLEX QUERY — branches_by_distance().
    // The function joins restaurant_branches, restaurants and users,
    // computes each branch's distance with distance_km(), decides
    // is_open / can_deliver, and sorts deliverable-and-nearest first.
    // All of that happens in SQL; this route only reads the rows.
    //
    // ::float8 turns NUMERIC (sent by pg as a string) into JSON numbers.
    // ------------------------------------------------------------
    const result = await pool.query(`
      SELECT
        branch_id,
        branch_name,
        address,
        latitude::float8 AS latitude,
        longitude::float8 AS longitude,
        distance_km::float8 AS distance_km,
        delivery_radius_km::float8 AS delivery_radius_km,
        is_open,
        can_deliver
      FROM branches_by_distance($1, $2, $3)
    `, [restaurantId, point.latitude, point.longitude])

    // The rows are already sorted can_deliver first, then nearest, so the
    // branch to auto-select is simply the first one that can deliver.
    // If none can, selected_branch_id is null and the page explains why.
    const firstDeliverable = result.rows.find(branch => branch.can_deliver)

    res.json({
      restaurant_id: restaurantId,
      location: { latitude: point.latitude, longitude: point.longitude },
      selected_branch_id: firstDeliverable ? firstDeliverable.branch_id : null,
      branches: result.rows
    })

  } catch (error) {
    console.error('Branches by distance error:', error)

    res.status(500).json({
      error: 'Server error finding branches.'
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

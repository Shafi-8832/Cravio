const express = require('express')
const pool = require('../db/pool')
const authenticateToken = require('../middleware/auth')
const requireRole = require('../middleware/roleCheck')
const { parseId } = require('../utils/validation')

const router = express.Router()
const DIVISIONS = ['Dhaka', 'Chattogram', 'Rajshahi', 'Khulna', 'Barishal', 'Sylhet', 'Rangpur', 'Mymensingh']
router.use(authenticateToken)

// GET/PATCH /api/account/profile: role and email cannot be changed through this form.
router.get('/profile', async (req, res) => {
  const result = await pool.query('SELECT id, name, email, phone, role, created_at FROM users WHERE id = $1', [req.user.id])
  res.json({ user: result.rows[0] })
})

router.patch('/profile', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
  const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : ''
  if (!name || name.length > 100 || !/^[0-9+\-\s()]{7,20}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a name (up to 100 characters) and a valid phone number.' })
  }
  const result = await pool.query(
    'UPDATE users SET name = $1, phone = $2 WHERE id = $3 RETURNING id, name, email, phone, role',
    [name, phone, req.user.id]
  )
  res.json({ user: result.rows[0] })
})

router.use(requireRole('customer'))

router.get('/addresses', async (req, res) => {
  const result = await pool.query('SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, id DESC', [req.user.id])
  res.json({ addresses: result.rows })
})

function validateAddress(body) {
  const fields = ['label', 'area', 'full_address', 'division', 'city', 'phone']
  const value = Object.fromEntries(fields.map(key => [key, typeof body[key] === 'string' ? body[key].trim() : '']))
  value.is_default = body.is_default === true
  value.latitude = body.latitude == null || body.latitude === '' ? null : Number(body.latitude)
  value.longitude = body.longitude == null || body.longitude === '' ? null : Number(body.longitude)
  if (!['Home', 'Work', 'Other'].includes(value.label) || !value.area || value.area.length > 100 ||
      value.full_address.length < 5 || value.full_address.length > 500 ||
      !DIVISIONS.includes(value.division) || !value.city || value.city.length > 100 ||
      (value.phone && !/^[0-9+\-\s()]{7,20}$/.test(value.phone)) ||
      (body.is_default !== undefined && typeof body.is_default !== 'boolean') ||
      ((value.latitude === null) !== (value.longitude === null)) ||
      (value.latitude !== null && (!Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90)) ||
      (value.longitude !== null && (!Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180))) return null
  return value
}

async function saveAddress(req, res) {
  const id = req.params.id === undefined ? null : parseId(req.params.id)
  if (req.params.id !== undefined && id === null) return res.status(400).json({ error: 'Invalid address ID.' })
  const value = validateAddress(req.body)
  if (!value) return res.status(400).json({ error: 'Enter a valid label, area, full address, city and Bangladesh division. Coordinates must be a valid pair.' })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock the account, so two requests cannot create two default addresses.
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id])
    if (id) {
      const owned = await client.query('SELECT id FROM customer_addresses WHERE id = $1 AND user_id = $2', [id, req.user.id])
      if (!owned.rowCount) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Address not found.' })
      }
    }
    const count = await client.query('SELECT COUNT(*)::int AS count FROM customer_addresses WHERE user_id = $1', [req.user.id])
    if (!id && count.rows[0].count >= 20) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'You can save up to 20 addresses.' })
    }
    if (!count.rows[0].count) value.is_default = true
    if (value.is_default) await client.query('UPDATE customer_addresses SET is_default = false WHERE user_id = $1', [req.user.id])
    const params = [req.user.id, value.label, value.area, value.full_address, value.division, value.city,
      value.phone || null, value.is_default, value.latitude, value.longitude]
    const result = id
      ? await client.query(`UPDATE customer_addresses SET label=$2, area=$3, full_address=$4,
          division=$5, city=$6, phone=$7, is_default=$8, latitude=$9, longitude=$10
          WHERE user_id=$1 AND id=$11 RETURNING *`, [...params, id])
      : await client.query(`INSERT INTO customer_addresses
          (user_id,label,area,full_address,division,city,phone,is_default,latitude,longitude)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, params)
    await client.query('COMMIT')
    res.status(id ? 200 : 201).json({ address: result.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
router.post('/addresses', saveAddress)
router.patch('/addresses/:id', saveAddress)
router.delete('/addresses/:id', async (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return res.status(400).json({ error: 'Invalid address ID.' })
  const result = await pool.query('DELETE FROM customer_addresses WHERE id=$1 AND user_id=$2 RETURNING id', [id, req.user.id])
  if (!result.rowCount) return res.status(404).json({ error: 'Address not found.' })
  res.status(204).end()
})

router.get('/favorites', async (req, res) => {
  const result = await pool.query(`SELECT r.*, r.avg_rating AS average_rating
    FROM customer_favorites f JOIN restaurants r ON r.id=f.restaurant_id
    WHERE f.user_id=$1 ORDER BY f.created_at DESC`, [req.user.id])
  res.json({ restaurants: result.rows })
})
router.put('/favorites/:restaurantId', async (req, res) => {
  const id = parseId(req.params.restaurantId)
  if (!id) return res.status(400).json({ error: 'Invalid restaurant ID.' })
  const result = await pool.query(`INSERT INTO customer_favorites(user_id,restaurant_id)
    SELECT $1,id FROM restaurants WHERE id=$2
    ON CONFLICT (user_id,restaurant_id) DO UPDATE SET restaurant_id=EXCLUDED.restaurant_id
    RETURNING restaurant_id`, [req.user.id, id])
  if (!result.rowCount) return res.status(404).json({ error: 'Restaurant not found.' })
  res.json({ restaurant_id: id, is_favorite: true })
})
router.delete('/favorites/:restaurantId', async (req, res) => {
  const id = parseId(req.params.restaurantId)
  if (!id) return res.status(400).json({ error: 'Invalid restaurant ID.' })
  await pool.query('DELETE FROM customer_favorites WHERE user_id=$1 AND restaurant_id=$2', [req.user.id, id])
  res.status(204).end()
})

module.exports = router

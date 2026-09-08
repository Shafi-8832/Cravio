// ============================================================
// SHARED INPUT VALIDATION
// ============================================================

// Route params always arrive as strings. Handing one straight to
// Postgres for an INTEGER column means "/api/restaurants/abc" blows up
// as `invalid input syntax for type integer` — a 500 for what is really
// a bad request. Parse and check first, then reject with a 400.
//
// Number() is deliberately not used on its own: Number('') and
// Number(' ') are both 0, and Number('1.5') is 1.5, none of which are
// valid ids. Number.isInteger catches all three.
const parseId = (value) => {
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

module.exports = {
  parseId
}

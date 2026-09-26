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

// One coordinate. Accepts a JSON number, or plain decimal text such as
// "23.8103" (query strings are always text). Anything else — "abc", "",
// true, NaN, Infinity, 1e400 — returns null.
//
// The regex runs BEFORE Number() because Number() is too forgiving on its
// own: Number('') is 0, Number('0x10') is 16 and Number(' 5 ') is 5.
const toCoordinate = (value, min, max) => {
  let parsed = value

  if (typeof value === 'string') {
    if (!/^-?\d{1,3}(\.\d+)?$/.test(value.trim())) {
      return null
    }
    parsed = Number(value)
  }

  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null
  }

  return parsed
}

// A latitude/longitude pair. Returns { latitude, longitude } when both are
// valid, or { error } with a message the client can show as-is.
// The database has the same range CHECKs; validating here as well turns a
// bad value into a clear 400 instead of a constraint-violation 500.
const parseCoordinates = (latitudeValue, longitudeValue) => {
  const latitude = toCoordinate(latitudeValue, -90, 90)
  const longitude = toCoordinate(longitudeValue, -180, 180)

  if (latitude === null) {
    return { error: 'latitude must be a number between -90 and 90.' }
  }

  if (longitude === null) {
    return { error: 'longitude must be a number between -180 and 180.' }
  }

  return { latitude, longitude }
}

module.exports = {
  parseId,
  parseCoordinates
}

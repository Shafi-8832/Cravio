// ============================================================
// SHARED DATE RANGE VALIDATION
//
// Used by every analytics endpoint (owner and admin alike). Both dates
// arrive as text in the query string, so both are validated here before
// they go anywhere near the database. Defaults to the last 30 days
// (today included, which is why it is 29 days back).
// ============================================================
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function toIsoDate(date) {
  return date.toISOString().slice(0, 10)
}

// Returns { from, to } on success, or a string describing what was wrong.
// A real date is demanded, not just the right shape: '2026-02-31' matches
// the pattern but is not a day, and Date rolls it silently into March,
// which would quietly shift the window the caller asked for.
const resolveRange = (query = {}) => {
  const today = new Date()
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 29)

  const from = query.from === undefined || query.from === '' ? toIsoDate(thirtyDaysAgo) : String(query.from)
  const to = query.to === undefined || query.to === '' ? toIsoDate(today) : String(query.to)

  for (const value of [from, to]) {
    if (!DATE_PATTERN.test(value)) return 'Dates must be written as YYYY-MM-DD.'
    const parsed = new Date(value + 'T00:00:00Z')
    if (Number.isNaN(parsed.getTime()) || toIsoDate(parsed) !== value) {
      return 'That is not a real calendar date.'
    }
  }

  if (from > to) return 'The start date must not be after the end date.'

  // A year of days is the most the charts are built to draw, and it also
  // caps how many rows generate_series can be asked to produce.
  const days = (new Date(to) - new Date(from)) / 86400000
  if (days > 366) return 'Choose a range of one year or less.'

  return { from, to }
}

module.exports = { resolveRange }

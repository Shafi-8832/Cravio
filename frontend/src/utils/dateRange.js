// Range helpers shared by the owner and admin dashboards. They live outside
// the component file so it exports nothing but components — React's fast
// refresh only works when a module is components all the way down.

const iso = date => date.toISOString().slice(0, 10)

// "How many days back does this window start." Today is a one-day window,
// so it starts 0 days back.
export const rangeFor = daysBack => {
  const today = new Date()
  const start = new Date(today)
  start.setDate(today.getDate() - daysBack)
  return { from: iso(start), to: iso(today) }
}

export const defaultRange = () => rangeFor(29)

export const PRESETS = [
  { key: 'today', label: 'Today', daysBack: 0 },
  { key: '7', label: '7 days', daysBack: 6 },
  { key: '30', label: '30 days', daysBack: 29 }
]

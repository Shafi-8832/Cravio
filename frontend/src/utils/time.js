// "ends in 2h 14m" style countdowns and "3 days ago" labels for the home page.

// Time left until endsAt, as "2d 5h", "2h 14m", "14m" or "<1m".
// Returns null once the moment has passed, so callers can drop the card.
export function countdownLabel(endsAt, now) {
  const msLeft = new Date(endsAt).getTime() - now
  if (msLeft <= 0) return null
  const minutes = Math.floor(msLeft / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return minutes > 0 ? `${minutes}m` : '<1m'
}

// Less than 3 hours left: the card shows its countdown in the urgent colour.
export const isEndingSoon = (endsAt, now) => new Date(endsAt).getTime() - now < 3 * 3600000

// "today", "yesterday", "3 days ago", "2 weeks ago" ...
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function timeAgo(date, now = Date.now()) {
  const days = Math.round((new Date(date).getTime() - now) / 86400000)
  if (days > -7) return relative.format(days, 'day')
  if (days > -60) return relative.format(Math.round(days / 7), 'week')
  return relative.format(Math.round(days / 30), 'month')
}

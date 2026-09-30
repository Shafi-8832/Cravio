import { useEffect, useState } from 'react'

// The current time as a number, refreshed every minute so countdowns tick.
// deadlines (optional): moments in ms. The hook also refreshes exactly when
// the next one arrives, so an expired deal disappears the instant it ends
// instead of up to a minute late.
export default function useNow(deadlines = []) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])

  // A string key, so a new array with the same times does not reset the timer.
  const deadlineKey = deadlines.join(',')
  useEffect(() => {
    const upcoming = deadlineKey.split(',').map(Number).filter(time => time > now)
    if (upcoming.length === 0) return
    // Only arm the exact timer in the final hour; until then the minute tick
    // above re-runs this effect (now is a dependency). This also keeps the
    // delay far below setTimeout's ~24-day limit. After one deadline passes,
    // the next run sets the timer for the following one.
    const wait = Math.min(...upcoming) - now
    if (wait > 3600000) return
    const timer = setTimeout(() => setNow(Date.now()), wait + 50)
    return () => clearTimeout(timer)
  }, [deadlineKey, now])

  return now
}

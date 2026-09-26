// Helpers for the DEV-only rider simulator (RiderLocationSharing.jsx).
//
// These distances are used ONLY to space out fake GPS points evenly. Every
// distance a user actually sees (km to go, ETA, near me) is still computed
// in SQL by distance_km().

// Metres between two [lat, lng] points (Haversine, Earth radius 6371 km).
function metresBetween(a, b) {
  const toRadians = degrees => degrees * Math.PI / 180
  const dLat = toRadians(b[0] - a[0])
  const dLng = toRadians(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a[0])) * Math.cos(toRadians(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, h)))
}

// OSRM's points are unevenly spaced: many close together at every corner,
// few along a straight road. Walking them one per tick would make the
// scooter crawl round corners and teleport down avenues. This returns new
// points exactly `stepMetres` apart ALONG the route, so the scooter moves at
// a steady speed and still follows every bend.
//
// How: walk each segment of the route, carrying over how far we have gone
// since the last point we emitted, and drop a new point every stepMetres.
export function resampleRoute(points, stepMetres) {
  if (points.length < 2) return points.slice()

  const result = [points[0]]
  // Metres walked since the last emitted point, carried across segments.
  let carried = 0

  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1]
    const end = points[i]
    const segment = metresBetween(start, end)

    // Distance into THIS segment where the next point falls.
    let position = stepMetres - carried
    while (position <= segment) {
      const fraction = position / segment
      result.push([
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
      ])
      position += stepMetres
    }

    // Whatever is left of this segment after the last emitted point.
    carried = segment - (position - stepMetres)
  }

  // Always finish exactly at the drop-off point.
  const last = points[points.length - 1]
  const lastEmitted = result[result.length - 1]
  if (lastEmitted[0] !== last[0] || lastEmitted[1] !== last[1]) result.push(last)

  return result
}

// The old behaviour, kept as the fallback when no road route is available:
// `steps + 1` points on a straight line from `from` to `to`.
export function straightLine(from, to, steps) {
  const result = []
  for (let step = 0; step <= steps; step++) {
    const fraction = step / steps
    result.push([
      from[0] + (to[0] - from[0]) * fraction,
      from[1] + (to[1] - from[1]) * fraction,
    ])
  }
  return result
}

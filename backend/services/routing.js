// ============================================================
// ROAD ROUTING (OSRM)
//
// A map library such as Leaflet only DRAWS lines; it has no idea where the
// roads are. A routing engine does: given two points, it walks the road
// network (here OpenStreetMap's roads) and returns the path a vehicle
// would actually drive. We use OSRM's free public demo server — no API key.
//
// The call is made from the BACKEND, not the browser, so the result can be
// cached in order_routes and shared by everyone watching the same order.
// ============================================================

// Overridable from .env, e.g. to point at a self-hosted OSRM.
const OSRM_BASE_URL = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org'

// Give up after 5 seconds: the tracking page must never hang on an outside service.
const OSRM_TIMEOUT_MS = 5000

// Returns { geometry, distance_m, duration_s } where geometry is an array of
// [lat, lng] pairs, or null if routing failed for ANY reason. It never
// throws, so a routing outage can only ever degrade the map, not break it.
const getRoadRoute = async (fromLat, fromLng, toLat, toLng) => {
  // IMPORTANT — coordinate order.
  // OSRM (like GeoJSON) writes points as LONGITUDE,LATITUDE.
  // Leaflet (and our database columns) use LATITUDE,LONGITUDE.
  // So the URL is built as lng,lat ... and every point in the answer is
  // flipped back to [lat, lng] below. Getting this wrong puts Dhaka routes
  // in the Indian Ocean (lat 90 does not exist; lng 23 is in Africa).
  const url = `${OSRM_BASE_URL}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}` +
    '?overview=full&geometries=geojson'

  // AbortController lets us cancel fetch() when the timer fires.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // The public demo server asks clients to identify themselves.
      headers: { 'User-Agent': 'Cravio-CSE216-coursework' }
    })

    if (!response.ok) {
      console.error(`OSRM routing failed: HTTP ${response.status}`)
      return null
    }

    const body = await response.json()
    const route = body.routes && body.routes[0]

    if (body.code !== 'Ok' || !route || !route.geometry || !Array.isArray(route.geometry.coordinates)) {
      console.error(`OSRM routing failed: code ${body.code}`)
      return null
    }

    // Flip each [lng, lat] from OSRM into [lat, lng] for Leaflet.
    const geometry = route.geometry.coordinates.map(point => [point[1], point[0]])

    if (geometry.length < 2) {
      console.error('OSRM routing failed: route has fewer than 2 points')
      return null
    }

    return {
      geometry,
      distance_m: route.distance,
      duration_s: route.duration
    }
  } catch (error) {
    // AbortError = our 5-second timeout; anything else = network trouble.
    console.error(`OSRM routing failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  getRoadRoute
}

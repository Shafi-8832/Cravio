import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Circle, Marker, Popup } from 'react-leaflet'
import MapView from './MapView'
import { getNearbyRestaurants } from '../../services/restaurantApi'
import { DHAKA_CENTER, restaurantIcon } from '../../utils/leafletSetup'
import { errorMessage } from '../../utils/format'
import { useUserLocation } from '../../context/LocationContext'

// "Near me": find the user's position, ask the server which branches are
// within the chosen radius, and show them on a map and in a list. The
// distances come from distance_km() in SQL — the browser only displays them.
//
// The position comes from the shared LocationContext, so opening this panel
// and then a restaurant page asks for location permission only once.
export default function NearbyRestaurants() {
  const { location, status, requestLocation } = useUserLocation()
  const [radiusKm, setRadiusKm] = useState(5)
  const [branches, setBranches] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Ask once, when the panel opens (does nothing if we already know).
  useEffect(() => { requestLocation() }, [requestLocation])

  // Without a location we search around Dhaka city centre instead.
  let center = null
  let message = 'Finding your location…'
  if (location) {
    center = [location.lat, location.lng]
    message = location.source === 'address' ? 'Using your saved delivery address.' : location.source === 'pin' ? 'Using your last delivery pin.' : ''
  } else if (status === 'unavailable') {
    center = DHAKA_CENTER
    message = 'Could not get your location (permission denied or unavailable), so we are searching around Dhaka city centre instead.'
  }
  // Plain numbers for the effect below: a new [lat, lng] array is created on
  // every render, and depending on it would re-run the query forever.
  const centerLat = center ? center[0] : null
  const centerLng = center ? center[1] : null

  // Re-query whenever the centre or the radius changes.
  useEffect(() => {
    if (centerLat === null) return
    let active = true
    async function load() {
      setLoading(true)
      try {
        const response = await getNearbyRestaurants(centerLat, centerLng, radiusKm)
        if (active) { setBranches(response.data.branches); setError('') }
      } catch (err) {
        if (active) setError(errorMessage(err, 'Could not find nearby restaurants.'))
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [centerLat, centerLng, radiusKm])

  return (
    <section className="surface p-5 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3 className="text-lg font-extrabold">📍 Restaurants near you</h3>
        <label className="text-sm">Within
          <select className="field !w-auto ml-2" value={radiusKm} onChange={event => setRadiusKm(Number(event.target.value))}>
            {[2, 5, 10, 25].map(value => <option key={value} value={value}>{value} km</option>)}
          </select>
        </label>
      </div>
      {message && <p className="text-sm muted mb-3">{message}</p>}
      {error && <p className="notice-error mb-3" role="alert">{error}</p>}
      {center && (
        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-5">
          <MapView center={center} className="h-80 w-full" fitPoints={[center]}>
            <Circle center={center} radius={radiusKm * 1000} pathOptions={{ color: '#ea580c', weight: 1, fillOpacity: 0.05 }} />
            <Marker position={center}><Popup>You are here</Popup></Marker>
            {branches.map(branch => (
              <Marker key={branch.branch_id} position={[branch.latitude, branch.longitude]} icon={restaurantIcon}>
                <Popup>
                  <Link to={'/restaurants/' + branch.restaurant_id}>{branch.name}</Link><br />
                  {branch.area} · {branch.distance_km.toFixed(1)} km
                </Popup>
              </Marker>
            ))}
          </MapView>
          <ul className="space-y-2 max-h-80 overflow-y-auto">
            {loading && <li className="text-sm muted">Searching…</li>}
            {!loading && branches.length === 0 && <li className="text-sm muted">No restaurant branches with a map pin within {radiusKm} km. Try a bigger radius.</li>}
            {branches.map(branch => (
              <li key={branch.branch_id}>
                <Link to={'/restaurants/' + branch.restaurant_id} className="flex justify-between gap-3 border border-stone-200 rounded-lg p-3 hover:border-orange-300">
                  <span>
                    <strong className="block">{branch.name}</strong>
                    <span className="text-xs muted">{branch.area}, {branch.city}{branch.avg_rating !== null && ` · ★ ${branch.avg_rating.toFixed(1)}`}{!branch.is_open && ' · closed'}</span>
                  </span>
                  <span className="font-bold text-orange-700 whitespace-nowrap">{branch.distance_km.toFixed(1)} km</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

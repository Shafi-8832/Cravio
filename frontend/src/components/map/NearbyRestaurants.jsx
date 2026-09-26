import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Circle, Marker, Popup } from 'react-leaflet'
import MapView from './MapView'
import { getNearbyRestaurants } from '../../services/restaurantApi'
import { DHAKA_CENTER, restaurantIcon } from '../../utils/leafletSetup'
import { errorMessage } from '../../utils/format'

// Known before the first render, so it needs no effect.
const HAS_GEOLOCATION = 'geolocation' in navigator

// "Near me": find the user's position, ask the server which branches are
// within the chosen radius, and show them on a map and in a list. The
// distances come from distance_km() in SQL — the browser only displays them.
export default function NearbyRestaurants() {
  // Without GPS support we go straight to Dhaka city centre.
  const [center, setCenter] = useState(HAS_GEOLOCATION ? null : DHAKA_CENTER)
  const [radiusKm, setRadiusKm] = useState(5)
  const [branches, setBranches] = useState([])
  const [message, setMessage] = useState(HAS_GEOLOCATION
    ? 'Finding your location…'
    : 'This browser cannot share your location. Showing Dhaka city centre instead.')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Ask the browser for the position once, when the panel opens.
  useEffect(() => {
    if (!HAS_GEOLOCATION) return
    navigator.geolocation.getCurrentPosition(
      position => {
        setMessage('')
        setCenter([position.coords.latitude, position.coords.longitude])
      },
      geoError => {
        setMessage(geoError.code === 1
          ? 'Location permission was denied, so we are searching around Dhaka city centre instead.'
          : 'Could not get your location, so we are searching around Dhaka city centre instead.')
        setCenter(DHAKA_CENTER)
      },
      { timeout: 15000 }
    )
  }, [])

  // Re-query whenever the centre or the radius changes.
  useEffect(() => {
    if (!center) return
    let active = true
    async function load() {
      setLoading(true)
      try {
        const response = await getNearbyRestaurants(center[0], center[1], radiusKm)
        if (active) { setBranches(response.data.branches); setError('') }
      } catch (err) {
        if (active) setError(errorMessage(err, 'Could not find nearby restaurants.'))
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [center, radiusKm])

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

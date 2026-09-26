import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Marker, Popup } from 'react-leaflet'
import MapView from '../components/map/MapView'
import { getLiveDeliveries } from '../services/adminApi'
import { riderIcon, staleRiderIcon, toLatLng } from '../utils/leafletSetup'
import { errorMessage } from '../utils/format'

const POLL_EVERY_MS = 5000

// Admin "Live deliveries": every order that is out for delivery, all riders
// on one map. Blue = fresh signal, grey = stale (no GPS fix for 60 s, or
// none at all). The counts at the top come from the same SQL statement as
// the list, so they always agree.
export default function AdminLiveDeliveriesPage() {
  const [board, setBoard] = useState(null)
  const [error, setError] = useState('')
  // The points the map zooms to. Replaced only when the NUMBER of riders
  // changes, so the view does not jump every 5 seconds while being read.
  const [fitPoints, setFitPoints] = useState([])

  useEffect(() => {
    let active = true
    async function poll() {
      try {
        const response = await getLiveDeliveries()
        if (!active) return
        setBoard(response.data)
        setError('')
        const points = response.data.deliveries
          .map(item => toLatLng(item.rider_latitude, item.rider_longitude))
          .filter(Boolean)
        setFitPoints(previous => (previous.length === points.length ? previous : points))
      } catch (err) {
        if (active) setError(errorMessage(err, 'Could not load live deliveries.'))
      }
    }
    poll()
    const timer = setInterval(poll, POLL_EVERY_MS)
    // Stop polling when the admin leaves the page.
    return () => { active = false; clearInterval(timer) }
  }, [])

  const deliveries = board?.deliveries || []

  return (
    <main className="page-shell py-9">
      <div className="dashboard-heading flex flex-wrap justify-between gap-4">
        <div><p className="eyebrow mb-2">Refreshes every 5 seconds</p><h1 className="section-heading">Live deliveries 🗺️</h1></div>
        <Link className="btn-secondary self-center" to="/admin">← Control room</Link>
      </div>
      {error && <p className="notice-error mb-5" role="alert">{error}</p>}
      <div className="grid grid-cols-2 gap-4 mb-5 max-w-md">
        <div className="surface p-4"><p className="text-xs muted">Active deliveries</p><p className="text-3xl font-extrabold">{board ? board.active_deliveries : '…'}</p></div>
        <div className="surface p-4"><p className="text-xs muted">Riders with stale signal</p><p className={'text-3xl font-extrabold ' + (board?.stale_riders ? 'text-red-700' : '')}>{board ? board.stale_riders : '…'}</p></div>
      </div>
      <MapView className="h-[28rem] w-full" fitPoints={fitPoints}>
        {deliveries.map(item => {
          const rider = toLatLng(item.rider_latitude, item.rider_longitude)
          if (!rider) return null
          return (
            <Marker key={item.order_id} position={rider} icon={item.is_stale ? staleRiderIcon : riderIcon}>
              <Popup>
                <strong>{item.rider_name}</strong><br />
                Order #{item.order_id} · {item.restaurant_name}<br />
                {item.distance_remaining_km !== null ? item.distance_remaining_km.toFixed(1) + ' km to go' : 'No drop-off pin'}<br />
                {item.is_stale ? '⚠️ Signal stale' : 'Updated ' + item.seconds_since_update + 's ago'}
              </Popup>
            </Marker>
          )
        })}
      </MapView>
      <div className="surface p-5 mt-5 overflow-x-auto">
        {!deliveries.length ? <p className="muted">No orders are out for delivery right now.</p> : (
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b"><th className="p-3">Order</th><th className="p-3">Restaurant</th><th className="p-3">Rider</th><th className="p-3">Distance left</th><th className="p-3">Signal</th></tr></thead>
            <tbody>
              {deliveries.map(item => (
                <tr key={item.order_id} className="border-b">
                  <td className="p-3">#{item.order_id}</td>
                  <td className="p-3">{item.restaurant_name} <span className="muted">· {item.branch_area}</span></td>
                  <td className="p-3">{item.rider_name}</td>
                  <td className="p-3">{item.distance_remaining_km !== null ? item.distance_remaining_km.toFixed(1) + ' km' : '—'}</td>
                  <td className="p-3">
                    {item.rider_latitude === null
                      ? <span className="pill bg-red-50 text-red-900">No location yet</span>
                      : item.is_stale
                        ? <span className="pill bg-red-50 text-red-900">Stale · {item.seconds_since_update}s</span>
                        : <span className="pill bg-green-50 text-green-900">Live · {item.seconds_since_update}s</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  )
}

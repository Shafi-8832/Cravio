import { useEffect, useState } from 'react'
import { Marker, Polyline, Popup } from 'react-leaflet'
import MapView from './MapView'
import useOrderRoute from './useOrderRoute'
import { getOrderTracking } from '../../services/orderApi'
import { OSRM_ATTRIBUTION, boundsCorners, deliveryIcon, restaurantIcon, riderIcon, staleRiderIcon, toLatLng } from '../../utils/leafletSetup'
import { errorMessage } from '../../utils/format'

const POLL_EVERY_MS = 5000

// Live map for one order: restaurant, drop-off point, rider, the planned
// road route (dashed grey) and the trail the rider has actually driven
// (solid blue). "Live" = polling: ask /tracking again every 5 seconds. All
// numbers shown (distance, ETA, seconds ago, stale) are computed by the SQL
// query behind GET /api/orders/:id/tracking. The planned route is fetched
// once from GET /api/orders/:id/route (see useOrderRoute).
export default function LiveTrackingMap({ orderId }) {
  const [tracking, setTracking] = useState(null)
  const [error, setError] = useState('')
  const { route } = useOrderRoute(orderId)

  useEffect(() => {
    let active = true
    let timer = null

    async function poll() {
      try {
        const response = await getOrderTracking(orderId)
        if (!active) return
        const data = response.data.tracking
        setTracking(data)
        setError('')
        // Delivered, cancelled or not picked up yet: there is nothing live to
        // follow, so stop asking.
        if (!data.tracking_active) clearInterval(timer)
      } catch (err) {
        if (!active) return
        setError(errorMessage(err, 'Could not load live tracking.'))
        // 403 / 404 will not fix themselves by asking again.
        const status = err.response?.status
        if (status === 403 || status === 404) clearInterval(timer)
      }
    }

    poll()
    timer = setInterval(poll, POLL_EVERY_MS)

    // Runs when the component unmounts (order collapsed, page left): no
    // request may keep firing in the background after that.
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [orderId])

  if (error) return <p className="notice-error m-5" role="alert">{error}</p>
  if (!tracking) return <p className="text-sm muted p-5">Loading live map…</p>

  if (!tracking.tracking_active) {
    const text = tracking.status === 'delivered'
      ? 'Delivered — live tracking has ended.'
      : tracking.status === 'cancelled'
        ? 'This order was cancelled.'
        : 'Live tracking starts as soon as the rider picks up your food.'
    return <p className="text-sm muted px-5 pt-4">🛵 {text}</p>
  }

  const restaurant = toLatLng(tracking.restaurant_latitude, tracking.restaurant_longitude)
  const dropOff = toLatLng(tracking.delivery_latitude, tracking.delivery_longitude)
  const rider = toLatLng(tracking.rider_latitude, tracking.rider_longitude)
  const trail = tracking.trail.map(point => [point.latitude, point.longitude])

  // The planned path: the road route, or the straight-line fallback the
  // server sends when OSRM is unavailable. Missing pins -> nothing to draw.
  const plannedPath = route?.geometry || []

  // Fit ONCE, after the route request has finished, to the whole planned
  // route plus the rider. Before that, pass nothing so the map does not fit
  // early to a smaller box. (MapView's fitOnce ignores all later changes, so
  // the map never jumps while the user is panning.)
  const fitPoints = route ? boundsCorners([...plannedPath, restaurant, dropOff, rider]) : []

  return (
    <section className="p-5 border-t border-stone-100">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <p className="font-bold">🛵 {tracking.rider_name || 'Your rider'} is on the way</p>
          {tracking.eta_minutes !== null && (
            <p className="text-sm">
              About <strong>{tracking.eta_minutes} min</strong> away · {tracking.distance_remaining_km.toFixed(1)} km to go
            </p>
          )}
          {!dropOff && <p className="text-xs muted">This order has no drop-off pin, so distance and ETA are not available.</p>}
        </div>
        {tracking.seconds_since_update !== null && (
          <span className="text-xs muted">Updated {tracking.seconds_since_update}s ago</span>
        )}
      </div>

      {!rider && <p className="notice-error mb-3">Waiting for the rider's first location…</p>}
      {rider && tracking.is_stale && (
        <p className="notice-error mb-3" role="alert">
          ⚠️ Rider signal lost — the last position is {tracking.seconds_since_update}s old. The marker may be out of date.
        </p>
      )}

      {route && !route.routed && plannedPath.length > 1 && (
        <p className="text-xs muted mb-2">Road route unavailable — showing direct line.</p>
      )}

      <MapView className="h-80 w-full" fitPoints={fitPoints} fitOnce extraAttribution={OSRM_ATTRIBUTION}>
        {restaurant && <Marker position={restaurant} icon={restaurantIcon}><Popup>{tracking.restaurant_name}</Popup></Marker>}
        {dropOff && <Marker position={dropOff} icon={deliveryIcon}><Popup>Drop-off point</Popup></Marker>}
        {/* Planned route first, so the real trail is drawn on top of it. */}
        {plannedPath.length > 1 && <Polyline positions={plannedPath} pathOptions={{ color: '#6b7280', weight: 4, opacity: 0.8, dashArray: '8 8' }} />}
        {trail.length > 1 && <Polyline positions={trail} pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.7 }} />}
        {rider && <Marker position={rider} icon={tracking.is_stale ? staleRiderIcon : riderIcon}><Popup>{tracking.rider_name}</Popup></Marker>}
      </MapView>
    </section>
  )
}

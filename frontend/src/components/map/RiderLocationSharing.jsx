import { useEffect, useRef, useState } from 'react'
import { Marker, Polyline, Popup } from 'react-leaflet'
import MapView from './MapView'
import useOrderRoute from './useOrderRoute'
import { sendRiderLocation } from '../../services/riderApi'
import { OSRM_ATTRIBUTION, boundsCorners, deliveryIcon, restaurantIcon, riderIcon, toLatLng } from '../../utils/leafletSetup'
import { resampleRoute, straightLine } from '../../utils/routeSampling'
import { errorMessage } from '../../utils/format'

// The phone may report a new GPS fix several times a second. The server only
// needs one every 5 seconds, so extra fixes update the local map but are not sent.
const SEND_AT_MOST_EVERY_MS = 5000
// Simulator: one fake GPS point every 3 seconds, ~50 m apart along the road
// (about 60 km/h), or 30 steps on a straight line when there is no road route.
const SIMULATION_STEP_METRES = 50
const STRAIGHT_LINE_STEPS = 30
const SIMULATION_EVERY_MS = 3000

// Shown on the rider's active delivery card: a Start/Stop toggle that shares
// the phone's GPS with PUT /api/rider/location, and a small map of where
// the rider is compared with the pickup, the drop-off and the planned road route.
export default function RiderLocationSharing({ job }) {
  const [sharing, setSharing] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [position, setPosition] = useState(null)
  const [lastSent, setLastSent] = useState(null)
  const [error, setError] = useState('')
  const [simulationNote, setSimulationNote] = useState('')
  // The planned road route, fetched once (cached by the server).
  const { route } = useOrderRoute(job.order_id)

  // Refs, not state: these hold browser handles and timestamps that must
  // survive re-renders but should not cause one when they change.
  const watchIdRef = useRef(null)
  const lastSentAtRef = useRef(0)
  const simulationTimerRef = useRef(null)

  const pickup = toLatLng(job.branch_latitude, job.branch_longitude)
  const dropOff = toLatLng(job.delivery_latitude, job.delivery_longitude)

  async function send(latitude, longitude, accuracy) {
    try {
      await sendRiderLocation({ latitude, longitude, accuracy_m: accuracy ?? undefined })
      setLastSent(new Date())
      setError('')
    } catch (err) {
      setError(errorMessage(err, 'Could not send your location.'))
    }
  }

  function startSharing() {
    if (!('geolocation' in navigator)) {
      setError('This browser cannot share location.')
      return
    }
    setError('')
    watchIdRef.current = navigator.geolocation.watchPosition(
      fix => {
        const { latitude, longitude, accuracy } = fix.coords
        setPosition([latitude, longitude])
        // Throttle: send only if 5 seconds have passed since the last send.
        const now = Date.now()
        if (now - lastSentAtRef.current >= SEND_AT_MOST_EVERY_MS) {
          lastSentAtRef.current = now
          send(latitude, longitude, accuracy)
        }
      },
      geoError => {
        setError(geoError.code === 1
          ? 'Location permission was denied. Allow location for this site to share your position.'
          : 'Could not read your GPS position: ' + geoError.message)
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    )
    setSharing(true)
  }

  function stopSharing() {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
    watchIdRef.current = null
    setSharing(false)
  }

  // DEMO SIMULATOR (development builds only).
  // Only the SOURCE of the coordinates is simulated: instead of the phone's
  // GPS, we walk along the planned road route from GET /api/orders/:id/route,
  // resampled into even ~50 m steps so the scooter moves at a steady speed
  // and follows the streets. Every point goes through the SAME real
  // PUT /api/rider/location call, so the upsert, the trigger, the trail and
  // the customer's map are all real.
  // If no road route is available, fall back to a straight line (the old
  // behaviour) and say so.
  function startSimulation() {
    if (!pickup || !dropOff) return
    let points
    if (route && route.routed) {
      points = resampleRoute(route.geometry, SIMULATION_STEP_METRES)
      setSimulationNote('')
    } else {
      points = straightLine(pickup, dropOff, STRAIGHT_LINE_STEPS)
      setSimulationNote('Road route unavailable — simulating a straight line.')
    }

    let step = 0
    setSimulating(true)
    setError('')
    simulationTimerRef.current = setInterval(() => {
      const [latitude, longitude] = points[step]
      setPosition([latitude, longitude])
      send(latitude, longitude, 5)
      step += 1
      if (step >= points.length) stopSimulation()
    }, SIMULATION_EVERY_MS)
  }

  function stopSimulation() {
    clearInterval(simulationTimerRef.current)
    simulationTimerRef.current = null
    setSimulating(false)
  }

  // On unmount (delivery finished, tab changed, page left) stop the GPS
  // watch and the simulator, so nothing keeps sending in the background.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
      clearInterval(simulationTimerRef.current)
    }
  }, [])

  return (
    <div className="mt-5 border-t border-stone-100 pt-4">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        {sharing
          ? <button type="button" className="btn-secondary" onClick={stopSharing}>⏹ Stop sharing location</button>
          : <button type="button" className="btn-primary" onClick={startSharing} disabled={simulating}>📡 Start sharing location</button>}
        {import.meta.env.DEV && (
          simulating
            ? <button type="button" className="btn-secondary" onClick={stopSimulation}>Stop simulation</button>
            : <button type="button" className="btn-secondary" onClick={startSimulation} disabled={sharing || !pickup || !dropOff}
                title={!pickup || !dropOff ? 'Needs both a pickup pin and a drop-off pin' : 'Dev only: fake GPS, real API'}>
                🧪 Simulate route
              </button>
        )}
        <span className="text-xs muted">
          {lastSent ? 'Last sent ' + lastSent.toLocaleTimeString() : sharing || simulating ? 'Waiting for GPS…' : 'Not sharing'}
        </span>
      </div>
      {job.delivery_status === 'assigned' && (sharing || simulating) && (
        <p className="text-xs muted mb-2">The customer's map starts showing you once you confirm pickup.</p>
      )}
      {simulationNote && <p className="text-xs muted mb-2">{simulationNote}</p>}
      {!simulationNote && route && !route.routed && route.geometry && <p className="text-xs muted mb-2">Road route unavailable — showing direct line.</p>}
      {error && <p className="notice-error mb-3" role="alert">{error}</p>}
      {/* Fit once, after the route has loaded, to the whole planned route. */}
      <MapView className="h-64 w-full" fitPoints={route ? boundsCorners([...(route.geometry || []), pickup, dropOff]) : []} fitOnce extraAttribution={OSRM_ATTRIBUTION}>
        {route?.geometry && <Polyline positions={route.geometry} pathOptions={{ color: '#6b7280', weight: 4, opacity: 0.8, dashArray: '8 8' }} />}
        {pickup && <Marker position={pickup} icon={restaurantIcon}><Popup>Pickup: {job.restaurant_name}</Popup></Marker>}
        {dropOff && <Marker position={dropOff} icon={deliveryIcon}><Popup>Drop-off</Popup></Marker>}
        {position && <Marker position={position} icon={riderIcon}><Popup>You</Popup></Marker>}
      </MapView>
    </div>
  )
}

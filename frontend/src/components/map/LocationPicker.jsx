import { useState } from 'react'
import { Marker, useMapEvents } from 'react-leaflet'
import MapView from './MapView'
import { DHAKA_CENTER, toLatLng } from '../../utils/leafletSetup'

// Listens for clicks on the map and reports where the user clicked.
function ClickToPlace({ onPick }) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng)
    },
  })
  return null
}

// Round to 6 decimals — the precision the NUMERIC(9,6) columns store.
const round6 = value => Math.round(value * 1e6) / 1e6

// Lets the user choose one point: click the map to drop a pin, drag the pin
// to adjust it, or use the browser's GPS.
//
// value:    { latitude, longitude } or null (no pin yet)
// onChange: called with { latitude, longitude } or null
export default function LocationPicker({ value, onChange, className = 'h-72 w-full' }) {
  const [message, setMessage] = useState('')
  const [locating, setLocating] = useState(false)
  // Where the map should jump to after "Use my current location". Clicking
  // and dragging do not set it: the pin is already where the user is looking.
  const [focus, setFocus] = useState(null)

  const pin = value ? toLatLng(value.latitude, value.longitude) : null

  function pick(latitude, longitude) {
    setMessage('')
    onChange({ latitude: round6(latitude), longitude: round6(longitude) })
  }

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setMessage('This browser cannot share your location. Click the map to drop a pin instead.')
      return
    }
    setLocating(true)
    setMessage('')
    navigator.geolocation.getCurrentPosition(
      position => {
        setLocating(false)
        pick(position.coords.latitude, position.coords.longitude)
        setFocus([position.coords.latitude, position.coords.longitude])
      },
      error => {
        setLocating(false)
        // error.code 1 = the user (or the browser settings) said no.
        setMessage(error.code === 1
          ? 'Location permission was denied. No problem — click the map to drop your pin instead.'
          : 'Could not get your location right now. Click the map to drop your pin instead.')
      },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <button type="button" className="btn-secondary" onClick={useMyLocation} disabled={locating}>
          {locating ? 'Finding you…' : '📍 Use my current location'}
        </button>
        {pin && <button type="button" className="text-sm text-stone-500 underline" onClick={() => onChange(null)}>Remove pin</button>}
        <span className="text-xs muted">
          {pin ? `Pin: ${pin[0].toFixed(5)}, ${pin[1].toFixed(5)}` : 'Click the map to drop a pin.'}
        </span>
      </div>
      {message && <p className="notice-error mb-2" role="alert">{message}</p>}
      <MapView center={pin || DHAKA_CENTER} className={className} fitPoints={focus ? [focus] : []}>
        <ClickToPlace onPick={pick} />
        {pin && (
          <Marker
            position={pin}
            draggable
            eventHandlers={{
              dragend(event) {
                const point = event.target.getLatLng()
                pick(point.lat, point.lng)
              },
            }}
          />
        )}
      </MapView>
    </div>
  )
}

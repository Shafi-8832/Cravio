import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { DHAKA_CENTER, OSM_ATTRIBUTION, OSM_TILE_URL } from '../../utils/leafletSetup'

// Zooms the map so every point in `points` is visible. It re-fits only when
// the points themselves change (compared as text), not on every re-render —
// otherwise a map that polls every 5 seconds would keep yanking the view
// away from wherever the user had panned to.
// With `once`, it fits the first time it receives any points and then never
// again, however the points change afterwards.
function FitToPoints({ points, once }) {
  const map = useMap()
  const fitted = useRef(false)
  const key = JSON.stringify(points)

  useEffect(() => {
    const list = JSON.parse(key)
    if (list.length === 0) return
    if (once && fitted.current) return
    fitted.current = true
    if (list.length === 1) map.setView(list[0], 15)
    if (list.length > 1) map.fitBounds(list, { padding: [40, 40], maxZoom: 16 })
  }, [map, key, once])

  return null
}

// The one wrapper every map in the app uses: OpenStreetMap tiles, Dhaka as
// the default centre, and an explicit height. Without a height class the
// Leaflet container renders 0px tall and the map is invisible.
//
// `isolate` gives the map its own stacking layer, so Leaflet's internal
// z-indexes (400+) cannot draw the map over the sticky navbar.
// `extraAttribution` adds a credit (e.g. the routing service) after OSM's.
export default function MapView({ center = DHAKA_CENTER, zoom = 13, className = 'h-96 w-full', fitPoints = [], fitOnce = false, extraAttribution = '', children }) {
  const attribution = extraAttribution ? OSM_ATTRIBUTION + ' | ' + extraAttribution : OSM_ATTRIBUTION
  return (
    <MapContainer center={center} zoom={zoom} scrollWheelZoom className={className + ' rounded-xl isolate'}>
      <TileLayer url={OSM_TILE_URL} attribution={attribution} />
      <FitToPoints points={fitPoints.filter(Boolean)} once={fitOnce} />
      {children}
    </MapContainer>
  )
}

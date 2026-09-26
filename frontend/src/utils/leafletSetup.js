// One-time Leaflet setup shared by every map in the app. Imported by
// components/map/MapView.jsx, so any page that shows a map gets it.
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// Leaflet finds its default marker images by guessing a path from where its
// CSS file lives. Vite bundles those images under hashed file names, so the
// guess fails and every marker shows as a broken image. Importing the PNGs
// gives us their real bundled URLs, and we hand those to Leaflet directly.
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
})

// Every map opens on Dhaka unless it is told otherwise.
export const DHAKA_CENTER = [23.8103, 90.4125]

// OpenStreetMap tiles: free and keyless. Their licence requires the
// attribution line to be visible on the map.
export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// A round coloured badge with an emoji inside. divIcon is plain HTML, so it
// needs no image files at all and can be any colour we like.
function badgeIcon(emoji, background) {
  return L.divIcon({
    className: '',
    html: `<span style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9999px;background:${background};border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.35);font-size:17px">${emoji}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  })
}

export const restaurantIcon = badgeIcon('🍽️', '#ea580c')
export const deliveryIcon = badgeIcon('🏠', '#15803d')
export const riderIcon = badgeIcon('🛵', '#2563eb')
// Stale = no fresh GPS fix for over 60 seconds (decided by the server).
export const staleRiderIcon = badgeIcon('🛵', '#9ca3af')

// [lat, lng] for Leaflet, or null when either half is missing.
export function toLatLng(latitude, longitude) {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) return null
  return [Number(latitude), Number(longitude)]
}

// Credit for the road routes drawn on tracking maps.
export const OSRM_ATTRIBUTION = 'Routing by <a href="https://project-osrm.org/">OSRM</a>'

// The two corners of the box that contains every point: [[south, west], [north, east]].
// Handing Leaflet two corners instead of a 300-point route keeps the
// "fit the map" step cheap.
export function boundsCorners(points) {
  const list = points.filter(Boolean)
  if (list.length === 0) return []
  const lats = list.map(point => point[0])
  const lngs = list.map(point => point[1])
  return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]]
}

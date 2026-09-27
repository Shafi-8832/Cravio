import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { getAddresses } from '../services/accountApi'

// The customer's last known location, shared by every page for this browser
// session: { lat, lng, source } where source is 'device' (GPS), 'address'
// (a saved delivery address) or 'pin' (the drop-off pin set at checkout).
// Kept in sessionStorage so moving between the home page and restaurant
// pages does not ask for location permission again and again.
const LocationContext = createContext(null)

// One entry per account, so a location taken from one customer's saved
// address is never shown to another account signing in on the same tab.
function storageKey(userId) { return 'cravio:location:' + (userId || 'guest') }
function readStoredLocation(userId) {
  try { return JSON.parse(sessionStorage.getItem(storageKey(userId))) || null } catch { return null }
}

// Fallback when GPS is refused: the default saved address if it has a map
// pin, otherwise the first saved address that has one. Only customers have
// saved addresses, so other roles simply get null.
async function locationFromSavedAddress(role) {
  if (role !== 'customer') return null
  const response = await getAddresses()
  const pinned = response.data.addresses.filter(item => item.latitude !== null && item.latitude !== undefined)
  const chosen = pinned.find(item => item.is_default) || pinned[0]
  return chosen ? { lat: Number(chosen.latitude), lng: Number(chosen.longitude), source: 'address' } : null
}

export function LocationProvider({ children }) {
  const { user } = useAuth()
  // Keying resets the state when another account signs in (same as CartProvider).
  return <UserLocation key={user?.id || 'guest'} user={user}>{children}</UserLocation>
}

function UserLocation({ user, children }) {
  const userId = user?.id
  const role = user?.role
  const [location, setLocationState] = useState(() => readStoredLocation(userId))
  // 'idle' (not asked yet) | 'locating' | 'ready' | 'unavailable'
  const [status, setStatus] = useState(() => (readStoredLocation(userId) ? 'ready' : 'idle'))
  // A ref, not state: it only guards against asking twice and never needs a re-render.
  const asked = useRef(false)

  const setLocation = useCallback(next => {
    setLocationState(next)
    setStatus(next ? 'ready' : 'unavailable')
    try { sessionStorage.setItem(storageKey(userId), JSON.stringify(next)) } catch { /* private mode: keep it in memory only */ }
  }, [userId])

  // Ask for the location at most once per session. Pages call this on mount;
  // after the first call it does nothing. force = true is the "Try again" button.
  const requestLocation = useCallback((force = false) => {
    if (asked.current && !force) return
    if (location && !force) return
    asked.current = true
    setStatus('locating')

    const tryFallback = async () => {
      try { setLocation(await locationFromSavedAddress(role)) } catch { setLocation(null) }
    }

    if (!('geolocation' in navigator)) { tryFallback(); return }
    navigator.geolocation.getCurrentPosition(
      position => setLocation({ lat: position.coords.latitude, lng: position.coords.longitude, source: 'device' }),
      () => { tryFallback() },
      { timeout: 15000 }
    )
  }, [location, role, setLocation])

  return <LocationContext.Provider value={{ location, status, requestLocation, setLocation }}>{children}</LocationContext.Provider>
}

export const useUserLocation = () => useContext(LocationContext)

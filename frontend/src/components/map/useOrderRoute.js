import { useEffect, useState } from 'react'
import { getOrderRoute } from '../../services/orderApi'
import { errorMessage } from '../../utils/format'

// Fetches the planned road route for one order, ONCE (per order id).
// Unlike /tracking this is not polled: the route never changes, and the
// server has cached it in order_routes after the first request anyway.
//
// Returns { route, error }:
//   route === null            -> still loading
//   route.routed === true     -> route.geometry is the road path ([lat, lng] pairs)
//   route.routed === false    -> route.reason says why; route.geometry (if any)
//                                is a straight-line fallback
export default function useOrderRoute(orderId) {
  const [route, setRoute] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getOrderRoute(orderId)
      .then(response => { if (active) setRoute(response.data.route) })
      .catch(err => {
        if (!active) return
        setError(errorMessage(err, 'Could not load the planned route.'))
        // Behave like "routing unavailable" so maps still draw what they can.
        setRoute({ routed: false, reason: 'request_failed' })
      })
    return () => { active = false }
  }, [orderId])

  return { route, error }
}

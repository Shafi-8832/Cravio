import { useEffect, useState } from 'react'
import { getHomeBanners, getHomeDeals, getHomePopular, getOrderAgain, getTopRestaurants } from '../../services/homeApi'
import { errorMessage } from '../../utils/format'

// One settled request -> { rows, error }. A failed section keeps its own
// error message and does not take the other sections down with it.
function settle(result, pickRows, fallbackMessage) {
  if (result.status === 'fulfilled') return { rows: pickRows(result.value.data), error: '' }
  return { rows: [], error: errorMessage(result.reason, fallbackMessage) }
}

// Loads every customer home section at once (five requests in parallel).
// Returns null while loading, then { banners, deals, popular, orderAgain, topRated }.
export default function useCustomerHome(enabled) {
  const [sections, setSections] = useState(null)

  useEffect(() => {
    if (!enabled) return
    let active = true
    Promise.allSettled([getHomeBanners(), getHomeDeals(12), getHomePopular(), getOrderAgain(), getTopRestaurants()])
      .then(([banners, deals, popular, orderAgain, topRated]) => {
        if (!active) return
        setSections({
          banners: settle(banners, data => data, 'Could not load today’s offers.'),
          deals: settle(deals, data => data.deals, 'Could not load today’s deals.'),
          popular: settle(popular, data => data.items, 'Could not load popular dishes.'),
          orderAgain: settle(orderAgain, data => data.restaurants, 'Could not load your past restaurants.'),
          topRated: settle(topRated, data => data.restaurants, 'Could not load top-rated restaurants.')
        })
      })
    return () => { active = false }
  }, [enabled])

  return sections
}

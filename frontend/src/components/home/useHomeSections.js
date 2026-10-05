import { useEffect, useState } from 'react'
import { getHomeBanners, getHomeDeals, getHomePopular, getOrderAgain, getTopRestaurants } from '../../services/homeApi'
import { errorMessage } from '../../utils/format'

// One settled request -> { rows, error }. A failed section keeps its own
// error message and does not take the other sections down with it.
function settle(result, pickRows, fallbackMessage) {
  if (result.status === 'fulfilled') return { rows: pickRows(result.value.data), error: '' }
  return { rows: [], error: errorMessage(result.reason, fallbackMessage) }
}

// Loads every home page section at once (requests in parallel), for guests
// and customers alike. "Order again" is one person's own history, so it is
// only requested for a logged-in customer; a guest gets an empty list and
// that rail simply hides itself.
// Returns null while loading, then { banners, deals, popular, orderAgain, topRated }.
export default function useHomeSections(isCustomer) {
  // The result remembers whether it was loaded for a customer or a guest.
  // After logging in or out it no longer matches, so the page shows the
  // loading placeholders instead of the other user's sections.
  const [loaded, setLoaded] = useState({ isCustomer: null, sections: null })

  useEffect(() => {
    let active = true
    const orderAgainRequest = isCustomer ? getOrderAgain() : Promise.resolve({ data: { restaurants: [] } })
    Promise.allSettled([getHomeBanners(), getHomeDeals(12), getHomePopular(), orderAgainRequest, getTopRestaurants()])
      .then(([banners, deals, popular, orderAgain, topRated]) => {
        if (!active) return
        setLoaded({ isCustomer, sections: {
          banners: settle(banners, data => data, 'Could not load today’s offers.'),
          deals: settle(deals, data => data.deals, 'Could not load today’s deals.'),
          popular: settle(popular, data => data.items, 'Could not load popular dishes.'),
          orderAgain: settle(orderAgain, data => data.restaurants, 'Could not load your past restaurants.'),
          topRated: settle(topRated, data => data.restaurants, 'Could not load top-rated restaurants.')
        } })
      })
    return () => { active = false }
  }, [isCustomer])

  return loaded.isCustomer === isCustomer ? loaded.sections : null
}

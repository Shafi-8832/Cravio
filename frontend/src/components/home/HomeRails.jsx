import Rail from './Rail'
import useNow from './useNow'
import { DealCard, DishCard, RestaurantTile } from './HomeCards'

// The four rails under the carousel. `home` is null while loading.
export default function HomeRails({ home }) {
  const loading = home === null

  // Deals whose countdown reached zero are removed. The server already sent
  // only running offers; this only handles offers ending WHILE the page is open.
  const allDeals = home ? home.deals.rows : []
  const now = useNow(allDeals.map(deal => new Date(deal.ends_at).getTime()))
  const liveDeals = allDeals.filter(deal => new Date(deal.ends_at).getTime() > now)

  return <>
    <Rail eyebrow="Limited time" title="Today’s deals" subtitle="Ending soonest first — grab them before the timer runs out." loading={loading} error={home?.deals.error} count={liveDeals.length} cardWidth={260}>
      {liveDeals.map(deal => <DealCard key={deal.offer_id} deal={deal} now={now} />)}
    </Rail>
    <Rail eyebrow="Trending" title="Popular right now" subtitle="Most ordered on Cravio this week, topped up with dishes from top-rated kitchens." loading={loading} error={home?.popular.error} count={home?.popular.rows.length || 0} cardWidth={230}>
      {home?.popular.rows.map(item => <DishCard key={item.item_id} item={item} />)}
    </Rail>
    <Rail eyebrow="Your favourites" title="Order again" subtitle="Restaurants you have ordered from, most recent first." loading={loading} error={home?.orderAgain.error} count={home?.orderAgain.rows.length || 0} cardWidth={280}>
      {home?.orderAgain.rows.map(restaurant => <RestaurantTile key={restaurant.restaurant_id} restaurant={restaurant} variant="again" />)}
    </Rail>
    <Rail eyebrow="Loved by diners" title="Top rated" subtitle="Highest average rating from delivered orders." loading={loading} error={home?.topRated.error} count={home?.topRated.rows.length || 0} cardWidth={280}>
      {home?.topRated.rows.map(restaurant => <RestaurantTile key={restaurant.restaurant_id} restaurant={restaurant} variant="top" />)}
    </Rail>
  </>
}

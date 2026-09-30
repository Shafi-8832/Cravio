import { Link } from 'react-router-dom'
import FoodImage from '../FoodImage'
import Icon from '../Icon'
import { money } from '../../utils/format'
import { countdownLabel, isEndingSoon, timeAgo } from '../../utils/time'

// The cards used by the home page rails. They only DISPLAY what the API sent:
// discounted_price, discount_percent, ordered_qty, ratings and counts all come
// from SQL. Every card links to the restaurant's menu page.

// Price line: the sale price in orange with the old price struck through,
// or just the normal price when there is no offer.
function PriceLine({ price, salePrice }) {
  if (salePrice === null || salePrice === undefined) {
    return <p className="mt-2 text-base font-extrabold text-green-950">{money(price)}</p>
  }
  return <p className="mt-2 flex items-baseline gap-2">
    <span className="text-lg font-extrabold text-orange-700">{money(salePrice)}</span>
    <s className="text-sm text-stone-400">{money(price)}</s>
  </p>
}

function DiscountBadge({ percent }) {
  return <span className="absolute top-3 left-3 rounded-full bg-orange-600 text-white text-xs font-extrabold px-2.5 py-1 shadow-md">-{percent}%</span>
}

// Today's Deals: photo, "-25%" badge, live countdown, old/new price.
export function DealCard({ deal, now }) {
  const label = countdownLabel(deal.ends_at, now)
  const urgent = isEndingSoon(deal.ends_at, now)
  return <Link to={'/restaurants/' + deal.restaurant_id} className="home-card group block w-[240px] sm:w-[260px] shrink-0 snap-start" aria-label={`${deal.item_name} at ${deal.restaurant_name}, ${deal.discount_percent}% off`}>
    <div className="relative h-40 rounded-2xl overflow-hidden bg-stone-100">
      <FoodImage src={deal.image_url} alt={deal.item_name} className="h-full w-full object-cover" />
      <DiscountBadge percent={deal.discount_percent} />
      {label && <span className={'pill absolute bottom-3 left-3 shadow-sm ' + (urgent ? 'bg-red-600 text-white' : 'bg-white/95 text-green-950')}><Icon name="clock" size={13} />ends in {label}</span>}
    </div>
    <div className="pt-3 px-1">
      <h3 className="font-extrabold leading-snug line-clamp-1">{deal.item_name}</h3>
      <p className="text-xs text-stone-500 line-clamp-1 mt-0.5">{deal.restaurant_name}</p>
      <PriceLine price={deal.original_price} salePrice={deal.discounted_price} />
    </div>
  </Link>
}

// Popular Right Now: why it is here ("12 ordered this week" or the
// restaurant's rating) plus the sale price if an offer is running.
export function DishCard({ item }) {
  let tag = 'Recommended'
  if (item.reason === 'popular') tag = `🔥 ${item.ordered_qty} ordered this week`
  else if (item.avg_rating) tag = `★ ${item.avg_rating.toFixed(1)} top-rated kitchen`
  return <Link to={'/restaurants/' + item.restaurant_id} className="home-card group block w-[210px] sm:w-[230px] shrink-0 snap-start" aria-label={`${item.item_name} at ${item.restaurant_name}`}>
    <div className="relative h-36 rounded-2xl overflow-hidden bg-stone-100">
      <FoodImage src={item.image_url} alt={item.item_name} className="h-full w-full object-cover" />
      {item.discount_percent && <DiscountBadge percent={item.discount_percent} />}
      <span className="pill absolute bottom-3 left-3 bg-white/95 text-green-950 shadow-sm">{tag}</span>
    </div>
    <div className="pt-3 px-1">
      <h3 className="font-extrabold leading-snug line-clamp-1">{item.item_name}</h3>
      <p className="text-xs text-stone-500 line-clamp-1 mt-0.5">{item.restaurant_name}</p>
      <PriceLine price={item.original_price} salePrice={item.discounted_price} />
    </div>
  </Link>
}

// Order Again and Top Rated: a restaurant tile with its logo over the photo.
export function RestaurantTile({ restaurant, variant }) {
  const rating = restaurant.avg_rating
  return <Link to={'/restaurants/' + restaurant.restaurant_id} className="home-card group block w-[260px] sm:w-[280px] shrink-0 snap-start" aria-label={'View menu at ' + restaurant.name}>
    <div className="relative h-36 rounded-2xl overflow-hidden bg-stone-100">
      <FoodImage src={restaurant.image_url} alt={restaurant.name} className="h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent" />
      {restaurant.logo_url && <FoodImage src={restaurant.logo_url} alt={restaurant.name + ' logo'} className="absolute bottom-3 left-3 w-12 h-12 object-contain rounded-xl bg-white p-1 shadow-md" />}
      {variant === 'again' && <span className="pill absolute top-3 right-3 bg-white/95 text-green-950 shadow-sm"><Icon name="refresh" size={13} />Order again</span>}
    </div>
    <div className="pt-3 px-1">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-extrabold leading-snug line-clamp-1">{restaurant.name}</h3>
        {rating ? <span className="flex items-center gap-1 text-xs font-bold whitespace-nowrap"><Icon name="star" filled size={13} className="text-orange-500" />{rating.toFixed(1)}<span className="text-stone-400 font-normal">({restaurant.review_count})</span></span> : null}
      </div>
      <p className="text-xs text-stone-500 line-clamp-1 mt-1">
        {variant === 'again'
          ? `${restaurant.order_count} ${restaurant.order_count === 1 ? 'order' : 'orders'} · last ${timeAgo(restaurant.last_order_at)}`
          : `${restaurant.cuisine || 'Local favourites'} · ${restaurant.review_count} ${restaurant.review_count === 1 ? 'review' : 'reviews'}`}
      </p>
    </div>
  </Link>
}

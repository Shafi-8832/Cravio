import { Link } from 'react-router-dom'
import FoodImage from './FoodImage'
import Icon from './Icon'
import { money } from '../utils/format'

export default function RestaurantCard({ restaurant, favorite = false, onFavorite }) {
  const branches = restaurant.branches || []
  const branch = branches.find(item => item.is_open) || branches[0]
  const isOpen = restaurant.is_open ?? branches.some(item => item.is_open)
  const rating = Number(restaurant.avg_rating || 0)
  const divisions = [...new Set(branches.map(item => item.division).filter(Boolean))]
  return <article className="surface restaurant-card overflow-hidden relative">
    <Link to={'/restaurants/' + restaurant.id} className="block" aria-label={'View menu at ' + restaurant.name}>
      <div className="h-[200px] overflow-hidden relative bg-stone-100">
        <FoodImage src={restaurant.image_url} alt={restaurant.name + (restaurant.image_is_illustrative ? ' — illustrative food photo' : '')} className="h-full w-full object-cover" />
        <div className="absolute top-3 left-3 flex gap-2">
          {restaurant.is_demo ? <span className="pill bg-white/95 text-green-900 shadow-sm">Sample restaurant</span> : restaurant.ordering_enabled === false ? <span className="pill bg-white/95 text-stone-700">Directory listing</span> : isOpen && <span className="pill bg-white/95 text-green-800">Open now</span>}
        </div>
        {restaurant.ordering_enabled && branch?.eta_min && <span className="pill absolute bottom-3 right-3 bg-white shadow-sm"><Icon name="clock" size={13} />{branch.eta_min}–{branch.eta_max} min</span>}
      </div>
      <div className="p-5">{restaurant.logo_url && <FoodImage src={restaurant.logo_url} alt={restaurant.name + ' official logo'} className="w-14 h-14 object-contain rounded-lg bg-white border border-stone-100 mb-3" />}
        <div className="flex justify-between items-start gap-3 mb-2"><h3 className="text-lg font-extrabold leading-snug">{restaurant.name}</h3><span className="flex items-center gap-1 text-xs font-bold whitespace-nowrap"><Icon name="star" filled className="text-orange-500" size={13} />{rating > 0 ? rating.toFixed(1) : 'New'}{rating > 0 && <span className="text-stone-400 font-normal">({restaurant.review_count})</span>}</span></div>
        <p className="text-sm text-stone-500 line-clamp-1">{restaurant.cuisine || 'Local favourites'} · {divisions.join(', ') || branch?.city || 'Bangladesh'}</p>
        <div className="flex gap-3 mt-4 pt-3 border-t border-stone-100 text-xs text-stone-500">
          <span className="flex items-center gap-1.5"><Icon name="bike" size={15} />{restaurant.ordering_enabled === false ? 'Not yet on Cravio delivery' : branch ? money(branch.delivery_fee) + ' delivery' : 'See branches'}</span>
          <span className="ml-auto font-medium text-green-800">{restaurant.ordering_enabled === false ? 'View details' : isOpen ? 'View menu' : 'Currently closed'} →</span>
        </div>
      </div>
    </Link>
    {onFavorite && <button onClick={() => onFavorite(restaurant.id, favorite)} className={'icon-button absolute top-3 right-3 !border-0 shadow-sm ' + (favorite ? 'text-orange-600' : 'text-stone-600')} aria-label={(favorite ? 'Remove ' : 'Save ') + restaurant.name + ' to favourites'} aria-pressed={favorite}><Icon name="heart" size={18} filled={favorite} /></button>}
  </article>
}

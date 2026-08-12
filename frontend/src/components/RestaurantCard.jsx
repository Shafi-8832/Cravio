import { useNavigate } from 'react-router-dom'
import StarRating from './StarRating'

const RestaurantCard = ({ restaurant }) => {
  const navigate = useNavigate()

  return (
    <div
      onClick={() => navigate(`/restaurants/${restaurant.id}`)}
      className="bg-white rounded-2xl shadow-sm border border-gray-100 
                 overflow-hidden cursor-pointer hover:shadow-md 
                 hover:-translate-y-1 transition-all duration-200"
    >
      {/* Restaurant image placeholder */}
      <div className="h-40 bg-gradient-to-br from-green-100 to-green-200 
                      flex items-center justify-center">
        <span className="text-5xl">🍽️</span>
      </div>

      {/* Card content */}
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <h3 className="font-bold text-gray-800 text-lg leading-tight">
            {restaurant.name}
          </h3>
          {/* Open/closed badge */}
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${
            restaurant.is_open
              ? 'bg-green-100 text-green-700'
              : 'bg-red-100 text-red-600'
          }`}>
            {restaurant.is_open ? 'Open' : 'Closed'}
          </span>
        </div>

        <StarRating rating={restaurant.avg_rating} />

        <div className="flex items-center justify-between mt-3 
                        text-sm text-gray-500">
          <span>
            {restaurant.branch_count}{' '}
            {restaurant.branch_count === '1' ? 'branch' : 'branches'}
          </span>
          <span className="text-green-700 font-medium">
            View menu →
          </span>
        </div>
      </div>
    </div>
  )
}

export default RestaurantCard
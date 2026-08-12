import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import StarRating from '../components/StarRating'
import LoadingSpinner from '../components/LoadingSpinner'
import api from '../utils/api'

const RestaurantPage = () => {
  // useParams reads the :id from the URL
  // if URL is /restaurants/5, then id = "5"
  const { id } = useParams()
  const navigate = useNavigate()

  const [restaurant, setRestaurant] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // This runs when component loads AND whenever id changes
  // (if user navigates from /restaurants/5 to /restaurants/6)
  useEffect(() => {
    const fetchRestaurant = async () => {
      try {
        const response = await api.get(`/api/restaurants/${id}`)
        setRestaurant(response.data.restaurant)
      } catch (err) {
        if (err.response?.status === 404) {
          setError('Restaurant not found.')
        } else {
          setError('Failed to load restaurant.')
        }
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    fetchRestaurant()
  }, [id]) // re-run if id changes

  if (loading) return <LoadingSpinner message="Loading restaurant..." />

  if (error) return (
    <div className="text-center py-20">
      <p className="text-5xl mb-4">😕</p>
      <p className="text-red-500 text-lg mb-4">{error}</p>
      <button
        onClick={() => navigate('/')}
        className="bg-green-700 text-white px-6 py-2 rounded-lg 
                   hover:bg-green-800 transition-colors"
      >
        Back to Home
      </button>
    </div>
  )

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">

      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-2 text-gray-500 hover:text-gray-700 
                   mb-6 transition-colors"
      >
        ← Back
      </button>

      {/* Restaurant header */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 
                      overflow-hidden mb-6">
        
        {/* Cover image placeholder */}
        <div className="h-48 bg-gradient-to-br from-green-100 to-green-300 
                        flex items-center justify-center">
          <span className="text-7xl">🍽️</span>
        </div>

        <div className="p-6">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-800 mb-2">
                {restaurant.name}
              </h1>
              <StarRating rating={restaurant.avg_rating} />
              <p className="text-gray-500 text-sm mt-2">
                Owner: {restaurant.owner_name}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Branches section */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-800 mb-4">
          📍 Branches
        </h2>

        {restaurant.branches.length === 0 ? (
          <div className="bg-white rounded-xl p-6 text-center 
                          border border-gray-100">
            <p className="text-gray-400">No branches added yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {restaurant.branches.map(branch => (
              <div
                key={branch.id}
                className="bg-white rounded-xl p-4 border border-gray-100 
                           shadow-sm"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-semibold text-gray-800">
                      {branch.area}
                    </p>
                    <p className="text-sm text-gray-500">{branch.city}</p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                    branch.is_open
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-600'
                  }`}>
                    {branch.is_open ? 'Open' : 'Closed'}
                  </span>
                </div>
                <p className="text-sm text-gray-500">{branch.address}</p>
                {branch.phone && (
                  <p className="text-sm text-gray-500 mt-1">
                    📞 {branch.phone}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Menu categories section */}
      <div>
        <h2 className="text-xl font-bold text-gray-800 mb-4">
          🍴 Menu Categories
        </h2>

        {restaurant.categories.length === 0 ? (
          <div className="bg-white rounded-xl p-6 text-center 
                          border border-gray-100">
            <p className="text-gray-400">No menu categories yet.</p>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {restaurant.categories.map(category => (
              <span
                key={category.id}
                className="bg-green-50 text-green-700 px-4 py-2 
                           rounded-full text-sm font-medium border 
                           border-green-200"
              >
                {category.name}
              </span>
            ))}
          </div>
        )}

        {/* Menu items placeholder — you'll build this next milestone */}
        <div className="mt-6 bg-gray-50 rounded-xl p-8 text-center 
                        border border-dashed border-gray-200">
          <p className="text-gray-400">
            Menu items coming soon...
          </p>
        </div>
      </div>

    </div>
  )
}

export default RestaurantPage
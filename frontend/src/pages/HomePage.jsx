import { useState, useEffect } from 'react'
import RestaurantCard from '../components/RestaurantCard'
import LoadingSpinner from '../components/LoadingSpinner'
import api from '../utils/api'

const HomePage = () => {
  // Three states every data-fetching component needs
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedCity, setSelectedCity] = useState('')

  // Search filter — lives in frontend state, no backend call needed
  const [search, setSearch] = useState('')

  // useEffect with empty [] runs once when component first loads
  // Like "componentDidMount" if you've seen that term

  // RUN simple sql and bring all restaurants in Frontend, javascript will search restaurants far more efficiently than db
useEffect(() => {
    const fetchRestaurants = async () => {
      try {
        // --- NEW API CALL ---
        const response = await api.get('/api/restaurants', {
          params: { city: selectedCity || undefined }
        })
        // --------------------
        setRestaurants(response.data.restaurants)
      } catch (err) {
        setError('Failed to load restaurants. Is the backend running?')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    fetchRestaurants()
  }, [selectedCity]) // <--- NEW: Add selectedCity to the array!

  // Filter restaurants by search term (client-side filtering)
  // runs every render — no useEffect needed, it's just a calculation
  const filtered = restaurants.filter(r =>
    r.name.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) return <LoadingSpinner message="Finding restaurants..." />

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">

      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-4xl font-bold text-gray-800 mb-2">
          What are you craving?
        </h1>
        <p className="text-gray-500 text-lg">
          Order food from the best restaurants near you
        </p>
      </div>

      {/* Search bar */}
      <div className="max-w-lg mx-auto mb-10">
        <input
          type="text"
          placeholder="Search restaurants..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-200 rounded-xl px-5 py-3 
                     text-gray-700 focus:outline-none focus:ring-2 
                     focus:ring-green-500 shadow-sm"
        />

        {/* NEW DROPDOWN */}
        <select
          value={selectedCity}
          onChange={(e) => setSelectedCity(e.target.value)}
          className="border border-gray-200 rounded-xl px-4 py-3 
                     focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
        >
          <option value="">All cities</option>
          <option value="Dhaka">Dhaka</option>
          <option value="Chittagong">Chittagong</option>
          <option value="Sylhet">Sylhet</option>
        </select>


      </div>

      {/* Error state */}
      {error && (
        <div className="text-center py-10">
          <p className="text-red-500">{error}</p>
        </div>
      )}

      {/* Empty state — no restaurants at all */}
      {!error && restaurants.length === 0 && (
        <div className="text-center py-20">
          <p className="text-5xl mb-4">🍽️</p>
          <p className="text-gray-500 text-lg">No restaurants yet.</p>
          <p className="text-gray-400 text-sm mt-1">
            Check back soon!
          </p>
        </div>
      )}

      {/* Empty state — search returned nothing */}
      {!error && restaurants.length > 0 && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-5xl mb-4">🔍</p>
          <p className="text-gray-500">
            No restaurants match "{search}"
          </p>
        </div>
      )}

      {/* Restaurant grid */}
      {filtered.length > 0 && (
        <>
          <p className="text-sm text-gray-400 mb-4">
            {filtered.length} restaurant{filtered.length !== 1 ? 's' : ''} found
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map(restaurant => (
              <RestaurantCard
                key={restaurant.id}
                restaurant={restaurant}
              />
            ))}
          </div>
        </>
      )}

    </div>
  )
}

export default HomePage
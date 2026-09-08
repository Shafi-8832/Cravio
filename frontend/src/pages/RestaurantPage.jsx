import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import StarRating from '../components/StarRating'
import LoadingSpinner from '../components/LoadingSpinner'
import ModifierPicker from '../components/ModifierPicker'
import { useCart } from '../context/CartContext' // NEW: to add items to the cart
import { useAuth } from '../context/AuthContext'
import api from '../utils/api'

const RestaurantPage = () => {
  const { id } = useParams()       // reads :id from the URL, e.g. /restaurants/5 -> "5"
  const navigate = useNavigate()
  const { addItem, fetchCart } = useCart()    // NEW: pull the addItem function out of cart context

  const { user } = useAuth()
  const [restaurant, setRestaurant] = useState(null) // restaurant header + branches
  const [menu, setMenu] = useState([])                // NEW: categories WITH their items
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // The item whose modifier picker is currently open, or null for none.
  const [pickerItem, setPickerItem] = useState(null)

  // Message shown when an add is rejected — e.g. an option sold out between
  // loading the menu and pressing Add.
  const [addError, setAddError] = useState('')

  useEffect(() => {
    const fetchRestaurant = async () => {
      try {
        // fire both requests at once instead of one after another — faster page load
        const [restaurantRes, menuRes] = await Promise.all([
          api.get(`/api/restaurants/${id}`),      // header info + branches
          api.get(`/api/menu/restaurants/${id}`)   // NEW: categories + items
        ])
        setRestaurant(restaurantRes.data.restaurant) // store restaurant details
        setMenu(menuRes.data.categories)              // NEW: store categories (each has an `items` array)
                
        if(user?.role === 'customer'){
            try{

                await fetchCart(
                    id,
                    {
                        id: restaurantRes.data.restaurant.id,
                        name: restaurantRes.data.restaurant.name
                    }
                )

            }
            catch(cartError){

                console.error(
                    "Cart loading failed:",
                    cartError
                )

            }
        }
      } catch (err) {
        if (err.response?.status === 404) {
          setError('Restaurant not found.')
        } else {
          setError('Failed to load restaurant.')
        }
        console.error(err) // log the real error for debugging
      } finally {
        setLoading(false) // stop the spinner either way
      }
    }

    fetchRestaurant()
  }, [id]) // re-run if the URL's :id changes

  // Handles the "Add" button click for a single menu item.
  //
  // A dish with modifier groups cannot be added straight from the menu: the
  // backend rejects it if a required group is unanswered. So those open the
  // picker first, and only the picker's confirm actually adds.
  const handleAddToCart = async (item) => {
    setAddError('')

    if (item.modifier_groups?.length > 0) {
      setPickerItem(item)
      return
    }

    try {
      await addItem(item, restaurant.id)
    } catch (err) {
      setAddError(err.response?.data?.error || 'Could not add that item.')
    }
  }

  // Called by the picker once a valid selection has been made.
  const handleConfirmModifiers = async (modifierOptionIds) => {
    try {
      await addItem(pickerItem, restaurant.id, modifierOptionIds)
      setPickerItem(null)
    } catch (err) {
      // Keep the picker open so the customer can adjust their choice rather
      // than losing it — the usual cause is an option selling out.
      setAddError(err.response?.data?.error || 'Could not add that item.')
      setPickerItem(null)
    }
  }

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

      {/* Back button — goes to whatever page the user came from */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-2 text-gray-500 hover:text-gray-700 
                   mb-6 transition-colors"
      >
        ← Back
      </button>

      {/* Restaurant header card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 
                      overflow-hidden mb-6">
        
        {/* cover image placeholder */}
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
              <StarRating rating={0} />
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
            {restaurant.branches.map(branch => ( // one card per branch
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
                  {/* green badge if open, red if closed */}
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                    branch.is_open
                      ? 'bg-green-100 text-green-700'
                      : 'bg-red-100 text-red-600'
                  }`}>
                    {branch.is_open ? 'Open' : 'Closed'}
                  </span>
                </div>
                <p className="text-sm text-gray-500">{branch.address}</p>
                {branch.phone && ( // only show phone row if it exists
                  <p className="text-sm text-gray-500 mt-1">
                    📞 {branch.phone}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Menu section — NEW: replaces the old "coming soon" placeholder */}
      <div>
        <h2 className="text-xl font-bold text-gray-800 mb-4">
          🍴 Menu
        </h2>

        {addError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50
                          px-4 py-3 text-sm text-red-700">
            {addError}
          </div>
        )}

        {menu.length === 0 ? (
          // no categories at all yet
          <div className="bg-white rounded-xl p-6 text-center 
                          border border-gray-100">
            <p className="text-gray-400">No menu items yet.</p>
          </div>
        ) : (
          // loop over each category (e.g. "Starters", "Mains")
          menu.map(category => (
            <div key={category.id} className="mb-8">
              {/* category heading */}
              <h3 className="text-lg font-semibold text-gray-700 mb-3">
                {category.name}
              </h3>

              {category.items.length === 0 ? (
                <p className="text-gray-400 text-sm">No items in this category yet.</p>
              ) : (
                <div className="space-y-3">
                  {/* loop over each item inside this category */}
                  {category.items.map(item => (
                    <div
                      key={item.id}
                      className="bg-white rounded-xl p-4 border border-gray-100
                                 shadow-sm flex items-center justify-between gap-4"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-gray-800">{item.name}</p>
                          {/* small veg/non-veg colored square, common in food apps */}
                          <span className={`inline-block w-2.5 h-2.5 rounded-sm border ${
                            item.is_veg
                              ? 'border-green-600 bg-green-500' // veg = green
                              : 'border-red-600 bg-red-500'      // non-veg = red
                          }`} />
                        </div>
                        {item.description && ( // only render if a description exists
                          <p className="text-sm text-gray-500 mt-1">{item.description}</p>
                        )}
                        <p className="text-sm font-semibold text-gray-700 mt-1">
                          ৳{Number(item.price).toFixed(2)}
                          {/* Signals that the price is a starting point and
                              that pressing Add will ask a question first. */}
                          {item.modifier_groups?.length > 0 && (
                            <span className="text-gray-400 font-normal">
                              {' '}• customisable
                            </span>
                          )}
                        </p>
                      </div>

                      {/* Add button — disabled if the owner marked it unavailable */}
                      {user?.role === 'customer' && (<button
                        onClick={() => handleAddToCart(item)}
                        disabled={!item.is_available}
                        className="bg-green-700 text-white px-4 py-2 rounded-lg
                                   text-sm font-semibold hover:bg-green-800
                                   transition-colors disabled:opacity-40
                                   disabled:cursor-not-allowed disabled:hover:bg-green-700"
                      >
                        {item.is_available
                          ? (item.modifier_groups?.length > 0 ? 'Choose' : 'Add')
                          : 'Unavailable'}
                      </button>)}

                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {pickerItem && (
        <ModifierPicker
          item={pickerItem}
          onCancel={() => setPickerItem(null)}
          onConfirm={handleConfirmModifiers}
        />
      )}

    </div>
  )
}

export default RestaurantPage
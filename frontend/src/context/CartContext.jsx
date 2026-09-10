import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useAuth } from './AuthContext'
import { getCart, addCartItem, adjustCartItem, deleteCartItem } from '../services/cartApi'
import { errorMessage } from '../utils/format'

const CartContext = createContext(null)
function readRestaurant(userId) {
  try { return JSON.parse(localStorage.getItem('cravio:cart:' + userId)) || null } catch { return null }
}
export const CartProvider = ({ children }) => {
  const { user } = useAuth()
  // Keying resets customer state when another account signs in.
  return <CustomerCart key={user?.id || 'guest'} user={user}>{children}</CustomerCart>
}
function CustomerCart({ user, children }) {
  const [items, setItems] = useState([])
  const [restaurant, setRestaurant] = useState(() => user?.role === 'customer' ? readRestaurant(user.id) : null)
  const [loading, setLoading] = useState(Boolean(restaurant))
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const userId = user?.id
  const fetchCart = useCallback(async (id, restaurantInfo = null) => {
    const currentRequest = ++requestId.current
    const response = await getCart(id)
    if (currentRequest !== requestId.current) return
    setItems(response.data.cart)
    setError('')
    if (restaurantInfo) {
      setRestaurant(restaurantInfo)
      localStorage.setItem('cravio:cart:' + userId, JSON.stringify(restaurantInfo))
    }
  }, [userId])
  useEffect(() => {
    if (!restaurant || user?.role !== 'customer') return
    let active = true
    getCart(restaurant.id).then(response => {
      if (active) setItems(response.data.cart)
    }).catch(err => { if (active) setError(errorMessage(err, 'Could not restore your cart.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [restaurant, user?.role])
  const addItem = async (menuItem, id, modifierOptionIds = []) => {
    await addCartItem(id, menuItem.id, 1, modifierOptionIds)
    await fetchCart(id)
  }
  const increaseItem = async itemId => { await adjustCartItem(itemId, 1); await fetchCart(restaurant.id) }
  const removeItem = async itemId => { await deleteCartItem(itemId); await fetchCart(restaurant.id) }
  const decreaseItem = async itemId => {
    const item = items.find(row => row.cart_item_id === itemId)
    if (item?.quantity === 1) return removeItem(itemId)
    await adjustCartItem(itemId, -1)
    await fetchCart(restaurant.id)
  }
  const clearItems = () => setItems([])
  const itemCount = items.reduce((sum, item) => sum + Number(item.quantity), 0)
  const cartTotal = items.reduce((sum, item) => sum + Number(item.line_total ?? Number(item.unit_price ?? item.price) * item.quantity), 0)
  return <CartContext.Provider value={{ restaurant, items, fetchCart, addItem, increaseItem, decreaseItem, removeItem, clearItems, itemCount, cartTotal, loading, error }}>{children}</CartContext.Provider>
}
export const useCart = () => useContext(CartContext)

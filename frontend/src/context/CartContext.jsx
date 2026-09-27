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
      // Re-opening the same restaurant keeps the branch already chosen for
      // this cart; opening a different restaurant starts with no branch.
      setRestaurant(previous => ({ ...restaurantInfo, branch_id: previous?.id === restaurantInfo.id ? previous.branch_id ?? null : null }))
    }
  }, [])
  // The cart is tied to ONE branch: { id, name, branch_id } is remembered
  // per account so the choice survives a page reload.
  useEffect(() => {
    if (userId && restaurant) localStorage.setItem('cravio:cart:' + userId, JSON.stringify(restaurant))
  }, [userId, restaurant])
  // Choose the branch for this restaurant's cart. The menu belongs to the
  // restaurant and is shared by all its branches (menu_items.restaurant_id),
  // so switching branch keeps every item — no "your cart will be cleared"
  // step is needed. restaurantId guards against a late answer for a
  // restaurant the customer has already left.
  const selectBranch = useCallback((restaurantId, branchId) => {
    setRestaurant(previous => (previous && previous.id === restaurantId ? { ...previous, branch_id: branchId } : previous))
  }, [])
  // Depends on the restaurant's id only, so choosing a branch (which changes
  // the restaurant object) does not re-download the cart.
  const cartRestaurantId = restaurant?.id
  useEffect(() => {
    if (!cartRestaurantId || user?.role !== 'customer') return
    let active = true
    getCart(cartRestaurantId).then(response => {
      if (active) setItems(response.data.cart)
    }).catch(err => { if (active) setError(errorMessage(err, 'Could not restore your cart.')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [cartRestaurantId, user?.role])
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
  return <CartContext.Provider value={{ restaurant, items, fetchCart, selectBranch, addItem, increaseItem, decreaseItem, removeItem, clearItems, itemCount, cartTotal, loading, error }}>{children}</CartContext.Provider>
}
export const useCart = () => useContext(CartContext)

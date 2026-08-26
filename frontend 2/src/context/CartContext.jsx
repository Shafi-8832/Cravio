import { createContext, useContext, useState, useEffect } from 'react'

// same pattern as AuthContext — one global place to store cart items
const CartContext = createContext(null)

export const CartProvider = ({ children }) => {
  // cart items look like:
  // { id, name, price, quantity, restaurantId, restaurantName }
  const [items, setItems] = useState(() => {
    // lazy initializer — runs once, reads any previously saved cart
    const saved = localStorage.getItem('cravio_cart') // look for a saved cart
    return saved ? JSON.parse(saved) : []              // parse it, or start empty
  })

  // every time `items` changes, save it back to localStorage
  useEffect(() => {
    localStorage.setItem('cravio_cart', JSON.stringify(items)) // persist cart across refreshes
  }, [items]) // re-run whenever items changes

  // add a menu item to the cart (or bump its quantity if already there)
  const addItem = (menuItem, restaurantId, restaurantName) => {
    setItems(prevItems => {
      // most delivery apps only allow items from ONE restaurant per cart
      const isDifferentRestaurant =
        prevItems.length > 0 && prevItems[0].restaurantId !== restaurantId

      if (isDifferentRestaurant) {
        // ask the user before wiping their existing cart
        const confirmSwitch = window.confirm(
          'Your cart has items from another restaurant. Clear cart and add this item instead?'
        )
        if (!confirmSwitch) return prevItems // user said no — leave cart untouched
        // user said yes — start a fresh cart with just this new item
        return [{
          id: menuItem.id,
          name: menuItem.name,
          price: Number(menuItem.price),
          quantity: 1,
          restaurantId,
          restaurantName
        }]
      }

      // check if this exact item is already in the cart
      const existing = prevItems.find(i => i.id === menuItem.id)

      if (existing) {
        // already in cart — just increase quantity by 1
        return prevItems.map(i =>
          i.id === menuItem.id ? { ...i, quantity: i.quantity + 1 } : i
        )
      }

      // not in cart yet — add it as a new line with quantity 1
      return [
        ...prevItems,
        {
          id: menuItem.id,
          name: menuItem.name,
          price: Number(menuItem.price),
          quantity: 1,
          restaurantId,
          restaurantName
        }
      ]
    })
  }

  // decrease quantity by 1, or remove the item entirely if it hits 0
  const decreaseItem = (itemId) => {
    setItems(prevItems =>
      prevItems
        .map(i => (i.id === itemId ? { ...i, quantity: i.quantity - 1 } : i)) // reduce qty
        .filter(i => i.quantity > 0) // drop any item whose quantity fell to 0
    )
  }

  // remove an item completely regardless of quantity
  const removeItem = (itemId) => {
    setItems(prevItems => prevItems.filter(i => i.id !== itemId)) // keep everything except this id
  }

  // empty the whole cart (e.g. after placing an order, or manually)
  const clearCart = () => {
    setItems([]) // reset to empty array
  }

  // derived values — recalculated on every render, no need for extra state
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0) // total number of items (for the badge)
  const cartTotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0) // total price

  return (
    <CartContext.Provider
      value={{ items, addItem, decreaseItem, removeItem, clearCart, itemCount, cartTotal }}
    >
      {children}
    </CartContext.Provider>
  )
}

// convenience hook: const { items, addItem, cartTotal } = useCart()
export const useCart = () => useContext(CartContext)
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCart } from '../context/CartContext'
import FoodImage from './FoodImage'
import Modal from './Modal'
import { money, errorMessage } from '../utils/format'

function CartContents({ onClose }) {
  const { restaurant, items, increaseItem, decreaseItem, removeItem, cartTotal, loading, error: cartError } = useCart()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  async function change(action, id) {
    setBusy(true); setError('')
    try { await action(id) } catch (err) { setError(errorMessage(err)) }
    finally { setBusy(false) }
  }
  return <Modal label="Your food cart" onClose={onClose}>
    <div className="p-6 flex justify-between items-center border-b"><div><h2 className="text-2xl font-extrabold">Your happy bag 🛍️</h2><p className="text-sm muted mt-1">{restaurant?.name || 'Something delicious belongs here.'}</p></div><button className="icon-button" onClick={onClose} aria-label="Close cart">×</button></div>
    <div className="p-6 max-h-[55vh] overflow-y-auto">
      {(error || cartError) && <p className="notice-error mb-4" role="alert">{error || cartError}</p>}
      {loading ? <p>Loading your cart…</p> : !items.length ? <div className="text-center py-10"><p className="text-6xl mb-5">🍕</p><p>Your cart is waiting for its first bite.</p><Link to="/" onClick={onClose} className="btn-primary mt-5">Explore restaurants</Link></div> : items.map(item => <div key={item.cart_item_id} className="flex gap-3 py-4 border-b border-stone-100">
        <FoodImage src={item.image_url} alt={item.name} className="w-20 h-20 rounded-xl object-cover shrink-0" />
        <div className="flex-1"><p className="font-bold">{item.name}</p><p className="text-xs muted">{item.modifiers?.map(mod => mod.name).join(', ')}</p><p className="font-semibold mt-2">{money(item.line_total)}</p><div className="flex items-center gap-3 mt-2"><button disabled={busy} className="icon-button !w-8 !h-8" onClick={() => change(decreaseItem, item.cart_item_id)} aria-label={'Decrease ' + item.name}>−</button><span>{item.quantity}</span><button disabled={busy} className="icon-button !w-8 !h-8" onClick={() => change(increaseItem, item.cart_item_id)} aria-label={'Increase ' + item.name}>+</button><button disabled={busy} className="text-xs text-red-600 ml-auto" onClick={() => change(removeItem, item.cart_item_id)}>Remove</button></div></div>
      </div>)}
    </div>
    {items.length > 0 && <div className="p-6 bg-stone-50"><div className="flex justify-between font-bold mb-2"><span>Subtotal</span><span>{money(cartTotal)}</span></div><p className="text-xs muted mb-4">Delivery fees and discounts appear at checkout.</p><button disabled={busy} onClick={() => { onClose(); navigate('/checkout') }} className="btn-primary w-full">🍽️ Go to checkout</button></div>}
  </Modal>
}
export default function CartDrawer({ isOpen, onClose }) { return isOpen ? <CartContents onClose={onClose} /> : null }

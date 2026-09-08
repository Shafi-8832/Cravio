import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCart } from '../context/CartContext'
import { placeOrder } from '../services/orderApi'
import api from '../utils/api'
import LoadingSpinner from '../components/LoadingSpinner'

const CheckoutPage = () => {
  const { restaurant, items, cartTotal, fetchCart } = useCart()
  const navigate = useNavigate()

  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash_on_delivery')
  const [promoCode, setPromoCode] = useState('')

  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Branches aren't in the cart context, so fetch the restaurant fresh to
  // know which branches are currently open and orderable.
  useEffect(() => {
    const loadBranches = async () => {
      if (!restaurant) {
        setLoading(false)
        return
      }

      try {
        const res = await api.get(`/api/restaurants/${restaurant.id}`)
        const openBranches = res.data.restaurant.branches.filter(b => b.is_open)

        setBranches(openBranches)

        if (openBranches.length > 0) {
          setBranchId(String(openBranches[0].id))
        }
      } catch (err) {
        setError('Failed to load restaurant branches.')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    loadBranches()
  }, [restaurant])

  if (loading) return <LoadingSpinner message="Loading checkout..." />

  if (!restaurant || items.length === 0) {
    return (
      <div className="text-center py-20 px-4">
        <p className="text-5xl mb-4">🛒</p>
        <p className="text-gray-500 text-lg mb-4">Your cart is empty.</p>
        <button
          onClick={() => navigate('/')}
          className="bg-green-700 text-white px-6 py-2 rounded-lg
                     hover:bg-green-800 transition-colors"
        >
          Browse restaurants
        </button>
      </div>
    )
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!branchId) {
      setError('Please select a branch.')
      return
    }

    if (!deliveryAddress.trim()) {
      setError('Delivery address is required.')
      return
    }

    setSubmitting(true)

    try {
      const res = await placeOrder({
        branch_id: Number(branchId),
        delivery_address: deliveryAddress.trim(),
        payment_method: paymentMethod,
        promo_code: promoCode.trim() || undefined
      })

      // The backend already emptied the cart as part of the transaction;
      // refresh so the UI (badge count, drawer) reflects that.
      await fetchCart(restaurant.id)

      navigate('/orders', {
        state: { justPlacedOrderId: res.data.order.id }
      })
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to place order.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Checkout</h1>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}

      {/* Order summary */}
      <div className="bg-white rounded-xl border border-gray-100 p-5 mb-6">
        <h2 className="font-semibold text-gray-700 mb-3">{restaurant.name}</h2>

        {items.map(item => (
          <div
            key={item.cart_item_id}
            className="flex justify-between text-sm text-gray-600 py-1"
          >
            <span>{item.quantity} × {item.name}</span>
            <span>৳{(Number(item.price) * item.quantity).toFixed(2)}</span>
          </div>
        ))}

        <div className="flex justify-between font-bold text-gray-800 mt-3 pt-3 border-t border-gray-100">
          <span>Subtotal</span>
          <span>৳{cartTotal.toFixed(2)}</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 bg-white rounded-xl border border-gray-100 p-5">

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Branch
          </label>

          {branches.length === 0 ? (
            <p className="text-sm text-red-500">
              No open branches available right now.
            </p>
          ) : (
            <select
              value={branchId}
              onChange={e => setBranchId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2
                         focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
            >
              {branches.map(b => (
                <option key={b.id} value={b.id}>
                  {b.area}, {b.city} — {b.address}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Delivery address
          </label>
          <textarea
            value={deliveryAddress}
            onChange={e => setDeliveryAddress(e.target.value)}
            rows={3}
            placeholder="House, road, area..."
            required
            className="w-full border border-gray-300 rounded-lg px-4 py-2
                       focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Payment method
          </label>
          <select
            value={paymentMethod}
            onChange={e => setPaymentMethod(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-4 py-2
                       focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
          >
            <option value="cash_on_delivery">Cash on delivery</option>
            <option value="bkash">bKash</option>
            <option value="nagad">Nagad</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Promo code (optional)
          </label>
          <input
            value={promoCode}
            onChange={e => setPromoCode(e.target.value)}
            placeholder="e.g. WELCOME10"
            className="w-full border border-gray-300 rounded-lg px-4 py-2
                       focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || branches.length === 0}
          className="w-full bg-green-700 text-white py-3 rounded-lg
                     font-semibold hover:bg-green-800 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Placing order...' : `Place order — ৳${cartTotal.toFixed(2)}`}
        </button>
      </form>
    </div>
  )
}

export default CheckoutPage

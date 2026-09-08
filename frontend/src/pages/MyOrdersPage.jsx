import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { getMyOrders, getOrderDetails } from '../services/orderApi'
import LoadingSpinner from '../components/LoadingSpinner'

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-blue-100 text-blue-700',
  preparing: 'bg-orange-100 text-orange-700',
  out_for_delivery: 'bg-purple-100 text-purple-700',
  delivered: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600'
}

const MyOrdersPage = () => {
  const location = useLocation()

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // If we just landed here right after placing an order, auto-expand it
  const [expandedId, setExpandedId] = useState(location.state?.justPlacedOrderId || null)
  const [details, setDetails] = useState({})

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError('')

      try {
        const res = await getMyOrders({ status: statusFilter || undefined })
        setOrders(res.data.orders)
      } catch (err) {
        setError('Failed to load your orders.')
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [statusFilter])

  const toggleExpand = async (orderId) => {
    if (expandedId === orderId) {
      setExpandedId(null)
      return
    }

    setExpandedId(orderId)

    if (!details[orderId]) {
      try {
        const res = await getOrderDetails(orderId)
        setDetails(prev => ({ ...prev, [orderId]: res.data.order }))
      } catch (err) {
        console.error(err)
      }
    }
  }

  if (loading) return <LoadingSpinner message="Loading your orders..." />

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">My Orders</h1>

      <div className="mb-6">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="border border-gray-200 rounded-xl px-4 py-2 bg-white
                     focus:outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">All statuses</option>
          {Object.keys(STATUS_COLORS).map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-500 mb-4">{error}</p>}

      {orders.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-5xl mb-4">📦</p>
          <p className="text-gray-500">No orders yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map(order => (
            <div
              key={order.id}
              className="bg-white rounded-xl border border-gray-100 shadow-sm"
            >
              <button
                onClick={() => toggleExpand(order.id)}
                className="w-full flex items-center justify-between p-4 text-left"
              >
                <div>
                  <p className="font-semibold text-gray-800">{order.restaurant_name}</p>
                  <p className="text-sm text-gray-400">
                    {new Date(order.created_at).toLocaleString()} · {order.item_count} item(s)
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-gray-800">
                    ৳{Number(order.total_amount).toFixed(2)}
                  </p>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium capitalize ${
                    STATUS_COLORS[order.status] || 'bg-gray-100 text-gray-600'
                  }`}>
                    {order.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </button>

              {expandedId === order.id && (
                <div className="border-t border-gray-100 p-4">
                  {!details[order.id] ? (
                    <p className="text-sm text-gray-400">Loading details...</p>
                  ) : (
                    <>
                      <p className="text-sm text-gray-500 mb-2">
                        Deliver to: {details[order.id].delivery_address}
                      </p>

                      <div className="space-y-1">
                        {details[order.id].items.map(item => (
                          <div
                            key={item.id}
                            className="flex justify-between text-sm text-gray-600"
                          >
                            <span>{item.quantity} × {item.name}</span>
                            <span>৳{Number(item.line_total).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>

                      {details[order.id].payment && (
                        <p className="text-sm text-gray-400 mt-3">
                          Payment: {details[order.id].payment.method.replace(/_/g, ' ')}
                          {' '}({details[order.id].payment.status})
                        </p>
                      )}

                      {details[order.id].delivery?.rider_name && (
                        <p className="text-sm text-gray-400">
                          Rider: {details[order.id].delivery.rider_name}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default MyOrdersPage

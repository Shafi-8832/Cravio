import { useState, useEffect, useCallback } from 'react'
import LoadingSpinner from '../components/LoadingSpinner'
import {
  getAvailableDeliveries,
  getMyDeliveries,
  acceptDelivery,
  updateDeliveryStatus
} from '../services/riderApi'

const RiderDashboardPage = () => {
  const [tab, setTab] = useState('available')

  const [available, setAvailable] = useState([])
  const [mine, setMine] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const flashNotice = (message) => {
    setNotice(message)
    setTimeout(() => setNotice(''), 3000)
  }

  const loadAvailable = useCallback(async () => {
    try {
      const res = await getAvailableDeliveries()
      setAvailable(res.data.deliveries)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load available deliveries.')
    }
  }, [])

  const loadMine = useCallback(async () => {
    try {
      const res = await getMyDeliveries()
      setMine(res.data.deliveries)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load your deliveries.')
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      await Promise.all([loadAvailable(), loadMine()])
      setLoading(false)
    }

    load()
  }, [loadAvailable, loadMine])

  const handleAccept = async (orderId) => {
    setError('')

    try {
      await acceptDelivery(orderId)
      await Promise.all([loadAvailable(), loadMine()])
      flashNotice('Delivery accepted.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to accept delivery.')
    }
  }

  const handleStatusUpdate = async (orderId, status) => {
    setError('')

    try {
      await updateDeliveryStatus(orderId, status)
      await loadMine()
      flashNotice('Delivery updated.')
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update delivery.')
    }
  }

  if (loading) return <LoadingSpinner message="Loading deliveries..." />

  const activeDeliveries = mine.filter(d => d.delivery_status !== 'delivered')
  const pastDeliveries = mine.filter(d => d.delivery_status === 'delivered')

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-800 mb-1">Rider Dashboard</h1>
      <p className="text-gray-500 mb-6">Accept nearby deliveries and update their status.</p>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-green-50 text-green-700 px-4 py-3 rounded-lg mb-4 text-sm">
          {notice}
        </div>
      )}

      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {['available', 'active', 'history'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-semibold capitalize border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-green-700 text-green-700'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'available' && (
        available.length === 0 ? (
          <p className="text-gray-400">No deliveries ready for pickup right now.</p>
        ) : (
          <div className="space-y-3">
            {available.map(d => (
              <div
                key={d.order_id}
                className="bg-white rounded-xl border border-gray-100 p-4
                           flex items-center justify-between flex-wrap gap-3"
              >
                <div>
                  <p className="font-semibold text-gray-800">{d.restaurant_name}</p>
                  <p className="text-sm text-gray-400">
                    {d.branch_area}, {d.branch_city} → {d.delivery_address}
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    ৳{Number(d.total_amount).toFixed(2)}
                  </p>
                </div>
                <button
                  onClick={() => handleAccept(d.order_id)}
                  className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm
                             font-semibold hover:bg-green-800"
                >
                  Accept
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'active' && (
        activeDeliveries.length === 0 ? (
          <p className="text-gray-400">No active deliveries.</p>
        ) : (
          <div className="space-y-3">
            {activeDeliveries.map(d => (
              <div
                key={d.delivery_id}
                className="bg-white rounded-xl border border-gray-100 p-4
                           flex items-center justify-between flex-wrap gap-3"
              >
                <div>
                  <p className="font-semibold text-gray-800">{d.restaurant_name}</p>
                  <p className="text-sm text-gray-400">
                    {d.branch_area}, {d.branch_city} → {d.delivery_address}
                  </p>
                  <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1
                                    rounded-full font-medium capitalize mt-1 inline-block">
                    {d.delivery_status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="flex gap-2">
                  {d.delivery_status === 'assigned' && (
                    <button
                      onClick={() => handleStatusUpdate(d.order_id, 'picked_up')}
                      className="bg-green-700 text-white px-3 py-1 rounded-full text-xs
                                 font-semibold hover:bg-green-800"
                    >
                      Mark picked up
                    </button>
                  )}
                  {d.delivery_status === 'picked_up' && (
                    <button
                      onClick={() => handleStatusUpdate(d.order_id, 'delivered')}
                      className="bg-green-700 text-white px-3 py-1 rounded-full text-xs
                                 font-semibold hover:bg-green-800"
                    >
                      Mark delivered
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'history' && (
        pastDeliveries.length === 0 ? (
          <p className="text-gray-400">No completed deliveries yet.</p>
        ) : (
          <div className="space-y-3">
            {pastDeliveries.map(d => (
              <div
                key={d.delivery_id}
                className="bg-white rounded-xl border border-gray-100 p-4"
              >
                <p className="font-semibold text-gray-800">{d.restaurant_name}</p>
                <p className="text-sm text-gray-400">
                  Delivered {d.delivery_time ? new Date(d.delivery_time).toLocaleString() : ''}
                </p>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

export default RiderDashboardPage

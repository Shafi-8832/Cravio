import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import OwnerAnalytics from '../components/OwnerAnalytics'
import { getMyRestaurants } from '../services/ownerApi'
import { errorMessage } from '../utils/format'

// Standalone analytics page. The picker only lists restaurants the server
// returned for this owner, and picking one still proves nothing: the
// analytics endpoint re-checks ownership on every request.
export default function OwnerAnalyticsPage() {
  const navigate = useNavigate()
  const [restaurants, setRestaurants] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMyRestaurants()
      .then(response => {
        const list = response.data.restaurants || []
        setRestaurants(list)
        setSelectedId(list[0]?.id || null)
      })
      .catch(err => setError(errorMessage(err)))
      .finally(() => setLoading(false))
  }, [])

  return <main className="page-shell py-9">
    <div className="dashboard-heading flex justify-between items-center gap-3">
      <div>
        <p className="eyebrow mb-2">How the kitchen is doing</p>
        <h1 className="section-heading">Analytics 📊</h1>
      </div>
      <Link className="btn-secondary" to="/owner">Back to the studio</Link>
    </div>

    {error && <p className="notice-error mb-5" role="alert">{error}</p>}

    {loading ? <p className="surface p-6">Loading your restaurants…</p>
      : !restaurants.length ? <p className="surface p-6 text-sm muted">
        You have no restaurants yet. <Link className="font-bold text-orange-700" to="/owner">Create one first →</Link>
      </p>
        : <>
          {restaurants.length > 1 && <label className="text-sm block mb-5 max-w-xs">Restaurant
            <select className="field mt-1" value={selectedId || ''} onChange={event => setSelectedId(Number(event.target.value))}>
              {restaurants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>}
          <OwnerAnalytics
            restaurantId={selectedId}
            // The order list lives in the studio, so send the visitor there
            // with the status they clicked already applied.
            onStatusSelect={status => navigate('/owner', { state: { tab: 'orders', status } })}
          />
        </>}
  </main>
}

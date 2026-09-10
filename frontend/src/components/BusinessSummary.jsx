import { useEffect, useState } from 'react'
import { getSummary } from '../services/operationsApi'
import { errorMessage, money } from '../utils/format'
export default function BusinessSummary({ rider = false }) {
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { getSummary().then(result => setSummary(result.data.summary)).catch(err => setError(errorMessage(err))) }, [])
  if (error) return <p className="notice-error mb-5">{error}</p>
  if (!summary) return <p className="muted mb-5 text-sm">Loading totals…</p>
  const values = rider ? [['Deliveries', summary.delivered_count], ['Assigned orders', summary.order_count], ['Delivery fees collected', money(summary.collected_delivery_fees)]] : [['Orders', summary.order_count], ['Delivered', summary.delivered_count], ['Cancelled', summary.cancelled_count], ['Collected order value', money(summary.collected_total)]]
  return <div className="mb-6"><div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{values.map(([label, value]) => <div key={label} className="surface p-5"><p className="text-xs muted">{label}</p><p className="text-2xl font-extrabold mt-2">{value}</p></div>)}</div><p className="text-xs muted mt-2">Totals include delivered, paid orders. These are gross collections, not profit or rider payouts.</p></div>
}

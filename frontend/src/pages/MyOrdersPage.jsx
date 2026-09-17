import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getMyOrders } from '../services/orderApi'
import OrderReceipt from '../components/OrderReceipt'
import { money, errorMessage } from '../utils/format'

export default function MyOrdersPage() {
  const location = useLocation()
  const [orders, setOrders] = useState([])
  const [expanded, setExpanded] = useState(location.state?.justPlacedOrderId || location.state?.openOrderId || null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState(null)
  const load = useCallback(async () => {
    try { const response = await getMyOrders({ status: filter || undefined, page }); setOrders(response.data.orders); setPagination(response.data.pagination); setError('') }
    catch (err) { setError(errorMessage(err)) } finally { setLoading(false) }
  }, [filter, page])
  // The effect starts remote I/O; load updates state after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => clearInterval(timer) }, [load])
  return <main className="page-shell max-w-4xl py-9"><div className="dashboard-heading"><p className="eyebrow mb-2">From our kitchens to your doorstep</p><h1 className="section-heading">Your orders 🛵</h1><p className="text-sm muted mt-3">Follow your meal, check your receipt, and share your feedback.</p></div>
    {location.state?.justPlacedOrderId && <p className="notice-success mb-5">Order #{location.state.justPlacedOrderId} placed. The restaurant will confirm it shortly.</p>}
    <div className="flex justify-between gap-4 mb-5"><label className="text-sm">Filter <select className="field !w-auto ml-2" value={filter} onChange={event => { setFilter(event.target.value); setPage(1) }}><option value="">All orders</option>{['pending', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'].map(status => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></label><button className="btn-secondary" onClick={load}>Refresh</button></div>
    {error && <p className="notice-error mb-4" role="alert">{error}</p>}
    {loading ? <p className="surface p-8">Loading your orders…</p> : !orders.length ? <div className="surface p-10 text-center"><p className="text-5xl mb-4">🍱</p><p>No orders to show yet.</p><Link to="/" className="btn-primary mt-4">Explore restaurants</Link></div> : <div className="space-y-4">{orders.map(order => <article key={order.id} className="surface overflow-hidden"><button onClick={() => setExpanded(expanded === order.id ? null : order.id)} aria-expanded={expanded === order.id} className="w-full p-5 text-left flex justify-between items-center gap-4"><div><p className="font-extrabold text-lg">{order.restaurant_name}</p><p className="text-xs muted mt-2">#{order.id} · {new Date(order.created_at).toLocaleString()}</p></div><div className="text-right"><p className="font-bold">{money(order.total_amount)}</p><span className="pill bg-green-50 text-green-900 mt-2 capitalize">{order.status.replaceAll('_', ' ')}</span></div></button>{expanded === order.id && <OrderReceipt id={order.id} onChanged={load} />}</article>)}</div>}
    {pagination && <div className="flex justify-center items-center gap-5 mt-6"><button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span className="text-sm">Page {page}</span><button className="btn-secondary" disabled={page >= (pagination.total_pages || 1)} onClick={() => setPage(page + 1)}>Next</button></div>}
  </main>
}

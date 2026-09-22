import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getUsers, updateUserStatus } from '../services/adminApi'
import { getPromos, createPromo, togglePromo, getPlatformOrders } from '../services/operationsApi'
import BusinessSummary from '../components/BusinessSummary'
import SupportPanel from '../components/SupportPanel'
import OrderReceipt from '../components/OrderReceipt'
import { useAuth } from '../context/AuthContext'
import { errorMessage, money } from '../utils/format'
const emptyPromo = { code: '', discount_percent: 10, min_order_amount: 0, expiry_date: '', usage_limit: 100 }
export default function AdminDashboardPage() {
  const { user } = useAuth()
  const [tab, setTab] = useState('orders')
  const [users, setUsers] = useState([])
  const [orders, setOrders] = useState([])
  const [promos, setPromos] = useState([])
  const [form, setForm] = useState(emptyPromo)
  const [role, setRole] = useState('')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const load = useCallback(async () => {
    try {
      if (tab === 'users') { const response = await getUsers({ role: role || undefined, page }); setUsers(response.data.users); setHasMore(page < response.data.pagination.total_pages) }
      if (tab === 'orders') { const response = await getPlatformOrders({ page }); setOrders(response.data.orders); setHasMore(page * 30 < response.data.pagination.total) }
      if (tab === 'promos') setPromos((await getPromos()).data.promos)
    } catch (err) { setError(errorMessage(err)) }
  }, [tab, role, page])
  // The effect starts remote I/O; load updates state after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])
  async function act(operation) {
    setBusy(true); setError('')
    try { await operation(); await load() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return <main className="page-shell py-9"><div className="dashboard-heading"><p className="eyebrow mb-2">Keep the good food moving</p><h1 className="section-heading">Cravio control room 🍊</h1></div><BusinessSummary />
    <div className="flex flex-wrap gap-3 mb-6">{['orders', 'users', 'promos', 'support'].map(value => <button key={value} className={(tab === value ? 'btn-primary' : 'btn-secondary') + ' capitalize'} onClick={() => { setTab(value); setPage(1) }}>{value}</button>)}<Link className="btn-secondary ml-auto" to="/admin/analytics">📈 Analytics</Link><button className="btn-secondary" onClick={load}>Refresh</button></div>{error && <p role="alert" className="notice-error mb-5">{error}</p>}
    {tab === 'support' && <SupportPanel admin />}
    {tab === 'orders' && <div className="space-y-4">{!orders.length && <p className="surface p-8 muted">No orders yet.</p>}{orders.map(order => <article key={order.id} className="surface"><button className="p-5 w-full flex justify-between text-left gap-4" onClick={() => setExpanded(expanded === order.id ? null : order.id)}><span><strong>#{order.id} · {order.restaurant_name}</strong><span className="block text-sm muted mt-2">{order.customer_name} · {order.division}</span></span><span className="text-right"><strong>{money(order.total_amount)}</strong><span className="block text-sm mt-2 capitalize">{order.status.replaceAll('_', ' ')} · {order.payment_status}</span></span></button>{expanded === order.id && <OrderReceipt id={order.id} onChanged={load} />}</article>)}</div>}
    {tab === 'users' && <section className="surface p-5"><label className="field-label">Account role<select className="field !w-auto ml-3" value={role} onChange={event => { setRole(event.target.value); setPage(1) }}><option value="">All roles</option>{['customer', 'restaurant_owner', 'rider', 'admin'].map(value => <option key={value}>{value}</option>)}</select></label><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Account</th><th className="p-3">Role</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead><tbody>{users.map(account => <tr key={account.id} className="border-b"><td className="p-3"><strong>{account.name}</strong><span className="block muted">{account.email}</span></td><td className="p-3">{account.role}</td><td className="p-3">{account.is_active ? 'Active' : 'Suspended'}</td><td className="p-3"><button disabled={busy || account.id === user.id} className="btn-secondary" onClick={() => act(() => updateUserStatus(account.id, !account.is_active))}>{account.is_active ? 'Suspend' : 'Reactivate'}</button></td></tr>)}</tbody></table></div></section>}
    {tab === 'promos' && <div className="grid lg:grid-cols-2 gap-6"><form className="surface p-6 space-y-3" onSubmit={event => { event.preventDefault(); act(async () => { await createPromo({ ...form, code: form.code.toUpperCase(), discount_percent: Number(form.discount_percent), min_order_amount: Number(form.min_order_amount), usage_limit: Number(form.usage_limit) }); setForm(emptyPromo) }) }}><h2 className="text-xl font-bold">🏷️ Create a promo</h2>{[['code', 'Code', 'text'], ['discount_percent', 'Discount percent', 'number'], ['min_order_amount', 'Minimum food subtotal', 'number'], ['usage_limit', 'Total uses', 'number'], ['expiry_date', 'Expiry date', 'date']].map(([key, label, type]) => <label key={key} className="field-label">{label}<input required className="field mt-1" type={type} maxLength={20} value={form[key]} min={key === 'min_order_amount' ? 0 : 1} max={key === 'discount_percent' ? 100 : undefined} onChange={event => setForm({ ...form, [key]: event.target.value })} /></label>)}<button disabled={busy} className="btn-primary">Create promo</button></form><div className="space-y-4">{promos.map(promo => <article key={promo.id} className="surface p-5"><div className="flex justify-between"><h3 className="font-bold">{promo.code} · {promo.discount_percent}%</h3><button className="text-sm text-orange-700" disabled={busy} onClick={() => act(() => togglePromo(promo.id, !promo.is_active))}>{promo.is_active ? 'Disable' : 'Enable'}</button></div><p className="text-sm muted mt-3">Minimum {money(promo.min_order_amount)} · {promo.used_count}/{promo.usage_limit} uses</p><p className="text-xs muted mt-2">Expires {String(promo.expiry_date).slice(0, 10)} · {promo.is_active ? 'Active' : 'Disabled'}</p></article>)}</div></div>}
    {['orders', 'users'].includes(tab) && <div className="flex justify-center items-center gap-4 mt-6"><button className="btn-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page}</span><button className="btn-secondary" disabled={!hasMore} onClick={() => setPage(page + 1)}>Next</button></div>}
  </main>
}

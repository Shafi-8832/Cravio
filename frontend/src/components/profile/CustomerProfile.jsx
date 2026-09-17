import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import RestaurantCard from '../RestaurantCard'
import { StatGrid, Stat } from './ProfileIdentity'
import { getAddresses, createAddress, updateAddress, deleteAddress, getFavorites, removeFavorite } from '../../services/accountApi'
import { DIVISIONS, money, errorMessage } from '../../utils/format'

const emptyAddress = { label: 'Home', full_address: '', area: '', city: '', division: 'Dhaka', phone: '', is_default: false }

// What a diner comes to their profile for: where their food goes, what they
// have ordered, and what it has cost them. Every number below was computed
// by the database, not by counting the lists on this page.
export default function CustomerProfile({ stats, recentOrders }) {
  const [addresses, setAddresses] = useState([])
  const [favorites, setFavorites] = useState([])
  const [form, setForm] = useState(emptyAddress)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    Promise.all([getAddresses(), getFavorites()])
      .then(([a, f]) => { setAddresses(a.data.addresses); setFavorites(f.data.restaurants) })
      .catch(err => setError(errorMessage(err)))
  }, [])

  async function saveAddress(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await (editing ? updateAddress(editing, form) : createAddress(form))
      setAddresses((await getAddresses()).data.addresses)
      setForm(emptyAddress); setEditing(null); setNotice('Address saved.')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  async function removeAddress(id) {
    setError('')
    try { await deleteAddress(id); setAddresses(addresses.filter(item => item.id !== id)) }
    catch (err) { setError(errorMessage(err)) }
  }

  async function unfavorite(id) {
    try { await removeFavorite(id); setFavorites(favorites.filter(item => item.id !== id)) }
    catch (err) { setError(errorMessage(err)) }
  }

  return <>
    {error && <p className="notice-error mt-6" role="alert">{error}</p>}
    {notice && <p className="notice-success mt-6" role="status">{notice}</p>}

    <section className="mt-6">
      <h2 className="text-xl font-bold mb-4">Your ordering so far</h2>
      <StatGrid>
        <Stat label="Orders placed" value={stats.total_orders} hint={`${stats.delivered_orders} delivered`} />
        <Stat label="Total spent" value={money(stats.total_spent)} hint="Cancelled orders excluded" />
        <Stat label="Average order" value={money(stats.average_order_value)} />
        <Stat label="Saved" value={`${stats.address_count} / ${stats.favorite_count}`} hint="Addresses / favourites" />
      </StatGrid>
    </section>

    <section className="surface p-6 mt-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Recent orders</h2>
        <Link className="text-sm font-bold text-orange-700" to="/orders">See all orders →</Link>
      </div>
      {recentOrders.length ? <ul className="space-y-3">
        {recentOrders.map(order => <li key={order.id} className="flex justify-between items-center gap-4 border-b border-stone-100 pb-3">
          <div>
            <p className="font-bold">{order.restaurant_name} <span className="text-sm muted">· {order.branch_area}</span></p>
            <p className="text-xs muted mt-1">#{order.id} · {new Date(order.created_at).toLocaleString()}</p>
          </div>
          <div className="text-right">
            <p className="font-bold">{money(order.total_amount)}</p>
            {/* Opens this exact order's receipt on the orders page. */}
            <Link className="text-xs font-bold text-orange-700 capitalize" to="/orders" state={{ openOrderId: order.id }}>
              {order.status.replaceAll('_', ' ')} · view
            </Link>
          </div>
        </li>)}
      </ul> : <p className="text-sm muted">No orders yet. <Link className="font-bold text-orange-700" to="/">Find something to eat →</Link></p>}
    </section>

    <section className="surface p-6 mt-6">
      <h2 className="text-xl font-bold mb-5">📍 Saved addresses</h2>
      <div className="grid md:grid-cols-2 gap-4">
        {addresses.map(item => <article key={item.id} className="rounded-xl border border-stone-200 p-4">
          <p className="font-bold">{item.label} {item.is_default && <span className="pill bg-green-50 text-green-800">Default</span>}</p>
          <p className="text-sm mt-2">{item.full_address}</p>
          <p className="text-sm muted">{item.area}, {item.city} · {item.division}</p>
          <p className="text-sm muted">{item.phone}</p>
          <div className="flex gap-4 mt-3">
            <button className="text-sm text-orange-700" onClick={() => { setForm({ ...emptyAddress, ...item, phone: item.phone || '' }); setEditing(item.id) }}>Edit</button>
            <button className="text-sm text-red-600" onClick={() => removeAddress(item.id)}>Remove</button>
          </div>
        </article>)}
      </div>
      <form onSubmit={saveAddress} className="grid sm:grid-cols-2 gap-3 mt-6">
        <h3 className="font-bold sm:col-span-2">{editing ? 'Edit address' : 'Add an address'}</h3>
        <label className="text-sm">Label
          <select className="field mt-1" value={form.label} onChange={event => setForm({ ...form, label: event.target.value })}>
            {['Home', 'Work', 'Other'].map(item => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="text-sm">Division
          <select className="field mt-1" value={form.division} onChange={event => setForm({ ...form, division: event.target.value })}>
            {DIVISIONS.map(item => <option key={item}>{item}</option>)}
          </select>
        </label>
        {['city', 'area', 'phone'].map(field => <label key={field} className="text-sm capitalize">{field}
          <input className="field mt-1" type={field === 'phone' ? 'tel' : 'text'} required maxLength={field === 'phone' ? 20 : 100}
            value={form[field]} onChange={event => setForm({ ...form, [field]: event.target.value })} />
        </label>)}
        <label className="text-sm sm:col-span-2">Full address
          <textarea required minLength={5} maxLength={500} className="field mt-1" value={form.full_address}
            onChange={event => setForm({ ...form, full_address: event.target.value })} />
        </label>
        <label className="text-sm flex gap-2 items-center">
          <input type="checkbox" checked={form.is_default} onChange={event => setForm({ ...form, is_default: event.target.checked })} />
          Make this my default
        </label>
        <div className="flex justify-end gap-3">
          {editing && <button className="btn-secondary" type="button" onClick={() => { setEditing(null); setForm(emptyAddress) }}>Cancel</button>}
          <button disabled={busy} className="btn-primary">Save address</button>
        </div>
      </form>
    </section>

    <section className="mt-8">
      <h2 className="section-heading mb-5">Your favourites ❤️</h2>
      {favorites.length
        ? <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {favorites.map(item => <RestaurantCard key={item.id} restaurant={item} favorite onFavorite={unfavorite} />)}
        </div>
        : <p className="muted text-sm">Tap a restaurant’s heart to save it here.</p>}
    </section>
  </>
}

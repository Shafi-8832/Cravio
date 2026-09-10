import { useCallback, useEffect, useState } from 'react'
import { getAvailableDeliveries, getMyDeliveries, acceptDelivery, updateDeliveryStatus, getRiderProfile, updateRiderProfile } from '../services/riderApi'
import BusinessSummary from '../components/BusinessSummary'
import { DIVISIONS, money, errorMessage } from '../utils/format'
export default function RiderDashboardPage() {
  const [profile, setProfile] = useState(null)
  const [available, setAvailable] = useState([])
  const [mine, setMine] = useState([])
  const [tab, setTab] = useState('available')
  const [division, setDivision] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const load = useCallback(async () => {
    try { const [p, a, m] = await Promise.all([getRiderProfile(), getAvailableDeliveries({ division }), getMyDeliveries()]); setProfile(p.data.profile); setAvailable(a.data.deliveries); setMine(m.data.deliveries) }
    catch (err) { setError(errorMessage(err)) }
  }, [division])
  // The effect starts remote I/O; load updates state after the API response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); const timer = setInterval(load, 15000); return () => clearInterval(timer) }, [load])
  async function act(operation) {
    setBusy(true); setError('')
    try { await operation(); await load(); setVersion(value => value + 1) }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const shown = tab === 'available' ? available : mine.filter(item => (item.delivery_status === 'delivered') === (tab === 'history'))
  return <main className="page-shell py-9"><div className="dashboard-heading flex flex-wrap justify-between gap-5"><div><p className="eyebrow mb-2">Every delivery makes someone’s day</p><h1 className="section-heading">Let’s get moving 🚴</h1></div><div className="flex items-center gap-3"><span className="pill bg-white capitalize">{profile?.status || 'Loading…'}</span><button className="btn-primary" disabled={busy || !profile || profile.status === 'busy'} onClick={() => act(() => updateRiderProfile({ status: profile.status === 'online' ? 'offline' : 'online' }))}>{profile?.status === 'online' ? 'Go offline' : 'Go online'}</button></div></div>
    <BusinessSummary key={version} rider />
    {error && <p className="notice-error mb-5" role="alert">{error}</p>}
    <div className="flex flex-wrap gap-3 items-center mb-5">{['available', 'active', 'history'].map(value => <button key={value} onClick={() => setTab(value)} className={tab === value ? 'btn-primary capitalize' : 'btn-secondary capitalize'}>{value}</button>)}<select aria-label="Pickup division" className="field !w-auto ml-auto" value={division} onChange={event => setDivision(event.target.value)}><option value="">All pickup divisions</option>{DIVISIONS.map(value => <option key={value}>{value}</option>)}</select><button className="btn-secondary" onClick={load}>Refresh</button></div>
    {profile && <label className="text-sm flex items-center gap-3 mb-5">Your vehicle<select disabled={busy || profile.status === 'busy'} className="field !w-auto" value={profile.vehicle_type || 'bicycle'} onChange={event => act(() => updateRiderProfile({ vehicle_type: event.target.value }))}>{['bicycle', 'motorcycle', 'car'].map(value => <option key={value}>{value}</option>)}</select></label>}
    {shown.length === 0 ? <div className="surface p-12 text-center"><p className="text-5xl mb-4">🛵</p><p className="font-bold">No deliveries in this view right now.</p>
      {/* A blank list here is almost never a fault: a job only becomes
          claimable once the restaurant has accepted the order and started
          cooking. Saying so beats leaving a rider staring at an empty page
          wondering whether the app is broken. */}
      {tab === 'available' && <div className="text-sm muted mt-4 max-w-md mx-auto space-y-2">
        <p>A new order is not a job yet. It becomes one only after the restaurant confirms it and marks it <strong>preparing</strong>.</p>
        <p>So: the customer orders → the restaurant owner accepts and starts cooking → the order appears here for any online rider to claim.</p>
        {profile?.status !== 'online' && <p className="text-orange-700 font-semibold">You are {profile?.status || 'not loaded'} — go online before you can accept a delivery.</p>}
        {division && <p>You are only seeing pickups in {division}. Choose “All pickup divisions” to widen the search.</p>}
      </div>}</div> : <div className="grid md:grid-cols-2 gap-5">{shown.map(job => <article key={job.order_id} className="surface p-6"><p className="eyebrow mb-2">Order #{job.order_id}</p><h2 className="text-xl font-extrabold">{job.restaurant_name}</h2><p className="text-sm mt-3"><strong>Pickup:</strong> {job.branch_address || [job.branch_area, job.branch_city].join(', ')}</p>{job.delivery_address && <p className="text-sm mt-2"><strong>Deliver to:</strong> {job.delivery_address}</p>}{job.customer_name && <p className="text-sm mt-2">{job.customer_name} {job.customer_phone && <a className="text-orange-700 underline" href={'tel:' + job.customer_phone}>{job.customer_phone}</a>}</p>}<p className="text-sm mt-4">Order value {money(job.total_amount)} · delivery fee {money(job.delivery_fee)}</p>{job.payment_method === 'cash_on_delivery' && <p className="font-bold text-orange-700 mt-2">Cash to collect: {money(job.total_amount)}</p>}{tab === 'available' ? <button disabled={busy || profile?.status !== 'online'} className="btn-primary mt-5" onClick={() => act(async () => { await acceptDelivery(job.order_id); setTab('active') })}>🛍️ Accept delivery</button> : job.delivery_status === 'assigned' ? <button disabled={busy} className="btn-primary mt-5" onClick={() => act(() => updateDeliveryStatus(job.order_id, 'picked_up'))}>🍱 Confirm pickup</button> : job.delivery_status === 'picked_up' ? <button disabled={busy} className="btn-primary mt-5" onClick={() => act(() => updateDeliveryStatus(job.order_id, 'delivered'))}>✓ Delivered{job.payment_method === 'cash_on_delivery' ? ' & cash collected' : ''}</button> : <p className="pill bg-green-50 mt-4">Delivered · {new Date(job.delivery_time).toLocaleString()}</p>}</article>)}</div>}
  </main>
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { StatGrid, Stat } from './ProfileIdentity'
import { updateRiderProfile } from '../../services/riderApi'
import { money, errorMessage } from '../../utils/format'

const VEHICLES = ['bicycle', 'motorcycle', 'car']

// A rider's profile is mostly about being reachable for work: am I online,
// what am I riding, and how have I been doing. The completed count and the
// average time are both computed by the database over this rider's own
// deliveries — the token's id is the only thing that selects them.
export default function RiderProfile({ riderProfile, stats, recentDeliveries }) {
  const [profile, setProfile] = useState(riderProfile)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  // 'busy' is set by the delivery transactions, never by this toggle, so a
  // rider mid-delivery is refused by the server with a 409 rather than being
  // allowed to vanish halfway through a job.
  async function save(changes) {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await updateRiderProfile(changes)
      setProfile(response.data.profile)
      setNotice('Saved.')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  const status = profile?.status || 'offline'

  return <>
    {error && <p className="notice-error mt-6" role="alert">{error}</p>}
    {notice && <p className="notice-success mt-6" role="status">{notice}</p>}

    <section className="surface p-6 mt-6">
      <div className="flex justify-between items-center gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold">Availability</h2>
          <p className="text-sm muted mt-1">You are currently <span className="font-bold capitalize">{status}</span>.</p>
        </div>
        <button className="btn-primary" disabled={busy || status === 'busy'}
          onClick={() => save({ status: status === 'online' ? 'offline' : 'online' })}>
          {status === 'online' ? 'Go offline' : 'Go online'}
        </button>
      </div>
      {status === 'busy' && <p className="text-sm muted mt-3">Finish your current delivery before changing availability.</p>}
      <label className="text-sm block mt-5 max-w-xs">Vehicle
        <select className="field mt-1" value={profile?.vehicle_type || ''} disabled={busy}
          onChange={event => save({ vehicle_type: event.target.value })}>
          <option value="" disabled>Choose a vehicle</option>
          {VEHICLES.map(item => <option key={item} value={item} className="capitalize">{item}</option>)}
        </select>
      </label>
    </section>

    <section className="mt-6">
      <h2 className="text-xl font-bold mb-4">Your delivery record</h2>
      <StatGrid>
        <Stat label="Completed" value={stats.deliveries_completed} hint={`${stats.deliveries_assigned} accepted in total`} />
        <Stat label="Average time" value={stats.average_delivery_minutes == null ? '—' : `${stats.average_delivery_minutes} min`} hint="Order placed → delivered" />
        <Stat label="Delivery fees" value={money(stats.delivery_fees_earned)} hint="On completed trips" />
        <Stat label="In progress" value={stats.deliveries_assigned - stats.deliveries_completed} />
      </StatGrid>
    </section>

    <section className="surface p-6 mt-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold">Recent deliveries</h2>
        <Link className="text-sm font-bold text-orange-700" to="/rider">Go to deliveries →</Link>
      </div>
      {recentDeliveries.length ? <ul className="space-y-3">
        {recentDeliveries.map(item => <li key={item.order_id} className="flex justify-between items-center gap-4 border-b border-stone-100 pb-3">
          <div>
            <p className="font-bold">{item.restaurant_name}</p>
            <p className="text-xs muted mt-1">#{item.order_id} · {new Date(item.created_at).toLocaleString()}</p>
          </div>
          <div className="text-right">
            <p className="font-bold">{money(item.delivery_fee)}</p>
            <span className="pill bg-green-50 text-green-900 capitalize">{item.delivery_status.replaceAll('_', ' ')}</span>
          </div>
        </li>)}
      </ul> : <p className="text-sm muted">No deliveries yet. <Link className="font-bold text-orange-700" to="/rider">Find one to accept →</Link></p>}
    </section>
  </>
}
